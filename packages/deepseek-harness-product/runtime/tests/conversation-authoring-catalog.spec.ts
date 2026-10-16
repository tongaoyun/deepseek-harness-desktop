import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Authoring from '../src/conversation-authoring.ts'

async function fixture() {
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(Agents)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  const entries = Array.from({ length: 129 }, (_, index) => ({
    id: `resource-${String(index).padStart(3, '0')}`, name: `Resource ${index}`, summary: `Summary ${index}`,
    version: '1.0.0', sha256: 'a'.repeat(64), referenceKey: `company:reference-${index}`,
    ownerName: index === 128 ? 'Research department' : 'Other department',
    headers: { Authorization: 'private-header-secret' }, environment: { TOKEN: 'private-env-secret' },
    url: 'https://private.example', command: 'private-command',
    tools: [{ name: `orders.get${index}`, description: `Read order ${index}`, displayName: `Order ${index}`, access: 'READ', secret: 'private-tool-secret' }],
  }))
  const invoke = vi.fn(async (method: string) => method.endsWith('.list') ? [...entries].reverse() : {
    authoringId: '00000000-0000-4000-8000-000000000001', sessionId: 'creation', revision: 0,
    draft: { kind: 'skill', id: 'review-skill', version: '1.0.0' }, files: [], missingFields: ['name', 'body'],
  })
  ctx.loader.builtins['authoring-catalog-fixture'] = { name: 'authoring-catalog-fixture', inject: Authoring.inject,
    apply(owner: Context) { Authoring.apply(owner, { product: { invoke } }) } }
  await ctx.loader.root.update([{ id: 'authoring', name: 'cordis:authoring-catalog-fixture' }])
  await ctx.loader.await()
  await ctx.loader.resolve('authoring').fiber?.await()
  const handle = await ctx.agents.create({ sessionId: SessionId('creation') })
  onTestFinished(() => handle.dispose())
  const execute = (args: Record<string, unknown>, signal = new AbortController().signal) => ctx.tools.execute({
    agent: handle.agent, name: 'extension_catalog', arguments: args, callId: ToolCallId('catalog'), signal,
  })
  const read = async (args: Record<string, unknown>) => {
    const result = await execute(args)
    expect(result.isError).not.toBe(true)
    const text = result.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('Catalog returned no text')
    return JSON.parse(text.text) as { entries: Record<string, unknown>[]; page: number; size: number; total: number; hasMore: boolean }
  }
  return { ctx, handle, entries, invoke, execute, read }
}

it.each(['skills', 'connectors', 'knowledge'])('pages every %s dependency beyond item 128 in stable ID order', async (kind) => {
  const f = await fixture()
  const first = await f.read({ kind })
  expect(first).toMatchObject({ page: 1, size: 20, total: 129, hasMore: true })
  expect(first.entries.map(row => row.id)).toEqual(f.entries.slice(0, 20).map(row => row.id))
  const last = await f.read({ kind, page: 7 })
  expect(last).toMatchObject({ page: 7, size: 20, total: 129, hasMore: false })
  expect(last.entries.map(row => row.id)).toEqual(f.entries.slice(120).map(row => row.id))
  expect(await f.read({ kind, page: 8 })).toEqual({ entries: [], page: 8, size: 20, total: 129, hasMore: false })
  expect((await f.read({ kind, page: 2, size: 100 })).entries).toHaveLength(29)
})

it.each([
  ['skills', ' RESOURCE-128 '], ['skills', 'Summary 128'], ['knowledge', 'company:reference-128'],
  ['knowledge', 'Research department'], ['connectors', 'orders.get128'], ['connectors', 'Read order 128'],
])('searches %s by public identifiers and descriptions using %s', async (kind, query) => {
  const f = await fixture()
  const result = await f.read({ kind, query })
  expect(result.entries.map(row => row.id)).toContain('resource-128')
  expect(await f.read({ kind, query: 'missing-resource' })).toEqual({ entries: [], page: 1, size: 20, total: 0, hasMore: false })
})

it('returns real connector tool names without private configuration', async () => {
  const f = await fixture()
  const result = await f.read({ kind: 'connectors', query: 'resource-128' })
  expect(result.entries[0]).toMatchObject({ toolNames: ['orders.get128'],
    tools: [{ name: 'orders.get128', description: 'Read order 128', displayName: 'Order 128', access: 'READ' }] })
  const visible = JSON.stringify({ result, events: f.handle.agent.session.snapshotEvents() })
  for (const secret of ['private-header-secret', 'private-env-secret', 'private.example', 'private-command', 'private-tool-secret']) {
    expect(visible).not.toContain(secret)
  }
  expect((await f.read({ kind: 'connectors', query: 'private-header-secret' })).total).toBe(0)
})

it.each([{ page: 0 }, { page: 1.5 }, { size: 0 }, { size: 101 }, { query: 'x'.repeat(201) },
  { page: Number.MAX_SAFE_INTEGER, size: 100 }])('rejects invalid pagination before remote discovery: %j', async (args) => {
  const f = await fixture()
  f.invoke.mockClear()
  expect((await f.execute({ kind: 'skills', ...args })).isError).toBe(true)
  expect(f.invoke).not.toHaveBeenCalled()
})

it('cancels catalog discovery with its caller', async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort(new Error('Cancelled catalog lookup'))
  f.invoke.mockClear()
  expect((await f.execute({ kind: 'skills' }, controller.signal)).isError).toBe(true)
  expect(f.invoke).not.toHaveBeenCalled()
})
