/** Catalog reads retain cancellation and employee ownership through transport settlement. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProductCatalogManager } from '../src/catalog-manager.ts'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'

function page(id: string) {
  return Response.json({ success: true, data: [{ id }], pageIndex: 1, pageSize: 100, totalCount: 1, totalPages: 1 })
}

function fixture(transport: typeof fetch, settle = () => {}) {
  const identity = new AbortController()
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'token', fetch: transport })
  const catalogs = new ProductCatalogManager({ api,
    getSession: () => ({ authenticated: true, employeeId: 'employee-a' }),
    ensureFreshSession: async () => undefined,
    getIdentitySignal: () => identity.signal, emit: vi.fn() })
  onTestFinished(async () => { settle(); await catalogs.dispose(); api.close() })
  return { catalogs, identity }
}

it('rejects cached reads after disposal without requesting or returning employee data', async () => {
  const transport = vi.fn<typeof fetch>(async () => page('cached'))
  const { catalogs } = fixture(transport)
  await expect(catalogs.read('connectors.list')).resolves.toEqual([{ id: 'cached' }])
  await catalogs.dispose()
  await expect(catalogs.read('connectors.list')).rejects.toThrow('disposed')
  expect(transport).toHaveBeenCalledTimes(2)
})

it.each(['connectors.list', 'knowledge.bases.list'] as const)(
  'aborts and joins an active %s read on disposal, rejecting its late success', async (method) => {
    const response = Promise.withResolvers<Response>()
    let signal: AbortSignal | null | undefined
    const { catalogs } = fixture(async (_input, init) => { signal = init?.signal; return response.promise }, () => { response.resolve(page('late')) })
    const read = expect(catalogs.read(method, method === 'connectors.list' ? new AbortController().signal : undefined))
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

it('starts a new refresh after reset without publishing the old refresh or clearing the new result', async () => {
  const response = Promise.withResolvers<Response>()
  let requests = 0
  const { catalogs } = fixture(async () => ++requests <= 2 ? response.promise : page('new'), () => { response.resolve(page('old')) })
  const oldRead = expect(catalogs.read('connectors.list')).rejects.toThrow('reset')
  await vi.waitFor(() => { expect(requests).toBe(2) })
  catalogs.reset()
  await expect(catalogs.read('connectors.list')).resolves.toEqual([{ id: 'new' }])
  response.resolve(page('old'))
  await oldRead
  await expect(catalogs.read('connectors.list')).resolves.toEqual([{ id: 'new' }])
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
