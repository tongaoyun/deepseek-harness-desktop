import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessApiClient, DeepSeekHarnessApiError } from '../src/http-client.ts'
import { ensureDingTalkSession } from '../src/dingtalk-auth.ts'
import { ProductError } from '../src/errors.ts'

it.each(['headers', 'body'] as const)('reports a reset during response %s without exposing credentials or retrying the request', async (phase) => {
  const cause = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
  const transport = vi.fn<typeof fetch>(async () => {
    if (phase === 'headers') throw cause
    return new Response(new ReadableStream({ start(controller) { controller.error(cause) } }))
  })
  const client = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test',
    getSessionToken: () => 'private-token', fetch: transport })
  try {
    const error = await client.beginDingTalk().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ProductError)
    expect(error).toMatchObject({ code: 'PRODUCT_NETWORK_UNAVAILABLE', retryable: true, cause })
    expect(JSON.stringify(error)).not.toContain('private-token')
    expect(transport).toHaveBeenCalledOnce()
  } finally { client.close() }
})

it('preserves caller cancellation instead of turning it into a retryable network failure', async () => {
  const controller = new AbortController()
  const cancellation = new Error('Caller stopped startup')
  const client = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined,
    fetch: async () => { controller.abort(cancellation); throw new TypeError('fetch failed') } })
  try { await expect(client.bootstrap(controller.signal)).rejects.toBe(cancellation) }
  finally { client.close() }
})

it('does not trust a saved session or start OAuth when refreshing it fails on the network', async () => {
  const failure = new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Unavailable', true)
  const invoke = vi.fn(async () => { throw failure })
  const open = vi.fn(async () => {})
  await expect(ensureDingTalkSession({ getSession: () => ({ authenticated: true }), invoke }, open)).rejects.toBe(failure)
  expect(invoke).toHaveBeenCalledOnce()
  expect(open).not.toHaveBeenCalled()
})

it('starts a fresh OAuth flow after the saved session is explicitly rejected', async () => {
  let authenticated = false
  const invoke = vi.fn(async (method: string) => {
    if (method === 'auth.refresh') throw new DeepSeekHarnessApiError(401, 'EMPLOYEE_UNAUTHORIZED', 'Expired')
    if (method === 'auth.beginDingTalk') return { state: 'state-12345678', authorizationUrl: 'https://login.test/' }
    authenticated = true
    return {}
  })
  const open = vi.fn(async () => {})
  await expect(ensureDingTalkSession({ getSession: () => ({ authenticated }), invoke }, open, { pollMs: 0 }))
    .resolves.toEqual({ authenticated: true })
  expect(open).toHaveBeenCalledWith('https://login.test/')
})
