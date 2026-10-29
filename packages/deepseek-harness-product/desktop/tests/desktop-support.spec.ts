import { afterEach, expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '@deepseek-harness/product/bridge'
import { isProductRuntimeMethod } from '@deepseek-harness/product/protocol'
import { DesktopSupport } from '../src/desktop-support.ts'

afterEach(() => vi.restoreAllMocks())
const policy = { heartbeatIntervalMs: 300000, reportIntervalMs: 86400000 }
function fixture(transport: typeof fetch) {
  const native = vi.fn<(method: string) => Promise<unknown>>(async method => method === 'device-identity.get' ? { deviceId: 'private-installation-id' }
    : { ready: true, protocol: 'deepseek-harness.native.v1', capabilities: ['device-identity'] })
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
    const state = await f.bridge.invoke('support.device.report', { employeeId: 'forged', desktopVersion: '999.0.0', capabilities: [] })
    await f.bridge.invoke('support.device.report')
    expect(calls.map(call => new URL(call.path).pathname)).toEqual(['/api/v1/device-capabilities', '/api/v1/device-capabilities/presence'])
    const report = JSON.parse(requestBody(calls[0]!.init)) as Record<string, unknown>
    const presence = JSON.parse(requestBody(calls[1]!.init)) as Record<string, unknown>
    expect(report).toMatchObject({ desktopVersion: '0.2.1-alpha.2', platform: 'darwin', architecture: 'arm64', displayCount: 1, displayScalePercents: [200] })
    expect(report.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(presence.deviceId).toEqual(report.deviceId)
    expect(report.capabilities).toEqual([
      { key: 'native.device-identity', status: 'READY', detail: 'Native capability: device-identity' },
      { key: 'credentials.encryption', status: 'READY', detail: 'OS credential encryption available' },
    ])
    expect(report).not.toHaveProperty('employeeId')
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer fixture-private-token')
    expect(state).toMatchObject({ status: 'READY', capabilitiesReportedAt: '2026-10-13T00:00:00Z' })
    expect(JSON.stringify([state, report])).not.toMatch(/private-token|private-installation|userData/)
    expect(isProductRuntimeMethod('support.feedback.submit')).toBe(false)
  } finally { await f.close() }
})

it.each(['backward', 'forward'] as const)('keeps device-report intervals independent of a %s system-clock jump', async (direction) => {
  const originalTime = Date.parse('2026-10-27T08:00:00Z')
  const wall = vi.spyOn(Date, 'now').mockReturnValue(originalTime)
  const elapsed = vi.spyOn(performance, 'now').mockReturnValue(100_000)
  const paths: string[] = []
  const f = fixture(async (url) => {
    paths.push(new URL(requestUrl(url)).pathname)
    return paths.at(-1)?.endsWith('/presence') ? new Response(null, { status: 204 })
      : Response.json({ success: true, data: { createdAt: '2026-10-27T08:00:00Z' } })
  })
  try {
    await f.bridge.invoke('support.device.report')
    wall.mockReturnValue(originalTime + (direction === 'forward' ? 2 : -2) * policy.reportIntervalMs)
    elapsed.mockReturnValue(100_000 + (direction === 'forward' ? policy.heartbeatIntervalMs : policy.reportIntervalMs))
    const state = await f.bridge.invoke('support.device.report')
    expect(paths).toEqual(['/api/v1/device-capabilities', direction === 'forward'
      ? '/api/v1/device-capabilities/presence' : '/api/v1/device-capabilities'])
    if (direction === 'forward') expect(state).toMatchObject({
      lastSeenAt: new Date(originalTime + 2 * policy.reportIntervalMs).toISOString(),
      capabilitiesReportedAt: '2026-10-27T08:00:00Z',
    })
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
    fail = false
    expect(await f.bridge.invoke('support.device.report')).toMatchObject({ status: 'READY' })
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

it.each(['', '   ', null, 42])('rejects an empty or invalid feedback receipt %j', async (id) => {
  const f = fixture(async () => Response.json({ success: true, data: { id } }))
  try {
    await expect(f.bridge.invoke('support.feedback.submit', { operationId: '00000000-0000-4000-8000-000000000001',
      message: '保留反馈内容', category: 'BUG' })).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
  } finally { await f.close() }
})

it('rejects malformed device receipts and retries rather than caching a successful report', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: {} }))
  const f = fixture(transport)
  try {
    await expect(f.bridge.invoke('support.device.report')).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
    transport.mockResolvedValueOnce(Response.json({ success: true, data: { createdAt: '2026-10-13T00:00:00Z' } }))
    await f.bridge.invoke('support.device.report')
    expect(transport.mock.calls.map(call => requestUrl(call[0]))).toEqual([
      'https://product.test/api/v1/device-capabilities', 'https://product.test/api/v1/device-capabilities',
    ])
  } finally { await f.close() }
})

it('clears an earlier presence failure after a successful heartbeat', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { createdAt: '2026-10-13T00:00:00Z' } }))
  const f = fixture(transport)
  try {
    await f.bridge.invoke('support.device.report')
    transport.mockRejectedValueOnce(new Error('offline'))
    await expect(f.bridge.invoke('support.device.report')).rejects.toThrow()
    transport.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const state = await f.bridge.invoke('support.device.report')
    expect(state).toMatchObject({ status: 'READY', capabilitiesReportedAt: '2026-10-13T00:00:00Z' })
    expect(state).not.toHaveProperty('failureCode')
  } finally { await f.close() }
})

it.each([
  null,
  { ready: true, protocol: 'deepseek-harness.native.v0', capabilities: ['device-identity'] },
  { ready: true, protocol: 'deepseek-harness.native.v1', capabilities: ['filesystem'] },
  { ready: true, protocol: 'deepseek-harness.native.v1', capabilities: ['device-identity', 'device-identity'] },
])('does not report an unusable sidecar as ready: %j', async (health) => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const transport = vi.fn<typeof fetch>()
  const f = fixture(transport)
  f.native.mockResolvedValueOnce({ deviceId: 'private-installation-id' }).mockResolvedValueOnce(health)
  try {
    await expect(f.bridge.invoke('support.device.report')).rejects.toMatchObject({ code: 'DEVICE_HEALTH_INVALID' })
    expect(transport).not.toHaveBeenCalled()
  } finally { await f.close() }
})
