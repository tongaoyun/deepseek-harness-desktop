import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ExtensionAuthoringSnapshotSchema } from '@deepseek-harness/product/extension-draft'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Authoring from '../src/conversation-authoring.ts'

const draft = { kind: 'skill' as const, id: 'fact-review', version: '1.0.0', name: 'Fact review', summary: 'Check claims.',
  category: 'knowledge-research', body: '# Review\n\nCheck each claim against evidence.', triggers: ['Review claims'] }

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const calls = [{ name: 'extension_draft', arguments: '{}' }, { name: 'extension_catalog', arguments: '{"kind":"connectors"}' },
      { name: 'extension_draft_update', arguments: JSON.stringify({ revision: 0, content: JSON.stringify(draft) }) },
      { name: 'extension_save', arguments: '{"revision":1}' }]
    const call = calls[this.requests.length - 1]
    if (call) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`authoring-${this.requests.length}`), ...call } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Skill saved to your directory and installed.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('runs scoped creation through Loader and the official loop, records its draft, restores it and removes tools on unload', async () => {
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(Agents)
  await ctx.plugin(AgentLoop, { agents: [] })
  let state = ExtensionAuthoringSnapshotSchema.parse({ authoringId: '00000000-0000-4000-8000-000000000001',
    sessionId: 'creation', revision: 0, draft: { kind: 'skill', id: draft.id, version: draft.version },
    files: [{ path: 'assets/example.txt', bytes: 5 }], missingFields: ['name', 'body'] })
  const invoke = vi.fn(async (method: string, input?: unknown, _signal?: AbortSignal) => {
    const payload = input as Record<string, unknown> | undefined
    if (method === 'connectors.list') return [{ id: 'company-erp', name: 'ERP', headers: { Authorization: 'private-relay' }, url: 'https://private.example' }]
    if (payload?.sessionId !== 'creation') return null
    if (method === 'extensions.authoring.read') return structuredClone(state)
    if (method === 'extensions.authoring.update') {
      expect(payload.revision).toBe(state.revision)
      state = ExtensionAuthoringSnapshotSchema.parse({ ...state, draft: payload.draft, revision: state.revision + 1, missingFields: [] })
      return structuredClone(state)
    }
    if (method === 'extensions.authoring.save') {
      expect(payload.revision).toBe(state.revision)
      state = ExtensionAuthoringSnapshotSchema.parse({ ...state, revision: state.revision + 1,
        saved: { id: draft.id, version: draft.version } })
      return { kind: 'skill', id: draft.id, version: draft.version, visibility: 'PERSONAL', installed: true }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  ctx.loader.builtins['authoring-fixture'] = { name: 'authoring-fixture', inject: Authoring.inject,
    apply: (owner: Context) =>{  Authoring.apply(owner, { product: { invoke } }) } }
  const profile = [{ id: 'authoring', name: 'cordis:authoring-fixture' }]
  await ctx.loader.root.update(structuredClone(profile))
  await ctx.loader.await()
  await ctx.loader.resolve('authoring').fiber?.await()
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const normal = await ctx.agents.create({ sessionId: SessionId('normal') })
  onTestFinished(() => normal.dispose())
  expect(ctx.tools.schemas(normal.agent)).toEqual([])
  const handle = await ctx.agents.create({ sessionId: SessionId('creation'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  const tools = ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()
  expect(tools).toEqual(['extension_catalog', 'extension_draft', 'extension_draft_update', 'extension_save'])
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Create a fact review skill.' }], source: { kind: 'user' } }))
  await vi.waitFor(() =>{  expect(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) })
  const events = handle.agent.session.snapshotEvents()
  const recording = {
    system: events.filter(event => event.type === 'system/message').map(event => event.data.message.content),
    tools: adapter.requests[0]?.tools,
    generated: state.draft,
    results: events.filter(event => event.type === 'tool/result').map(event => event.data.message.content),
  }
  expect(JSON.stringify(recording)).not.toContain('private-relay')
  expect(JSON.stringify(recording)).not.toContain('private.example')
  expect(state.revision).toBe(2)
  expect(state.saved).toEqual({ id: draft.id, version: draft.version })
  expect(invoke.mock.calls.map(call => call[0])).toContain('extensions.authoring.save')
  await expect(JSON.stringify(recording, null, 2) + '\n').toMatchFileSnapshot('expected/conversation-authoring.json')
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(ctx.tools.schemas(handle.agent)).toEqual([])
  await handle.dispose()
  await ctx.loader.root.update(structuredClone(profile))
  await ctx.loader.await()
  await ctx.loader.resolve('authoring').fiber?.await()
  const restored = await ctx.agents.create({ sessionId: SessionId('creation'), seed: events })
  onTestFinished(() => restored.dispose())
  expect(ctx.tools.schemas(restored.agent).map(tool => tool.name).sort()).toEqual(tools)
  const read = await ctx.tools.execute({ agent: restored.agent, name: 'extension_draft', arguments: {},
    callId: ToolCallId('read-restored'), signal: new AbortController().signal })
  expect(JSON.stringify(read)).toContain('Check each claim against evidence.')
  expect(JSON.stringify(read)).toContain('revision')
  let settleRequest: (() => void) | undefined
  let requestSignal: AbortSignal | undefined
  invoke.mockImplementationOnce(async (_method, _input, signal) => {
    requestSignal = signal
    await new Promise<void>((resolve) => { settleRequest = resolve })
    signal?.throwIfAborted()
    return state
  })
  const pendingRead = ctx.tools.execute({ agent: restored.agent, name: 'extension_draft', arguments: {},
    callId: ToolCallId('read-cancelled'), signal: new AbortController().signal })
  onTestFinished(() => { settleRequest?.() })
  await vi.waitFor(() =>{  expect(settleRequest).toBeDefined() })
  let disposed = false
  const authoringFiber = ctx.loader.resolve('authoring').fiber
  const unloading = authoringFiber?.dispose().then(() => { disposed = true })
  await vi.waitFor(() =>{  expect(requestSignal?.aborted).toBe(true) })
  expect(disposed).toBe(false)
  settleRequest?.()
  await pendingRead
  await unloading
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(ctx.tools.schemas(restored.agent)).toEqual([])
})
