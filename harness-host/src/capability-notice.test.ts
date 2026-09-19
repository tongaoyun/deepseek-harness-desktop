import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushCapabilityNotices, rememberCapabilityNotice, reportCapabilityNotice } from './capability-notice.js'

const previous = { url: process.env.XIAOYIN_SESSION_PROJECTION_URL, token: process.env.XIAOYIN_SESSION_PROJECTION_TOKEN }
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (previous.url === undefined) delete process.env.XIAOYIN_SESSION_PROJECTION_URL
  else process.env.XIAOYIN_SESSION_PROJECTION_URL = previous.url
  if (previous.token === undefined) delete process.env.XIAOYIN_SESSION_PROJECTION_TOKEN
  else process.env.XIAOYIN_SESSION_PROJECTION_TOKEN = previous.token
})

describe('capability notices', () => {
  it('delivers a stashed connector gap against the session that starts', async () => {
    process.env.XIAOYIN_SESSION_PROJECTION_URL = 'http://127.0.0.1:1/projection'
    process.env.XIAOYIN_SESSION_PROJECTION_TOKEN = 'test-token'
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    rememberCapabilityNotice({ kind: 'connector', id: 'erp-mcp', name: 'erp-mcp', reason: '连接失败' })
    flushCapabilityNotices('session-1')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:1/projection')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token')
    expect(JSON.parse(String(init.body))).toMatchObject({
      sessionId: 'session-1', key: 'xiaoyin.capabilityNotice',
      value: { kind: 'connector', name: 'erp-mcp', reason: '连接失败' },
    })
    flushCapabilityNotices('session-1')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reports only against a real session and stays silent without a bridge', () => {
    process.env.XIAOYIN_SESSION_PROJECTION_URL = 'http://127.0.0.1:1/projection'
    process.env.XIAOYIN_SESSION_PROJECTION_TOKEN = 'test-token'
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    reportCapabilityNotice('', { kind: 'knowledge', id: 'team:kb', name: '知识库', reason: '未配置' })
    expect(fetchMock).not.toHaveBeenCalled()

    delete process.env.XIAOYIN_SESSION_PROJECTION_URL
    rememberCapabilityNotice({ kind: 'connector', id: 'erp-mcp', name: 'erp-mcp', reason: '连接失败' })
    flushCapabilityNotices('session-1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries a transient bridge failure before sending the next notice in that session', async () => {
    vi.useFakeTimers()
    process.env.XIAOYIN_SESSION_PROJECTION_URL = 'http://127.0.0.1:1/projection'
    process.env.XIAOYIN_SESSION_PROJECTION_TOKEN = 'test-token'
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const first = reportCapabilityNotice('session-retry', { kind: 'knowledge', id: 'scope', name: '知识库', reason: '不可用' })
    const second = reportCapabilityNotice('session-retry', { kind: 'connector', id: 'erp', name: 'ERP', reason: '连接失败' })
    expect(fetchMock).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(200)
    await Promise.all([first, second])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual(JSON.parse(String(fetchMock.mock.calls[1][1].body)))
    const later = JSON.parse(String(fetchMock.mock.calls[2][1].body))
    expect(later.value.id).toBe('erp')
    expect(later.seq).toBeGreaterThan(JSON.parse(String(fetchMock.mock.calls[1][1].body)).seq)
  })

  it('reports a permanent bridge rejection without retrying', async () => {
    process.env.XIAOYIN_SESSION_PROJECTION_URL = 'http://127.0.0.1:1/projection'
    process.env.XIAOYIN_SESSION_PROJECTION_TOKEN = 'test-token'
    const fetchMock = vi.fn(async () => new Response(null, { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await reportCapabilityNotice('session-invalid', { kind: 'connector', id: 'erp', name: 'ERP', reason: '连接失败' })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('HTTP 400'))
    } finally {
      diagnostic.mockRestore()
    }
  })
})
