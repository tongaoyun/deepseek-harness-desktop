import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushCapabilityNotices, rememberCapabilityNotice, reportCapabilityNotice } from './capability-notice.js'

const previous = { url: process.env.XIAOYIN_SESSION_PROJECTION_URL, token: process.env.XIAOYIN_SESSION_PROJECTION_TOKEN }
afterEach(() => {
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
  })

  it('reports a knowledge gap only against a real session', async () => {
    process.env.XIAOYIN_SESSION_PROJECTION_URL = 'http://127.0.0.1:1/projection'
    process.env.XIAOYIN_SESSION_PROJECTION_TOKEN = 'test-token'
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    reportCapabilityNotice('', { kind: 'knowledge', id: 'team:kb', name: '知识库', reason: '未配置' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays silent when no bridge is configured', async () => {
    delete process.env.XIAOYIN_SESSION_PROJECTION_URL
    delete process.env.XIAOYIN_SESSION_PROJECTION_TOKEN
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    rememberCapabilityNotice({ kind: 'connector', id: 'erp-mcp', name: 'erp-mcp', reason: '连接失败' })
    flushCapabilityNotices('session-1')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
