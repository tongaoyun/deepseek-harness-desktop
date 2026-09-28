import { describe, expect, it } from 'vitest'
import { XiaoyinProductBridge } from './bridge.ts'
import { XiaoyinApiClient } from './http-client.ts'
import { ensureDingTalkSession } from './dingtalk-auth.ts'

describe('XiaoyinProductBridge', () => {
  it('exposes session state without exposing a token', () => {
    const bridge = new XiaoyinProductBridge()
    bridge.setSession({ authenticated: true, employeeId: 'employee-1' }, 'opaque-secret')
    expect(bridge.getSession()).toEqual({ authenticated: true, employeeId: 'employee-1' })
    expect(JSON.stringify(bridge.getSession())).not.toContain('opaque-secret')
  })

  it('rejects product methods outside the allowlist', async () => {
    const bridge = new XiaoyinProductBridge()
    await expect(bridge.invoke('shell.exec')).rejects.toThrow('unsupported method')
  })

  it('routes allowlisted native capabilities through the main-process dispatcher', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const bridge = new XiaoyinProductBridge({
      nativeInvoke: (method, payload) => { calls.push({ method, payload }); return Promise.resolve({ ready: true }) },
    })
    await expect(bridge.invoke('native.device-identity.get', { scope: 'employee' })).resolves.toEqual({ ready: true })
    expect(calls).toEqual([{ method: 'device-identity.get', payload: { scope: 'employee' } }])
  })

  it('opens DingTalk OAuth in the system browser and never creates a QR window', async () => {
    let session = { authenticated: false }
    const opened: string[] = []
    const bridge = {
      getSession: () => session,
      invoke: (method: string) => {
        if (method === 'auth.beginDingTalk') return Promise.resolve({ state: 'state-12345678', authorizationUrl: 'https://login.example.test/dingtalk' })
        if (method === 'auth.pollDingTalk') { session = { authenticated: true }; return Promise.resolve({}) }
        return Promise.resolve({})
      },
    }
    const openExternal = (url: string): Promise<void> => { opened.push(url); return Promise.resolve() }
    await expect(ensureDingTalkSession(bridge, openExternal, { pollMs: 0 }))
      .resolves.toEqual({ authenticated: true })
    expect(opened).toEqual(['https://login.example.test/dingtalk'])
  })

  it('reads every catalog page instead of silently returning page one', async () => {
    const requested: string[] = []
    const client = new XiaoyinApiClient({
      baseUrl: 'https://xiaoyin.test',
      getSessionToken: () => undefined,
      fetch: (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        requested.push(url)
        const page = Number(new URL(url).searchParams.get('page'))
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: {
          records: page === 1 ? [{ id: 'one' }] : [{ id: 'two' }],
          page, size: 100, total: 2, totalPages: 2,
        } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      },
    })
    await expect(client.listAll<{ id: string }>('/api/v1/expert-kits')).resolves.toEqual([{ id: 'one' }, { id: 'two' }])
    expect(requested.map(url => new URL(url).searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('fails when a catalog page omits pagination metadata', async () => {
    const client = new XiaoyinApiClient({
      baseUrl: 'https://xiaoyin.test',
      getSessionToken: () => undefined,
      fetch: () => Promise.resolve(new Response(JSON.stringify({ success: true, data: [{ id: 'one' }] }), { status: 200 })),
    })
    await expect(client.listAll('/api/v1/expert-kits')).rejects.toMatchObject({ code: 'INVALID_PAGE_RESPONSE', status: 502 })
  })
})
