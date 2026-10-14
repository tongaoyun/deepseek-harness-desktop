import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Skills from '@deepseek-ai/dsh-skill'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Llm, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { expect, it, onTestFinished } from 'vitest'
import { createInstalledSkills } from '../src/installed-skills.ts'
import type { SkillContent } from '../src/content.ts'
import type { DeepSeekHarnessConnector } from '../src/deepseek-harness-connector-contract.ts'
import { ProductError } from '@deepseek-harness/product/errors'

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('load-review'), name: 'skill', arguments: '{"name":"review-skill"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Review complete.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('discovers installed skills in an unchanged mode, pins versions, restores, denies revoked permission, and unloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-skills-'))
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Loader)
  await ctx.plugin(Skills)
  await ctx.plugin(Tools)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
  await ctx.plugin(Agents)
  await ctx.plugin(Llm)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Presets, { default: 'minimal' })
  ctx.loader.builtins['official-skill-tool'] = ToolSkill
  await ctx.agentPresets.register({ id: 'minimal', plugins: [{ id: 'skill-loader', name: 'cordis:official-skill-tool' }] })
  let employee = 'employee-one'
  let revoked = false
  let permissionFailure: Error | undefined
  let damaged = false
  let version = '1'
  let selected = false
  let connectorRevoked = false
  let knowledgeCatalog = [{ id: 'manuals', referenceKey: 'company:manuals' }]
  let selectedKnowledgeIds = ['manuals']
  let selectedKnowledgeRefs: string[] = []
  const connector: DeepSeekHarnessConnector = { id: 'erp', name: 'Orders', status: 'ready', authMode: 'oauth',
    timeoutSeconds: 120,
    transport: 'streamable-http', url: 'http://localhost/mcp', arguments: [], environment: {}, headers: { Authorization: 'private-relay-token' },
    toolNames: ['orders'], readOnlyTools: ['orders'] }
  const skill = (id: string): SkillContent => ({ id, name: id, version, summary: 'Review the report.',
    sha256: (version === '1' ? 'a' : 'b').repeat(64), connectorRefs: ['dependent-skill', 'connector-tool-skill'].includes(id) ? ['erp'] : [],
    knowledgeBaseRefs: id === 'knowledge-skill' ? ['company:manuals'] : [],
    requiredTools: id === 'tool-dependent' ? ['missing-tool'] : id === 'connector-tool-skill' ? ['orders'] : [] })
  let controls: ReturnType<typeof createInstalledSkills> | undefined
  ctx.loader.builtins['installed-product'] = {
    inject: ['skills', 'tools', 'agents', 'systemPrompt', 'sessionProjections'],
    apply(owner: Context) {
      controls = createInstalledSkills(owner, {
        root, product: { invoke: async (method, payload) => {
          if (method === 'auth.getSession') return { authenticated: true, employeeId: employee }
          if (method === 'skills.get' && permissionFailure !== undefined) throw permissionFailure
          if (method === 'skills.get' && revoked) throw new ProductError('EXPERT_KIT_NOT_FOUND', 'permission revoked')
          if (method === 'connectors.list') return [{ id: 'erp', status: connectorRevoked ? 'unavailable' : 'ready' }]
          if (method === 'knowledge.bases.list') return knowledgeCatalog
          return skill((payload as { id: string }).id)
        } },
        parse: value => value as SkillContent[], install: async () => {},
        load: async (entry) => {
          if (damaged) throw new Error('installed content damaged')
          return { name: entry.id, description: entry.summary, provider: 'fixture', source: 'user',
            invocation: { modelInvocable: true, userInvocable: true }, content: `Use version ${entry.version} instructions.` }
        },
        capabilities: async () => ({ skills: [], connectorIds: selected ? ['erp'] : [], requiredConnectorIds: [],
          knowledgeBaseIds: selected ? selectedKnowledgeIds : [], requiredKnowledgeBaseIds: [], knowledgeBaseRefs: selectedKnowledgeRefs }),
        connectors: async () => connectorRevoked ? [] : [connector],
        mountConnectors: async () => async () => {},
      })
    },
  }
  const rows = [{ id: 'installed-product', name: 'cordis:installed-product' }]
  await ctx.loader.root.update(structuredClone(rows))
  await ctx.loader.await()
  await ctx.loader.resolve('installed-product').fiber?.await()
  await controls!.install('review-skill')
  await controls!.install('dependent-skill')
  await controls!.install('knowledge-skill')
  await controls!.install('tool-dependent')
  const create = async (id: string, seed?: Parameters<typeof ctx.agents.create>[0]['seed']) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), ...seed === undefined ? {} : { seed },
      agentOptions: { provider: 'fixture', model: 'fixture' }, setup: scope => ctx.agentPresets.mount(scope, 'minimal').then(() => undefined) })
    onTestFinished(() => handle.dispose())
    return handle
  }
  const handle = await create('automatic')
  expect((await ctx.skills.list({ scope: handle.agent })).map(row => row.name)).toEqual(['dependent-skill', 'review-skill'])
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const interrupted = await create('interrupted')
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  for (const error of [new ProductError('REMOTE_UNAVAILABLE', 'permission service offline', true),
    new ProductError('EMPLOYEE_FORBIDDEN', 'employee identity mismatch'), new Error('invalid permission response')]) {
    permissionFailure = error
    interrupted.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review this report.' }], source: { kind: 'user' } }))
    await expect.poll(() => errors.at(-1)).toBe(error)
    await expect.poll(() => interrupted.agent.status).toBe('idle')
    expect(adapter.requests).toEqual([])
    expect(await readdir(root)).not.toContain(`session-${createHash('sha256').update('interrupted').digest('hex')}.json`)
  }
  permissionFailure = undefined
  damaged = true
  interrupted.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review this report.' }], source: { kind: 'user' } }))
  await expect.poll(() => errors.at(-1)).toMatchObject({ message: 'installed content damaged' })
  await expect.poll(() => interrupted.agent.status).toBe('idle')
  expect(adapter.requests).toEqual([])
  expect(await readdir(root)).not.toContain(`session-${createHash('sha256').update('interrupted').digest('hex')}.json`)
  damaged = false
  interrupted.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review this report.' }], source: { kind: 'user' } }))
  await expect.poll(() => adapter.requests.length).toBe(2)
  await expect.poll(() => interrupted.agent.status).toBe('idle')
  expect(JSON.stringify(interrupted.agent.session.snapshotEvents())).toContain('Use version 1 instructions.')
  adapter.requests.splice(0)
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review this report.' }], source: { kind: 'user' } }))
  await expect.poll(() => handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true)
  const events = handle.agent.session.snapshotEvents()
  expect(events.some(event => event.type === 'working-directory/change' && event.data.cwd === root)).toBe(true)
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Current working directory:')
  expect(JSON.stringify(events)).toContain('Use version 1 instructions.')
  expect(JSON.stringify(events)).toContain('product-installed-skills')
  expect(JSON.stringify(events)).toContain('product.invalid/erp')
  expect(JSON.stringify(events)).not.toContain('private-relay-token')
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('skill')
  expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
  expect((await ctx.agentPresets.list()).map(preset => preset.id)).toEqual(['minimal'])
  version = '2'
  await controls!.install('review-skill')
  expect((await ctx.skills.get('review-skill', { scope: handle.agent }))?.content).toBe('Use version 1 instructions.')
  const fresh = await create('fresh')
  expect((await ctx.skills.get('review-skill', { scope: fresh.agent }))?.content).toBe('Use version 2 instructions.')
  expect(await controls!.uninstall('review-skill')).toEqual({ id: 'review-skill' })
  expect((await controls!.read()).installed.map(entry => entry.id)).not.toContain('review-skill')
  expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).not.toContain('review-skill')
  await expect(ctx.skills.get('review-skill', { scope: fresh.agent })).resolves.toBeUndefined()
  expect((await ctx.skills.get('review-skill', { scope: handle.agent }))?.content).toBe('Use version 1 instructions.')
  const withoutReview = await create('without-review')
  expect((await ctx.skills.list({ scope: withoutReview.agent })).map(row => row.name)).not.toContain('review-skill')
  await controls!.install('review-skill')
  expect((await ctx.skills.get('review-skill', { scope: fresh.agent }))?.content).toBe('Use version 2 instructions.')
  selected = true
  ctx.emit('agent-preset/selected', fresh.agent.session.id, 'minimal')
  expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).toContain('dependent-skill')
  expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).toContain('knowledge-skill')
  knowledgeCatalog = [{ id: 'manuals', referenceKey: 'company:manuals' }, { id: 'other-manuals', referenceKey: 'company:manuals' }]
  for (const catalog of [knowledgeCatalog, [...knowledgeCatalog].reverse()]) {
    knowledgeCatalog = catalog
    ctx.emit('agent-preset/selected', fresh.agent.session.id, 'minimal')
    expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).toContain('knowledge-skill')
  }
  selectedKnowledgeIds = ['manuals', 'other-manuals']
  ctx.emit('agent-preset/selected', fresh.agent.session.id, 'minimal')
  expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).not.toContain('knowledge-skill')
  selectedKnowledgeIds = []
  selectedKnowledgeRefs = ['company:manuals']
  ctx.emit('agent-preset/selected', fresh.agent.session.id, 'minimal')
  expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).not.toContain('knowledge-skill')
  selectedKnowledgeIds = ['manuals']
  selectedKnowledgeRefs = []
  knowledgeCatalog = [{ id: 'manuals', referenceKey: 'company:manuals' }, { id: 'manuals', referenceKey: 'company:manuals' }]
  ctx.emit('agent-preset/selected', fresh.agent.session.id, 'minimal')
  expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).toContain('knowledge-skill')
  expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).not.toContain('tool-dependent')
  connectorRevoked = true
  expect(await ctx.skills.get('dependent-skill', { scope: fresh.agent }).catch(() => undefined)).toBeUndefined()
  connectorRevoked = false
  await controls!.install('connector-tool-skill')
  expect((await ctx.skills.list({ scope: fresh.agent })).map(row => row.name)).toContain('connector-tool-skill')
  const explicit = await create('explicit')
  const requestsBefore = adapter.requests.length
  explicit.agent.followup(createUserMessage({ content: [{ type: 'text', text: '/review-skill Review this report.' }], source: { kind: 'user' } }))
  await expect.poll(() => explicit.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true)
  expect(JSON.stringify(explicit.agent.session.snapshotEvents())).toContain('Use version 2 instructions.')
  expect(adapter.requests.length).toBeGreaterThan(requestsBefore)
  expect(explicit.agent.session.snapshotEvents().some(event => event.type === 'tool/call')).toBe(false)
  await expect(ctx.skills.get('connector-tool-skill', { scope: explicit.agent })).resolves.toBeUndefined()
  await controls!.uninstall('review-skill')
  expect((await ctx.skills.get('review-skill', { scope: explicit.agent }))?.content).toBe('Use version 2 instructions.')
  await handle.dispose()
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(await ctx.skills.list({ scope: fresh.agent })).toEqual([])
  await ctx.loader.root.update(structuredClone(rows))
  await ctx.loader.await()
  await ctx.loader.resolve('installed-product').fiber?.await()
  const restored = await create('automatic', events)
  expect((await controls!.read('automatic')).installed.map(entry => entry.id)).not.toContain('review-skill')
  expect((await controls!.read('automatic')).available.map(entry => entry.id)).toContain('review-skill')
  expect((await ctx.skills.get('review-skill', { scope: restored.agent }))?.content).toBe('Use version 1 instructions.')
  revoked = true
  expect((await controls!.read('automatic')).available).toEqual([])
  await expect(ctx.skills.get('review-skill', { scope: restored.agent })).rejects.toThrow('permission revoked')
  revoked = false
  employee = 'employee-two'
  await expect(controls!.read('automatic')).rejects.toThrow('another employee')
  expect((await controls!.read()).installed).toEqual([])
  employee = 'employee-one'
  await restored.dispose()
  await ctx.loader.root.update([])
  await ctx.loader.await()
  await rm(join(root, `session-${createHash('sha256').update('automatic').digest('hex')}.json`))
  await ctx.loader.root.update(structuredClone(rows))
  await ctx.loader.await()
  await ctx.loader.resolve('installed-product').fiber?.await()
  await create('automatic', events)
  await expect(controls!.read('automatic')).rejects.toMatchObject({ code: 'SKILL_SNAPSHOT_MISSING', retryable: false })
  const replacement = await create('replacement')
  await expect(ctx.skills.get('review-skill', { scope: replacement.agent })).resolves.toBeUndefined()
  await controls!.install('review-skill')
  expect((await ctx.skills.get('review-skill', { scope: replacement.agent }))?.content).toBe('Use version 2 instructions.')
})
