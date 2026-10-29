import { afterEach, expect, it, vi } from 'vitest'
import { invokeProduct, productApi } from '../src/client/product-api.ts'

afterEach(() => vi.unstubAllGlobals())

it('restores public failures after plain structured replies cross the isolated-world bridge', async () => {
  const failure = { code: 'ORGANIZATION_EMPLOYEE_UNMAPPED', message: 'Employee mapping is missing',
    retryable: false, resources: [{ kind: 'knowledge', id: 'policy' }],
    dependencyChecks: [{ kind: 'KNOWLEDGE_BASE', reference: 'company:policy', status: 'UNAUTHORIZED' }] }
  const invoke = vi.fn(async () => structuredClone({ ok: false, failure }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke } })
  await expect(productApi()!.invoke('knowledge.bases.list', undefined, 'request-id')).rejects.toMatchObject(failure)
  expect(invoke).toHaveBeenCalledWith('product', 'knowledge.bases.list', undefined, 'request-id')
})

it('unwraps replies and reads the public authentication status and employee identity', async () => {
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true,
    result: method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee', sessionToken: 'private' } : ['policy'] }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const api = productApi()!
  await expect(api.getSession()).resolves.toEqual({ authenticated: true, employeeId: 'employee' })
  await expect(api.invoke('knowledge.bases.list')).resolves.toEqual(['policy'])
  api.cancel('request-id')
  expect(cancel).toHaveBeenCalledWith('product', 'request-id')
})

it.each([null, { ok: true }, { ok: false, failure: { message: 'private diagnostic' } }])(
  'rejects incomplete desktop replies without showing private diagnostics', async (response) => {
    vi.stubGlobal('dshDesktop', { extensions: { invoke: async () => response } })
    await expect(productApi()!.invoke('knowledge.bases.list')).rejects.toThrow('Invalid product transport response')
  },
)

it('cancels a shared product request immediately and releases the abort listener', async () => {
  const pending = Promise.withResolvers<unknown>()
  const invoke = vi.fn(() => pending.promise)
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const api = productApi()!
  const controller = new AbortController()
  const request = invokeProduct(api, 'knowledge.bases.list', undefined, controller.signal)
  controller.abort(new Error('view closed'))
  await expect(request).rejects.toThrow('view closed')
  expect(cancel).toHaveBeenCalledOnce()
  pending.resolve({ ok: true, result: [] })
})
