import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'

function client(transport: typeof fetch) {
  return new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'main-only-token',
    getEmployeeId: () => 'employee', fetch: transport })
}

it('returns original bytes without indexed chunks, upstream URLs or credentials', async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response('%PDF-original', { headers: { 'content-type': 'application/pdf' } }))
  const api = client(transport)
  try {
    const sink: Uint8Array[] = []
    expect(await api.streamBytes('/api/v1/knowledge-bases/base/documents/failed-document/preview', 1024,
      async (chunk) => { sink.push(chunk) })).toEqual({ mediaType: 'application/pdf', byteLength: 13 })
    expect(Buffer.concat(sink)).toEqual(Buffer.from('%PDF-original'))
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0]?.[0]).toBe('https://product.test/api/v1/knowledge-bases/base/documents/failed-document/preview')
    const options = transport.mock.calls[0]?.[1]
    expect(options?.redirect).toBe('error')
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer main-only-token')
    expect(new Headers(options?.headers).get('x-deepseek-harness-employee-id')).toBe('employee')
  } finally { api.close() }
})

it('preserves structured permission errors from the binary endpoint', async () => {
  const api = client(async () => Response.json({ success: false, errCode: 'KNOWLEDGE_ACCESS_REVOKED', errMessage: 'Access revoked',
    data: { resources: [{ type: 'knowledgeBase', id: 'base' }], retryable: false } }, { status: 403 }))
  try {
    await expect(api.requestBytes('/api/preview', 16)).rejects.toMatchObject({ code: 'KNOWLEDGE_ACCESS_REVOKED', retryable: false })
  } finally { api.close() }
})

it.each([true, false])('rejects oversized original bytes and cancels their stream (declared size: %s)', async (declared) => {
  const cancel = vi.fn()
  const api = client(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17)) }, cancel }),
    { headers: declared ? { 'content-length': '17' } : {} }))
  try {
    await expect(api.requestBytes('/api/preview', 16)).rejects.toMatchObject({ code: 'KNOWLEDGE_PREVIEW_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledTimes(1)
  } finally { api.close() }
})

it('accepts the exact byte limit across multiple chunks', async () => {
  const api = client(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close()
  } })))
  try { expect((await api.requestBytes('/api/preview', 4)).data).toEqual(new Uint8Array([1, 2, 3, 4])) }
  finally { api.close() }
})

it('cancels a body still arriving after response headers', async () => {
  const cancel = vi.fn()
  const api = client(async () => new Response(new ReadableStream({ cancel })))
  const controller = new AbortController()
  try {
    const request = api.requestBytes('/api/preview', 16, controller.signal)
    const rejected = expect(request).rejects.toThrow('Closed preview')
    await vi.waitFor(() => { expect(cancel).not.toHaveBeenCalled() })
    controller.abort(new Error('Closed preview'))
    await rejected
    expect(cancel).toHaveBeenCalled()
  } finally { api.close() }
})

it.each(['knowledge.documents.preview', 'knowledge.documents.renderOffice'])('rejects the removed whole-file %s operation', async (method) => {
  const transport = vi.fn<typeof fetch>()
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'main-token', fetch: transport })
  try {
    await expect(bridge.invoke(method, { knowledgeBaseId: 'base', documentId: 'document' })).rejects.toThrow('unsupported method')
    expect(transport).not.toHaveBeenCalled()
  } finally { await bridge.dispose() }
})

it('authorizes Office conversion in main and cancels it when employee identity changes', async () => {
  let officeSignal: AbortSignal | undefined
  const files = vi.fn<NonNullable<import('../src/bridge.ts').ProductBridgeOptions['knowledgeFiles']>>(async (_method, _payload, _api, _session, signal) => {
    officeSignal = signal
    return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => { reject(new Error('Identity changed')) }, { once: true }))
  })
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'main-token',
    initialSession: { authenticated: true, employeeId: 'employee-a' }, knowledgeFiles: files,
    fetch: async () => Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 }) })
  try {
    const request = bridge.invoke('knowledge.documents.preview.open', { knowledgeBaseId: 'base', documentId: 'document', rendered: true })
    const rejected = expect(request).rejects.toThrow('Identity changed')
    await vi.waitFor(() => { expect(officeSignal).toBeDefined() })
    bridge.setSession({ authenticated: true, employeeId: 'employee-b' }, 'new-token')
    await rejected
    expect(files).toHaveBeenCalledTimes(1)
    expect(officeSignal?.aborted).toBe(true)
  } finally { await bridge.dispose() }
})
