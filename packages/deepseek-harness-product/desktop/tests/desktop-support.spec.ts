import { afterEach, expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '@deepseek-harness/product/bridge'
import { isProductRuntimeMethod } from '@deepseek-harness/product/protocol'
import { DesktopSupport } from '../src/desktop-support.ts'

afterEach(() => vi.restoreAllMocks())
const policy = { heartbeatIntervalMs: 300000, reportIntervalMs: 86400000 }
function fixture(transport: typeof fetch) {
  const native = vi.fn(async (method: string) => method === 'device-identity.get' ? { deviceId: 'private-installation-id' }
    : { ready: true, capabilities: ['filesystem', 'secure-storage'] })
  const support = new DesktopSupport({ policy, native, metadata: () => ({ desktopVersion: '0.2.1-alpha.2',
    platform: 'darwin', architecture: 'arm64', displayScalePercents: [200], encryptedStorage: true }) })
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', fetch: transport,
    sessionToken: 'fixture-private-token', initialSession: { authenticated: true, employeeId: 'employee-1', expiresAt: '2099-01-01T00:00:00Z' },
    support: (method, input, api, session, signal) => support.invoke(method, input, api, session, signal) })
  return { bridge, support, native, close: async () => { await bridge.dispose(); await support.close() } }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString()
}
function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
  return init.body
}

it('reports true main metadata, reuses stable installation identity and sends only presence between full reports', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  const transport: typeof fetch = async (url, init) => {
    calls.push({ path: requestUrl(url), ...init ? { init } : {} })
    return requestUrl(url).endsWith('/presence') ? new Response(null, { status: 204 })
      : Response.json({ success: true, data: { createdAt: '2026-10-13T00:00:00Z' } })
  }
  const f = fixture(transport)
  try {
    await f.bridge.invoke('support.device.report', { employeeId: 'forged', desktopVersion: '999.0.0', capabilities: [] })
    await f.bridge.invoke('support.device.report')
    expect(calls.map(call => new URL(call.path).pathname)).toEqual(['/api/v1/device-capabilities', '/api/v1/device-capabilities/presence'])
    const report = JSON.parse(requestBody(calls[0]!.init)) as Record<string, unknown>
    const presence = JSON.parse(requestBody(calls[1]!.init)) as Record<string, unknown>
    expect(report).toMatchObject({ desktopVersion: '0.2.1-alpha.2', platform: 'darwin', architecture: 'arm64', displayCount: 1, displayScalePercents: [200] })
    expect(report.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(presence.deviceId).toEqual(report.deviceId)
    expect(report).not.toHaveProperty('employeeId')
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer fixture-private-token')
    const state = await f.bridge.invoke('support.device.read')
    expect(state).toMatchObject({ status: 'READY', capabilitiesReportedAt: '2026-10-13T00:00:00Z' })
    expect(JSON.stringify([state, report])).not.toMatch(/private-token|private-installation|userData/)
    expect(isProductRuntimeMethod('support.feedback.submit')).toBe(false)
  } finally { await f.close() }
})

it('retains degraded state after an outage, retries a full report and aborts and drains in-flight operations', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  let active = 0
  let fail = true
  let waiting = false
  const transport: typeof fetch = async (_url, init) => {
    if (fail) throw new Error('private upstream diagnostic')
    if (!waiting) return Response.json({ success: true, data: { createdAt: '2026-10-13T00:00:00Z' } })
    active++
    try {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
      })
    } finally { active-- }
  }
  const f = fixture(transport)
  try {
    await expect(f.bridge.invoke('support.device.report')).rejects.toThrow()
    expect(await f.bridge.invoke('support.device.read')).toMatchObject({ status: 'DEGRADED' })
    expect(JSON.stringify(await f.bridge.invoke('support.device.read'))).not.toContain('private upstream diagnostic')
    fail = false
    await f.bridge.invoke('support.device.report')
    waiting = true
    const request = f.bridge.invoke('support.device.report')
    const settled = expect(request).rejects.toThrow()
    await vi.waitFor(() => { expect(active).toBe(1) })
    await f.close(); await settled
    expect(active).toBe(0)
  } finally { await f.close() }
})

it('submits explicitly selected screenshots with main-owned identity and bounded metadata', async () => {
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const form = init?.body
    expect(form).toBeInstanceOf(FormData)
    if (!(form instanceof FormData)) throw new Error('Missing multipart feedback')
    const metadata = form.get('feedback')
    if (!(metadata instanceof Blob)) throw new Error('Missing feedback metadata')
    expect(JSON.parse(await metadata.text())).toMatchObject({ message: 'The document does not open', category: 'BUG', desktopVersion: '0.2.1-alpha.2', taskId: '' })
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('00000000-0000-4000-8000-000000000001')
    expect(form.getAll('images')).toHaveLength(1)
    return Response.json({ success: true, data: { id: 'feedback-receipt', employeeId: 'employee-1', privateField: 'never-project' } })
  })
  const f = fixture(transport)
  const payload = { operationId: '00000000-0000-4000-8000-000000000001', message: ' The document does not open ', category: 'BUG',
    employeeId: 'another-employee', desktopVersion: '999.0.0', images: [{ name: 'screen.png', mediaType: 'image/png', data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }] }
  try {
    expect(await f.bridge.invoke('support.feedback.submit', payload)).toEqual({ id: 'feedback-receipt' })
    await expect(f.bridge.invoke('support.feedback.submit', { ...payload, images: [{ name: 'large.png', mediaType: 'image/png', data: new Uint8Array(5 * 1024 * 1024 + 1) }] }))
      .rejects.toMatchObject({ code: 'FEEDBACK_IMAGES_INVALID' })
    expect(transport).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('rejects malformed device receipts and retries rather than caching a successful report', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: {} }))
  const f = fixture(transport)
  try {
    await expect(f.bridge.invoke('support.device.report')).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
    expect(await f.bridge.invoke('support.device.read')).toMatchObject({ status: 'DEGRADED' })
    transport.mockResolvedValueOnce(Response.json({ success: true, data: { createdAt: '2026-10-13T00:00:00Z' } }))
    await f.bridge.invoke('support.device.report')
    expect(transport.mock.calls.map(call => requestUrl(call[0]))).toEqual([
      'https://product.test/api/v1/device-capabilities', 'https://product.test/api/v1/device-capabilities',
    ])
  } finally { await f.close() }
})
