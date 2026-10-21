import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { contentDigest } from '../src/company-content.ts'

const files = { 'skills/orders/SKILL.md': Buffer.from('---\nname: orders\ndescription: Review orders\n---\nUse approved tools.').toString('base64'),
  'skills/orders/references/policy.md': Buffer.from('Read-only policy').toString('base64') }
const input = { resourceKey: 'skills/orders', files }
it('validates native content, uploads one resource and keeps employee credentials in main', async () => {
  const requests: { path: string; body: unknown; authorization: string | null }[] = []
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'main-only-secret',
    initialSession: { authenticated: true, employeeId: 'alice' }, fetch: async (url, init) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname
      if (path.startsWith('/api/v1/company-content/')) {
        requests.push({ path, body: init?.body ? JSON.parse(typeof init.body === 'string' ? init.body : '') : null, authorization: new Headers(init?.headers).get('authorization') })
        return Response.json({ success: true, data: path.endsWith('submission-status') ? null : { status: 'SUBMITTED', reviewNote: '' } })
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  try {
    expect(await bridge.invoke('content.submissions.inspect', input)).toEqual({ sha256: contentDigest(files), fileCount: 2, status: null })
    const result = await bridge.invoke('content.submissions.submit', input)
    expect(result).toEqual({ status: 'SUBMITTED', reviewNote: '' })
    expect(requests.at(-1)?.body).toEqual({ ...input, sha256: contentDigest(files) })
    expect(requests.at(-1)?.authorization).toBe('Bearer main-only-secret')
    expect(JSON.stringify(result)).not.toContain('main-only-secret')
    await expect(bridge.invoke('content.submissions.submit', { ...input, ownerEmployeeId: 'bob' })).rejects.toThrow()
    await expect(bridge.invoke('content.submissions.submit', { ...input, resourceKey: 'skills/other' })).rejects.toThrow()
    await expect(bridge.invoke('content.submissions.submit', { ...input, files: { ...files, '../secret': 'YQ==' } })).rejects.toThrow()
    expect(requests.filter(item => item.path.endsWith('/submissions'))).toHaveLength(1)
  } finally { await bridge.dispose() }
})
it('requires a real employee identity and cancels status requests with the caller', async () => {
  const unauthenticated = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test' })
  try { await expect(unauthenticated.invoke('content.submissions.submit', input)).rejects.toThrow('authentication') }
  finally { await unauthenticated.dispose() }
  const reached = Promise.withResolvers<undefined>()
  let signal: AbortSignal | undefined
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'secret',
    initialSession: { authenticated: true, employeeId: 'alice' }, fetch: vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined; reached.resolve(undefined)
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => { reject(new Error('Request cancelled')) }, { once: true }))
    }) })
  try {
    const caller = new AbortController()
    const pending = bridge.invoke('content.submissions.inspect', input, caller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await reached.promise; caller.abort(); await rejected
    expect(signal?.aborted).toBe(true)
  } finally { await bridge.dispose() }
})
