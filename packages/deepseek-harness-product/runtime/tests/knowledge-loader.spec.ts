import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProductData } from '../src/data.ts'

it('loads knowledge in a selected scope, records replayable inputs, and releases the tool', async () => {
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
  await ctx.plugin(Presets, { default: 'standard' })
  const hit = { sourceId: 'source', knowledgeBaseId: 'selected', knowledgeBaseName: 'Selected', documentId: 'document',
    filename: 'Policy.md', locator: 'section-1', content: 'Recorded enterprise evidence.', score: 0.9 }
  const invoke = vi.fn(async (method: string, _payload?: unknown, _signal?: AbortSignal) => method === 'knowledge.sources.read' ? hit : [hit])
  new ProductData(ctx, { invoke })
  const release = await ctx.agentPresets.register({ id: 'selected', plugins: [{ id: 'knowledge', name: new URL('../src/knowledge.ts', import.meta.url).href,
    config: { knowledgeBaseIds: ['selected'] } }] })
  onTestFinished(release)
  const handle = await ctx.agents.create({ sessionId: SessionId('knowledge-fixture'), setup: child => ctx.agentPresets.mount(child, 'selected').then(() => undefined) })
  const agent = handle.agent
  expect(ctx.tools.schemas()).toEqual([])
  const schema = ctx.tools.schemas(agent)[0]!
  expect(Object.keys(schema.parameters.properties ?? {})).toEqual(['query', 'limit'])
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('knowledge-fixture'),
    agent, name: 'knowledge_search', arguments: { query: ' policy ', limit: 2 } })
  expect(invoke).toHaveBeenCalledWith('knowledge.search', { query: 'policy', limit: 2, knowledgeBaseRefs: [],
    knowledgeBaseIds: ['selected'], restrictToKnowledgeBaseRefs: true }, expect.any(AbortSignal))
  expect(JSON.stringify({ schema, input: invoke.mock.calls[0]?.[1], result })).toContain('Recorded enterprise evidence.')
  const { content: _content, score: _score, ...source } = hit
  expect(result.meta).toEqual({ kind: 'product-knowledge-sources-v1', sources: [source] })
  const read = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('read-source'),
    agent, name: 'knowledge_read', arguments: { sourceId: 'source' } })
  expect(invoke).toHaveBeenCalledWith('knowledge.sources.read', { sourceId: 'source' }, expect.any(AbortSignal))
  expect(JSON.stringify(read)).toContain('Recorded enterprise evidence.')
  expect(read.meta).toEqual(result.meta)
  invoke.mockResolvedValueOnce({ ...hit, sourceId: 'other-source' })
  const wrongSource = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('wrong-source'),
    agent, name: 'knowledge_read', arguments: { sourceId: 'source' } })
  expect(wrongSource.isError).toBe(true)
  expect(JSON.stringify(wrongSource)).toContain('does not match the requested fragment')
  expect(JSON.stringify(wrongSource)).not.toContain('Recorded enterprise evidence.')
  expect(wrongSource.meta).toBeUndefined()
  invoke.mockResolvedValueOnce({ ...hit, knowledgeBaseId: 'unselected' })
  const wrongScope = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('wrong-scope'),
    agent, name: 'knowledge_read', arguments: { sourceId: 'source' } })
  expect(JSON.stringify(wrongScope)).toContain('outside the selected task scope')
  expect(JSON.stringify(wrongScope)).not.toContain('Recorded enterprise evidence.')
  expect(wrongScope.meta).toBeUndefined()
  invoke.mockRejectedValueOnce(new Error('permission revoked'))
  const denied = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('revoked-fixture'),
    agent, name: 'knowledge_search', arguments: { query: 'policy' } })
  expect(JSON.stringify(denied)).toContain('permission revoked')
  let settle: (() => void) | undefined
  let signal: AbortSignal | undefined
  invoke.mockImplementationOnce(async (_method, _payload, requestSignal) => {
    signal = requestSignal
    await new Promise<void>((resolve) => { settle = resolve })
    signal?.throwIfAborted()
    return hit
  })
  const pending = ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('pending-source'),
    agent, name: 'knowledge_read', arguments: { sourceId: 'source' } })
  onTestFinished(() => { settle?.() })
  await vi.waitFor(() => { expect(settle).toBeDefined() })
  await release()
  expect(signal?.aborted).toBe(false)
  let disposed = false
  const disposing = handle.dispose().then(() => { disposed = true })
  await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
  expect(disposed).toBe(false)
  settle?.()
  await pending
  await disposing
  expect(ctx.tools.schemas()).toEqual([])
})
