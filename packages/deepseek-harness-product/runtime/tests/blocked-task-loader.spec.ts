import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Llm, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { expect, it, onTestFinished } from 'vitest'
import * as CapabilityPrompt from '../src/capability-prompt.ts'

it('retains a blocked generation for its existing Agent after the same task identity is prepared successfully', async () => {
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(Agents)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(Llm)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Presets, { default: 'task' })
  ctx.loader.builtins['capabilities'] = CapabilityPrompt
  let unregister: (() => Promise<void>) | undefined
  ctx.loader.builtins['blocked-fixture'] = {
    inject: ['agentPresets'],
    async apply(owner: Context) {
      unregister = await owner.agentPresets.register({ id: 'task', selectable: false, defaultable: false,
        plugins: [{ id: 'blocked', name: 'cordis:capabilities', config: { failure: {
          code: 'PRODUCT_OPERATION_FAILED', message: 'Task restore unavailable', retryable: true, resources: [],
        } } }] })
      owner.effect(() => async () => { await unregister?.() }, 'fixture.task')
    },
  }
  await ctx.loader.root.update([{ id: 'blocked-fixture', name: 'cordis:blocked-fixture' }])
  await ctx.loader.await()
  await ctx.loader.resolve('blocked-fixture').fiber?.await()
  const create = async (id: string) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'task').then(() => undefined) })
    onTestFinished(() => handle.dispose())
    return handle.agent
  }
  const old = await create('blocked-history')
  await unregister!()
  unregister = await ctx.agentPresets.register({ id: 'task', selectable: false, defaultable: false,
    plugins: [{ id: 'restored', name: 'cordis:capabilities', config: { capabilities: {
      knowledgeBaseIds: ['pinned'],
    } } }] })
  const fresh = await create('replacement')
  class Adapter extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    override async resolveModel(provider: string, id: string) { return { provider, id, name: id } }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(request)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  old.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
  await expect.poll(() => errors.length).toBe(1)
  expect(errors[0]).toMatchObject({ code: 'PRODUCT_OPERATION_FAILED', retryable: true })
  expect(adapter.requests).toEqual([])
  fresh.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
  await expect.poll(() => adapter.requests.length).toBe(1)
  await expect.poll(() => fresh.status).toBe('idle')
  expect(JSON.stringify(fresh.session.snapshotEvents())).toContain('Task capability snapshot:')
  expect(JSON.stringify(fresh.session.snapshotEvents())).toContain('pinned')
  expect(old.session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
})
