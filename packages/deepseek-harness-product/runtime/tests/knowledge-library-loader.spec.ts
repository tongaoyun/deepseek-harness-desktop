import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Library from '../src/knowledge-library.ts'

const savedContent = '# Review outcome\n\nThe policy is approved for internal testing.'

async function executeTool(ctx: Context, agent: Parameters<Context['tools']['execute']>[0]['agent'], name: string,
  args: Record<string, unknown>, callId: ToolCallId, signal = new AbortController().signal) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', name, id: callId, arguments: JSON.stringify(args) }], ...agent === undefined ? {} : { agent }, signal })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`Executor omitted result for ${name}`)
  return result
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const calls = [{ name: 'knowledge_destinations', arguments: '{}' },
      { name: 'knowledge_save', arguments: JSON.stringify({ knowledgeBaseId: 'personal', title: 'Review outcome', content: savedContent }) }]
    const call = calls[this.requests.length - 1]
    yield { type: 'block-start', index: 0, blockType: call ? 'tool-call' : 'text' }
    yield { type: 'block-end', index: 0, block: call
      ? { type: 'tool-call', id: ToolCallId(`knowledge-${this.requests.length}`), ...call }
      : { type: 'text', text: 'The requested save has been processed.' } }
    yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } }
  }
}

async function fixture(outcome: ApprovalOutcome) {
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(Agents)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  ctx.on('approval/request', () => Promise.resolve(outcome))
  const invoke = vi.fn(async (method: string, _payload?: unknown, _signal?: AbortSignal): Promise<unknown> => {
    if (method === 'knowledge.bases.list') return [
      { id: 'personal', name: 'Personal notes', scope: 'PERSONAL', ownerName: 'Employee', canManage: true,
        apiKey: 'private-weknora-key', path: '/private/file' },
      { id: 'read-only', name: 'Company policy', scope: 'COMPANY', canRead: true, canManage: false },
    ]
    if (method === 'knowledge.documents.save') return { id: 'document', title: 'Review outcome', status: 'PENDING' }
    throw new Error(`Unexpected method ${method}`)
  })
  ctx.loader.builtins['knowledge-library-fixture'] = { name: 'knowledge-library-fixture', inject: Library.inject,
    apply: (owner: Context) => { Library.apply(owner, { product: { invoke } }) } }
  await ctx.loader.root.update([{ id: 'knowledge-library', name: 'cordis:knowledge-library-fixture' }])
  await ctx.loader.await()
  await ctx.loader.resolve('knowledge-library').fiber?.await()
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('save-result'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  onTestFinished(() => handle.dispose())
  return { ctx, invoke, adapter, handle }
}

it('saves an explicit result through Loader, the official loop and approval with credential-free replayable content', async () => {
  const { ctx, invoke, adapter, handle } = await fixture('allowed-once')
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()).toEqual(['knowledge_destinations', 'knowledge_save'])
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Save the review outcome to my personal knowledge base.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) })
  const calls = invoke.mock.calls.filter(call => call[0] === 'knowledge.documents.save')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.[1]).toEqual({ knowledgeBaseId: 'personal', title: 'Review outcome', content: savedContent,
    operationId: createHash('sha256').update('save-result:knowledge-2').digest('hex') })
  const events = handle.agent.session.snapshotEvents()
  const recording = { tools: adapter.requests[0]?.tools,
    savedRequest: calls[0]?.[1],
    approvals: events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome),
    results: events.filter(event => event.type === 'tool/result').map(event => event.data.message.content) }
  expect(JSON.stringify(recording)).not.toContain('private-weknora-key')
  expect(JSON.stringify(recording)).not.toContain('/private/file')
  expect(JSON.stringify(recording)).not.toContain('Company policy')
  const requestContent = adapter.requests.flatMap(request => request.messages.flatMap(message => message.content))
    .filter(block => block.type === 'tool-call').map((block): unknown => JSON.parse(block.arguments))
  expect(requestContent).toContainEqual({ knowledgeBaseId: 'personal', title: 'Review outcome', content: savedContent })
  await expect(JSON.stringify(recording, null, 2) + '\n').toMatchFileSnapshot('expected/knowledge-save.json')
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(ctx.tools.schemas(handle.agent)).toEqual([])
})

it('does not write when the official approval is rejected', async () => {
  const { invoke, handle } = await fixture('rejected')
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Save the result to my knowledge base.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) })
  expect(invoke.mock.calls.map(call => call[0])).not.toContain('knowledge.documents.save')
  expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toContain('rejected')
})

it('searches and pages all writable destinations beyond the previous 128-entry limit', async () => {
  const { ctx, invoke, handle } = await fixture('allowed-once')
  invoke.mockImplementation(async () => [
    ...Array.from({ length: 129 }, (_, index) => ({ id: `base-${String(index).padStart(3, '0')}`,
      name: `Destination ${index}`, scope: 'PERSONAL', canManage: true, ownerName: 'Employee', apiKey: 'private-key' })),
    { id: 'read-only', name: 'Destination 128', scope: 'COMPANY', canManage: false },
  ].reverse())
  const execute = async (args: Record<string, unknown>) => executeTool(ctx, handle.agent, 'knowledge_destinations', args, ToolCallId('page'))
  const second = await execute({ page: 2, size: 100 })
  const output = second.content.filter(block => block.type === 'text').map(block => block.text).join('')
  expect(output).toContain('base-128')
  expect(output).toContain('"total":129')
  expect(output).toContain('"hasMore":false')
  expect(output).not.toContain('base-099')
  expect(output).not.toContain('private-key')
  const searched = await execute({ query: 'DESTINATION 128' })
  const result = searched.content.filter(block => block.type === 'text').map(block => block.text).join('')
  expect(result).toContain('base-128')
  expect(result).toContain('"total":1')
  expect(result).not.toContain('read-only')
  const invalid = await execute({ page: 0, size: 101 })
  expect(invalid.isError).toBe(true)
})

it('cancels and awaits in-flight destination requests during plugin unload', async () => {
  const { ctx, invoke, handle } = await fixture('allowed-once')
  let settle: (() => void) | undefined
  let signal: AbortSignal | undefined
  invoke.mockImplementationOnce(async (_method, _payload, requestSignal) => {
    signal = requestSignal
    await new Promise<void>((resolve) => { settle = resolve })
    signal?.throwIfAborted()
    return []
  })
  const controller = new AbortController()
  const request = executeTool(ctx, handle.agent, 'knowledge_destinations', {}, ToolCallId('pending'), controller.signal)
  onTestFinished(() => settle?.())
  await vi.waitFor(() => { expect(settle).toBeDefined() })
  let disposed = false
  const unload = ctx.loader.resolve('knowledge-library').fiber?.dispose().then(() => { disposed = true })
  await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
  expect(disposed).toBe(false)
  settle?.()
  await request
  await unload
  expect(ctx.tools.schemas(handle.agent)).toEqual([])
})
