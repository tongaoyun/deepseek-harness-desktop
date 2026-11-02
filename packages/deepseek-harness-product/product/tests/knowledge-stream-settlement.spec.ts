import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'

it.each([200, 403].flatMap(status => [false, true].flatMap(blocked => ['caller', 'client'].map(owner => ({ status, blocked, owner })))))('settles a $status body cancelled by $owner (blocked: $blocked) before transport cleanup completes', async ({ status, blocked, owner }) => {
  const cleanup = Promise.withResolvers<undefined>()
  const reading = Promise.withResolvers<undefined>()
  const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
  const cancel = vi.fn(() => cleanup.promise)
  const response = new Response(new ReadableStream<Uint8Array>({
    start(stream) { body.resolve(stream) }, pull() { reading.resolve(undefined) }, cancel,
  }), { status })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined,
    fetch: async (_url, options) => {
      if (blocked) options?.signal?.addEventListener('abort', (event) => { event.stopImmediatePropagation() }, { once: true })
      return response
    } })
  const controller = new AbortController()
  const reason = new Error('Preview closed')
  let settled = false
  const outcome = api.requestBytes('/api/preview', 16, controller.signal).catch((error: unknown) => error)
    .finally(() => { settled = true })
  try {
    await reading.promise
    await vi.waitFor(() => { expect(response.body?.locked).toBe(true) })
    if (owner === 'caller') controller.abort(reason)
    else api.close()
    await vi.waitFor(() => { expect(settled).toBe(true) })
    if (owner === 'caller') expect(await outcome).toBe(reason)
    else expect(await outcome).toEqual(new Error('Product client is closed'))
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  } finally {
    (await body.promise).error(reason)
    cleanup.resolve(undefined)
    api.close()
    await outcome
  }
})

it.each([
  { status: 200, declared: false }, { status: 200, declared: true },
  { status: 403, declared: false }, { status: 403, declared: true },
])('settles overflow of a $status body (declared: $declared) before transport cleanup completes', async ({ status, declared }) => {
  const cleanup = Promise.withResolvers<undefined>()
  const cancel = vi.fn(() => cleanup.promise)
  const size = status === 200 ? 17 : 64 * 1024 + 1
  const response = new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new Uint8Array(size)) }, cancel,
  }), { status, headers: declared ? { 'content-length': String(size) } : {} })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined,
    fetch: async () => response })
  let settled = false
  const outcome = api.requestBytes('/api/preview', 16).catch((error: unknown) => error).finally(() => { settled = true })
  try {
    await vi.waitFor(() => { expect(settled).toBe(true) })
    expect(await outcome).toMatchObject({ code: 'KNOWLEDGE_PREVIEW_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  } finally { cleanup.resolve(undefined); api.close(); await outcome }
})

it('preserves sink failure without waiting for rejected transport cleanup', async () => {
  const cleanup = Promise.withResolvers<undefined>()
  const cancel = vi.fn(() => cleanup.promise)
  const response = new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new Uint8Array([1])) }, cancel,
  }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined,
    fetch: async () => response })
  const failure = new Error('Disk write failed')
  let settled = false
  const outcome = api.streamBytes('/api/preview', 16, async () => { throw failure })
    .catch((error: unknown) => error).finally(() => { settled = true })
  try {
    await vi.waitFor(() => { expect(settled).toBe(true) })
    expect(await outcome).toBe(failure)
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  } finally { cleanup.reject(new Error('Cleanup failed')); api.close(); await outcome }
})
