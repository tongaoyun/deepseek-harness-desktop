/** Catalog reads retain cancellation and employee ownership through transport settlement. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProductCatalogManager } from '../src/catalog-manager.ts'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'

function page(id: string) {
  return Response.json({ success: true, data: [{ id }], pageIndex: 1, pageSize: 100, totalCount: 1, totalPages: 1 })
}

function fixture(transport: typeof fetch, settle = () => {}, ensureFreshSession = async () => undefined) {
  const identity = new AbortController()
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'token', fetch: transport })
  const emit = vi.fn()
  const catalogs = new ProductCatalogManager({ api,
    getSession: () => ({ authenticated: true, employeeId: 'employee-a' }),
    ensureFreshSession,
    getIdentitySignal: () => identity.signal, emit })
  onTestFinished(async () => { settle(); await catalogs.dispose(); api.close() })
  return { catalogs, identity, emit }
}

it('reads the current connector catalog without using an earlier snapshot when no caller signal is supplied', async () => {
  let fail = false
  const { catalogs } = fixture(async () => {
    if (fail) throw new Error('Current catalog is unavailable')
    return page('earlier')
  })
  await catalogs.refresh()
  fail = true
  await expect(catalogs.read('connectors.list')).rejects.toThrow('unavailable')
})

it.each([false, true])('notifies a complete catalog outage and recovery with an earlier snapshot: %s', async (loaded) => {
  let offline = false
  const { catalogs, emit } = fixture(async () => {
    if (offline) throw new Error('Catalog service unavailable')
    return page('existing')
  })
  if (loaded) await catalogs.refresh()
  emit.mockClear()
  offline = true
  await expect(catalogs.refresh()).rejects.toThrow('Catalog service unavailable')
  expect(emit).toHaveBeenCalledOnce()
  expect(emit.mock.lastCall?.[0]).toMatchObject({ type: 'catalog.changed',
    payload: { employeeId: 'employee-a' } })
  await expect(catalogs.refresh()).rejects.toThrow('Catalog service unavailable')
  expect(emit).toHaveBeenCalledOnce()
  offline = false
  await catalogs.refresh()
  expect(emit).toHaveBeenCalledTimes(2)
})

it('invalidates renderer catalogs when a scheduled refresh loses both services', async () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  let offline = false
  const { catalogs, emit } = fixture(async () => {
    if (offline) throw new Error('Catalog service unavailable')
    return page('existing')
  })
  await catalogs.refresh()
  emit.mockClear()
  offline = true
  await vi.advanceTimersByTimeAsync(5 * 60 * 1_000)
  expect(emit).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(5 * 60 * 1_000)
  expect(emit).toHaveBeenCalledOnce()
  offline = false
  await vi.advanceTimersByTimeAsync(5 * 60 * 1_000)
  expect(emit).toHaveBeenCalledTimes(2)
})

it('notifies a session-renewal outage without requesting catalogs and notifies its recovery', async () => {
  let offline = false
  const transport = vi.fn<typeof fetch>(async () => page('existing'))
  const { catalogs, emit } = fixture(transport, () => {}, async () => {
    if (offline) throw new Error('Session service unavailable')
    return undefined
  })
  await catalogs.refresh()
  emit.mockClear()
  transport.mockClear()
  offline = true
  await expect(catalogs.refresh()).rejects.toThrow('Session service unavailable')
  expect(transport).not.toHaveBeenCalled()
  expect(emit).toHaveBeenCalledOnce()
  await expect(catalogs.refresh()).rejects.toThrow('Session service unavailable')
  expect(emit).toHaveBeenCalledOnce()
  offline = false
  await catalogs.refresh()
  expect(emit).toHaveBeenCalledTimes(2)
  expect(transport).toHaveBeenCalledTimes(2)
})

it.each(['identity', 'reset'] as const)('does not publish a late renewal failure after %s cancellation', async (kind) => {
  const renewal = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const transport = vi.fn<typeof fetch>(async () => page('existing'))
  const { catalogs, identity, emit } = fixture(transport, () => { renewal.resolve(undefined) }, () => {
    entered.resolve(undefined)
    return renewal.promise
  })
  const refresh = expect(catalogs.refresh()).rejects.toThrow(kind === 'identity' ? 'Employee changed' : 'reset')
  await entered.promise
  if (kind === 'identity') identity.abort(new Error('Employee changed'))
  else catalogs.reset()
  renewal.reject(new Error('Session service unavailable'))
  await refresh
  expect(transport).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
})

it('returns a pending read result even when a newer connector read fails', async () => {
  const response = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<undefined>()
  let requests = 0
  const { catalogs } = fixture(async (input) => {
    const route = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
    if (route !== '/api/v1/connectors') return page('knowledge')
    if (++requests > 1) throw new Error('Newer connector read failed')
    entered.resolve(undefined)
    return response.promise
  }, () => { response.resolve(page('existing')) })
  const pending = catalogs.read('connectors.list')
  try {
    await entered.promise
    await expect(catalogs.read('connectors.list', new AbortController().signal)).rejects.toThrow('Newer connector read failed')
    response.resolve(page('existing'))
    await expect(pending).resolves.toEqual([{ id: 'existing' }])
  } finally {
    response.resolve(page('existing'))
    await pending
  }
})

it('rejects reads after disposal without requesting or returning employee data', async () => {
  const transport = vi.fn<typeof fetch>(async () => page('cached'))
  const { catalogs } = fixture(transport)
  await expect(catalogs.read('connectors.list')).resolves.toEqual([{ id: 'cached' }])
  await catalogs.dispose()
  await expect(catalogs.read('connectors.list')).rejects.toThrow('disposed')
  expect(transport).toHaveBeenCalledTimes(1)
})

it.each(['connectors.list', 'knowledge.bases.list'] as const)(
  'aborts and joins an active %s read on disposal, rejecting its late success', async (method) => {
    const response = Promise.withResolvers<Response>()
    let signal: AbortSignal | null | undefined
    const { catalogs } = fixture(async (_input, init) => { signal = init?.signal; return response.promise }, () => { response.resolve(page('late')) })
    const read = expect(catalogs.read(method))
      .rejects.toThrow('disposed')
    await vi.waitFor(() => { expect(signal).toBeDefined() })
    let disposed = false
    const closing = catalogs.dispose().then(() => { disposed = true })
    expect(signal?.aborted).toBe(true)
    await Promise.resolve()
    expect(disposed).toBe(false)
    response.resolve(page('late'))
    await Promise.all([read, closing])
    expect(disposed).toBe(true)
  },
)

it.each(['identity', 'reset'] as const)('cancels an active catalog read on %s change and preserves its cause', async (kind) => {
  const response = Promise.withResolvers<Response>()
  let signal: AbortSignal | null | undefined
  const { catalogs, identity } = fixture(async (_input, init) => { signal = init?.signal; return response.promise }, () => { response.resolve(page('late')) })
  const read = expect(catalogs.read('knowledge.bases.list')).rejects.toThrow(kind === 'identity' ? 'Employee changed' : 'reset')
  await vi.waitFor(() => { expect(signal).toBeDefined() })
  const reason = new Error('Employee changed')
  if (kind === 'identity') identity.abort(reason)
  else catalogs.reset()
  expect(signal?.aborted).toBe(true)
  if (kind === 'identity') expect(signal?.reason).toBe(reason)
  response.resolve(page('old-employee'))
  await read
})

it('starts a new refresh after reset without publishing the old refresh', async () => {
  const response = Promise.withResolvers<Response>()
  let requests = 0
  const { catalogs, emit } = fixture(async () => ++requests <= 2 ? response.promise : page('new'), () => { response.resolve(page('old')) })
  const oldRefresh = expect(catalogs.refresh()).rejects.toThrow('reset')
  await vi.waitFor(() => { expect(requests).toBe(2) })
  catalogs.reset()
  await catalogs.refresh()
  expect(emit).toHaveBeenCalledTimes(1)
  response.resolve(page('old'))
  await oldRefresh
  expect(emit).toHaveBeenCalledTimes(1)
  expect(requests).toBe(4)
})

it('emits a change when a catalog payload changes under the same route', async () => {
  let refresh = 0
  const transport = vi.fn<typeof fetch>(async (input) => {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const route = new URL(requestUrl).pathname
    const version = refresh < 2 ? 'original' : 'updated'
    if (route === '/api/v1/connectors') return page(version)
    return page('knowledge')
  })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'token', fetch: transport })
  const emit = vi.fn()
  const catalogs = new ProductCatalogManager({
    api,
    getSession: () => ({ authenticated: true, employeeId: 'employee-a' }),
    ensureFreshSession: async () => undefined,
    getIdentitySignal: () => new AbortController().signal,
    emit,
  })
  await catalogs.refresh()
  refresh = 2
  await catalogs.refresh()
  expect(emit).toHaveBeenCalledTimes(2)
  await catalogs.dispose()
  api.close()
})
