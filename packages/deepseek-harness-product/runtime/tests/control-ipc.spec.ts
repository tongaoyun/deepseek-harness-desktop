/** Product control replies through the real Loader when parent IPC writes fail. */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Skills from '@deepseek-ai/dsh-skill'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Runtime from '../src/index.ts'

const emit = (message: object): void => { EventEmitter.prototype.emit.call(process, 'message', message) }

class FixtureSessionQuery extends SessionQueryEngine {
  override async searchSessions(): Promise<never> { throw new Error('Search is not used by product control') }
  override async searchEvents(): Promise<never> { throw new Error('Search is not used by product control') }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'product-control-ipc-'))
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  const before = process.listenerCount('message')
  const descriptors = new Map(['connected', 'send'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]))
  let failure: 'sync' | 'async' | undefined
  let catalogReads = 0
  const replies: Record<string, unknown>[] = []
  const attempts: Record<string, unknown>[] = []
  Object.defineProperties(process, {
    connected: { configurable: true, value: true },
    send: { configurable: true, value: (message: Record<string, unknown>, callback?: (error: Error | null) => void) => {
      if (message.type === 'extension-control') {
        attempts.push(message)
        if (failure === 'sync') throw new Error('Private transport diagnostic')
        if (failure === 'async') { queueMicrotask(() => callback?.(new Error('Private transport diagnostic'))); return true }
        replies.push(message)
      } else if (message.type === 'extension-invoke') {
        if (message.method === 'connectors.list') catalogReads++
        queueMicrotask(() => { emit({ type: 'extension-result', requestId: message.requestId, result: [] }) })
      }
      callback?.(null)
      return true
    } },
  })
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() }
    finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor === undefined) Reflect.deleteProperty(process, key)
        else Object.defineProperty(process, key, descriptor)
      }
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  })
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(Skills)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(Agents)
  await ctx.plugin(Presets, { default: 'minimal' })
  await ctx.plugin(FixtureSessionQuery)
  ctx.loader.builtins['fixture-product-control'] = Runtime
  await ctx.loader.root.update([{ id: 'product', name: 'cordis:fixture-product-control' }])
  await ctx.loader.await()
  await ctx.loader.resolve('product').fiber?.await()
  const dispatch = (method: string, payload: object = {}) => {
    emit({ type: 'extension-control', namespace: 'product', requestId: 1, method, payload })
  }
  return { ctx, before, replies, attempts, dispatch, catalogReads: () => catalogReads,
    fail: (mode?: 'sync' | 'async') => { failure = mode } }
}

it.each([
  ['sync', 'connectors.refresh'], ['async', 'connectors.refresh'],
  ['sync', 'unsupported'], ['async', 'unsupported'],
] as const)('contains %s reply errors after %s without replaying work or blocking later requests', async (mode, method) => {
  const h = await fixture()
  h.fail(mode)
  h.dispatch(method)
  await vi.waitFor(() => { expect(h.attempts).toHaveLength(1) })
  await vi.waitFor(() => { expect(h.ctx.logger.buffer.filter(message => message.type === 'error')).toHaveLength(1) })
  expect(h.replies).toEqual([])
  expect(h.catalogReads()).toBe(method === 'connectors.refresh' ? 2 : 1)
  if (method === 'connectors.refresh') expect(h.attempts[0]?.result).toEqual({ connectedIds: [], unavailableIds: [] })
  else expect(h.attempts[0]?.error).toBeTypeOf('string')
  expect(JSON.stringify(h.ctx.logger.buffer)).not.toContain('Private transport diagnostic')
  h.fail()
  h.dispatch('tasks.capabilities.read')
  await vi.waitFor(() => { expect(h.replies).toHaveLength(1) })
  expect(h.replies[0]).toMatchObject({ requestId: 1, result: { basePresetId: 'minimal', knowledgeBaseIds: [] } })
  expect(h.catalogReads()).toBe(method === 'connectors.refresh' ? 2 : 1)
  await h.ctx.loader.root.update([])
  await h.ctx.loader.await()
  expect(process.listenerCount('message')).toBe(h.before)
})

it.each(['tasks.capabilities.read', 'tasks.capabilities.prepare'])('cancels native Session observation for %s and allows a later request', async (method) => {
  const h = await fixture()
  const id = SessionId('cancelled-task')
  h.ctx.sessions.create(id)
  const observe = h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery)
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  onTestFinished(() => { release() })
  let signal: AbortSignal | undefined
  vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (sessionId, options) => {
    signal = options?.signal
    await pending
    return observe(sessionId, options)
  })
  h.dispatch(method, { sessionId: id })
  await vi.waitFor(() => { expect(signal).toBeDefined() })
  emit({ type: 'extension-control-cancel', namespace: 'product', requestId: 1 })
  expect(signal?.aborted).toBe(true)
  release()
  await vi.waitFor(() => { expect(h.replies).toHaveLength(1) })
  expect(h.replies[0]).toMatchObject({ requestId: 1, failure: { code: 'PRODUCT_REQUEST_CANCELLED' } })
  expect(h.replies[0]).not.toHaveProperty('result')
  h.dispatch('tasks.capabilities.read', { sessionId: id })
  await vi.waitFor(() => { expect(h.replies).toHaveLength(2) })
  expect(h.replies[1]).toMatchObject({ result: { basePresetId: 'minimal', knowledgeBaseIds: [] } })
  expect({ cancelled: h.replies[0], retried: h.replies[1] }).toMatchSnapshot()
})

it('aborts pending native task reads when the Loader unloads without sending a late reply', async () => {
  const h = await fixture()
  const id = SessionId('unloaded-task')
  h.ctx.sessions.create(id)
  const observe = h.ctx.sessionQuery.observeSession.bind(h.ctx.sessionQuery)
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  onTestFinished(() => { release() })
  let signal: AbortSignal | undefined
  vi.spyOn(h.ctx.sessionQuery, 'observeSession').mockImplementationOnce(async (sessionId, options) => {
    signal = options?.signal
    await pending
    return observe(sessionId, options)
  })
  h.dispatch('tasks.capabilities.read', { sessionId: id })
  await vi.waitFor(() => { expect(signal).toBeDefined() })
  const unloading = h.ctx.loader.root.update([])
  await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
  release()
  await unloading
  await h.ctx.loader.await()
  expect(h.replies).toEqual([])
  expect(process.listenerCount('message')).toBe(h.before)
})

it.each([{ connectorIds: ['obsolete'] }, { knowledgeBaseIds: [42] }, { sessionId: ' ' }])(
  'rejects invalid task requests through the real Loader before inspecting Sessions (%j)', async (payload) => {
    const h = await fixture()
    const observe = vi.spyOn(h.ctx.sessionQuery, 'observeSession')
    h.dispatch('tasks.capabilities.prepare', payload)
    await vi.waitFor(() => { expect(h.replies).toHaveLength(1) })
    expect(h.replies[0]).toMatchObject({ requestId: 1, failure: { code: 'CAPABILITY_REQUEST_INVALID', retryable: false } })
    expect(h.replies[0]).not.toHaveProperty('result')
    expect(observe).not.toHaveBeenCalled()
    expect(h.replies[0]).toMatchSnapshot()
  },
)
