import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalImRuntime } from './im-runtime.js'
import type { HarnessRuntime } from './runtime.js'

beforeEach(() => {
  vi.stubEnv('XIAOYIN_EMPLOYEE_ID', 'test-employee')
  vi.stubEnv('XIAOYIN_KNOWLEDGE_ENDPOINT', 'http://control.test/knowledge')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function fixture() {
  const runtime = new LocalImRuntime({} as HarnessRuntime)
  const send = vi.fn().mockResolvedValue(undefined)
  Object.assign(runtime, {
    configuration: { clientId: 'test', accessPolicy: 'open', notifyTaskResults: true },
    connected: true, taskRunBaselineInitialized: true, proactiveSend: send,
  })
  const internals = runtime as unknown as {
    pollTaskRuns(): Promise<void>
    knownTaskRunIds: Set<string>
    scheduleRoutes: Map<string, string>
    deliveryTargets: Map<string, { conversationKey: string }>
  }
  for (const id of ['one', 'two']) {
    internals.scheduleRoutes.set(id, id)
    internals.deliveryTargets.set(id, { conversationKey: id })
  }
  return { runtime, internals, send }
}

function run(id: string, status = 'COMPLETED') {
  return { runId: id, scheduleId: id, name: id, status, startedAt: '2026-09-05T00:00:00Z' }
}

it('continues other notifications after a delivery failure and retries only the unsent run', async () => {
  const { runtime, internals, send } = fixture()
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json([run('two'), run('one')])))
  send.mockRejectedValueOnce(new Error('目标暂不可用'))
  await internals.pollTaskRuns()
  expect(send).toHaveBeenCalledTimes(2)
  expect(internals.knownTaskRunIds.has('one')).toBe(false)
  expect(internals.knownTaskRunIds.has('two')).toBe(true)
  expect(runtime.status()).toMatchObject({ state: 'DEGRADED', lastError: expect.stringContaining('通知待重试') })
  await internals.pollTaskRuns()
  expect(send).toHaveBeenCalledTimes(3)
  expect(internals.knownTaskRunIds.has('one')).toBe(true)
  expect(runtime.status()).toMatchObject({ state: 'READY' })
  expect(runtime.status().lastError).toBeUndefined()
})

it('coalesces overlapping polls so a slow delivery is never sent twice concurrently', async () => {
  const { internals, send } = fixture()
  let complete!: () => void
  send.mockReturnValue(new Promise<void>((resolve) => { complete = resolve }))
  const fetcher = vi.fn().mockResolvedValue(Response.json([run('one', 'CANCELED')]))
  vi.stubGlobal('fetch', fetcher)
  const first = internals.pollTaskRuns()
  const second = internals.pollTaskRuns()
  expect(first).toBe(second)
  complete()
  await Promise.all([first, second])
  expect(fetcher).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]![1]).toContain('已取消')
})

it('keeps a configured but unavailable conversation pending instead of acknowledging delivery', async () => {
  const { internals, send } = fixture()
  internals.deliveryTargets.delete('one')
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json([run('one', 'TIMED_OUT')])))
  await internals.pollTaskRuns()
  expect(internals.knownTaskRunIds.has('one')).toBe(false)
  expect(send).not.toHaveBeenCalled()
  internals.deliveryTargets.set('one', { conversationKey: 'one' })
  await internals.pollTaskRuns()
  expect(send.mock.calls[0]![1]).toContain('执行超时')
})

it('does not deliver a late polling response after stopping the runtime', async () => {
  const { runtime, internals, send } = fixture()
  let complete!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { complete = resolve })))
  const poll = internals.pollTaskRuns()
  const stop = runtime.stop()
  complete(Response.json([run('one')]))
  await Promise.all([poll, stop])
  expect(send).not.toHaveBeenCalled()
  expect(internals.knownTaskRunIds.has('one')).toBe(false)
})
