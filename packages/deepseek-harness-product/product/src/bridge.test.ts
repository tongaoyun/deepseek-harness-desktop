import { describe, expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from './bridge.ts'
import { DeepSeekHarnessApiClient } from './http-client.ts'
import { DingTalkAuthorizationTimeoutError, ensureDingTalkSession } from './dingtalk-auth.ts'

describe('DeepSeekHarnessProductBridge', () => {
  it('exposes session state without exposing a token', () => {
    const bridge = new DeepSeekHarnessProductBridge()
    bridge.setSession({ authenticated: true, employeeId: 'employee-1' }, 'opaque-secret')
    expect(bridge.getSession()).toEqual({ authenticated: true, employeeId: 'employee-1' })
    expect(JSON.stringify(bridge.getSession())).not.toContain('opaque-secret')
  })

  it('rejects product methods outside the allowlist', async () => {
    const bridge = new DeepSeekHarnessProductBridge()
    await expect(bridge.invoke('shell.exec')).rejects.toThrow('unsupported method')
    await expect(bridge.invoke('bootstrap.get')).rejects.toThrow('unsupported method')
  })

  it('routes allowlisted native capabilities through the main-process dispatcher', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const bridge = new DeepSeekHarnessProductBridge({
      nativeInvoke: (method, payload) => { calls.push({ method, payload }); return Promise.resolve({ ready: true }) },
    })
    await expect(bridge.invoke('native.device-identity.get', { scope: 'employee' })).resolves.toEqual({ ready: true })
    expect(calls).toEqual([{ method: 'device-identity.get', payload: { scope: 'employee' } }])
  })

  it('prepares one immutable Expert Kit Preset without persisting global enablement', async () => {
    const prepareExpertKit = vi.fn(() => Promise.resolve('deepseek-harness-expert-kit-fixture'))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', prepareExpertKit,
      initialSession: { authenticated: true, employeeId: 'employee-1' },
    })

    await expect(bridge.invoke('expertKits.preset.prepare', { id: 'order-expert' }))
      .resolves.toEqual({ presetId: 'deepseek-harness-expert-kit-fixture' })
    expect(prepareExpertKit).toHaveBeenCalledExactlyOnceWith('order-expert')
  })

  it('requires an authenticated employee before preparing an Expert Kit Preset', async () => {
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', prepareExpertKit: vi.fn(),
    })
    await expect(bridge.invoke('expertKits.preset.prepare', { id: 'order-expert' }))
      .rejects.toThrow('authenticated employee')
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

  it('keeps waiting when DingTalk authorization has no session yet', async () => {
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test',
      fetch: (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        expect(url).toContain('/api/v1/dingtalk-auth/authorization-requests/state-12345678')
        return Promise.resolve(Response.json({ success: true, data: { status: 'pending', session: null } }))
      },
    })

    await expect(bridge.invoke('auth.pollDingTalk', { state: 'state-12345678' }))
      .resolves.toEqual({ status: 'pending', session: null })
    expect(bridge.getSession()).toEqual({ authenticated: false })
  })

  it.each(['expired', 'invalid'] as const)('ends an unusable DingTalk authorization when it becomes %s', async (status) => {
    const bridge = {
      getSession: () => ({ authenticated: false }),
      invoke: (method: string) => {
        if (method === 'auth.beginDingTalk') {
          return Promise.resolve({ state: 'state-12345678', authorizationUrl: 'https://login.example.test/dingtalk' })
        }
        if (method === 'auth.pollDingTalk') return Promise.resolve({ status, session: null })
        return Promise.resolve({})
      },
    }

    await expect(ensureDingTalkSession(bridge, () => Promise.resolve(), { pollMs: 0 }))
      .rejects.toBeInstanceOf(DingTalkAuthorizationTimeoutError)
  })

  it('refreshes a restored session before trusting it', async () => {
    let session = { authenticated: true }
    const calls: string[] = []
    const bridge = {
      getSession: () => session,
      invoke: (method: string) => {
        calls.push(method)
        if (method === 'auth.refresh') session = { authenticated: true }
        return Promise.resolve({})
      },
    }
    await expect(ensureDingTalkSession(bridge, () => Promise.resolve())).resolves.toEqual({ authenticated: true })
    expect(calls).toEqual(['auth.refresh'])
  })

  it('coalesces proactive refreshes before concurrent catalog reads', async () => {
    const requests: Request[] = []
    let releaseRefresh: (() => void) | undefined
    const refreshReady = new Promise<void>((resolve) => { releaseRefresh = resolve })
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'expiring-session',
      initialSession: { authenticated: true, employeeId: 'employee-1',
        expiresAt: String(Math.floor(Date.now() / 1_000) + 60) },
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        if (new URL(request.url).pathname === '/api/v1/employee-auth/session/refresh') {
          await refreshReady
          return Response.json({ success: true, data: {
            sessionToken: 'refreshed-session', expiresAt: Math.floor(Date.now() / 1_000) + 1_800,
            employee: { employeeId: 'employee-1', employeeName: '员工一' },
          } })
        }
        return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100,
          totalCount: 0, totalPages: 0 })
      },
    })

    const skills = bridge.invoke('skills.list')
    const connectors = bridge.invoke('connectors.list')
    await vi.waitFor(() => {
      expect(requests.filter(request => new URL(request.url).pathname.endsWith('/session/refresh'))).toHaveLength(1)
    })
    releaseRefresh?.()
    await expect(Promise.all([skills, connectors])).resolves.toEqual([[], []])
    expect(requests.filter(request => new URL(request.url).pathname.endsWith('/session/refresh'))).toHaveLength(1)
    expect(requests.filter(request => new URL(request.url).pathname !== '/api/v1/employee-auth/session/refresh')
      .every(request => request.headers.get('authorization') === 'Bearer refreshed-session')).toBe(true)
  })

  it('clears a rejected employee session instead of repeating unauthorized requests', async () => {
    const persisted = vi.fn()
    const events: string[] = []
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      success: false, errCode: 'EMPLOYEE_UNAUTHORIZED', errMessage: 'expired',
    }), { status: 401, headers: { 'content-type': 'application/json' } })))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'rejected-session',
      initialSession: { authenticated: true, employeeId: 'employee-1',
        expiresAt: String(Math.floor(Date.now() / 1_000) + 1_000) },
      fetch, persistSession: persisted,
    })
    bridge.subscribe((event) => { events.push(event.type) })

    await expect(bridge.invoke('skills.list')).rejects.toMatchObject({
      status: 401, code: 'EMPLOYEE_UNAUTHORIZED',
    })
    expect(bridge.getSession()).toEqual({ authenticated: false })
    expect(persisted).toHaveBeenCalledWith({ authenticated: false }, undefined)
    expect(events).toEqual(['session.changed', 'auth.required'])
    await expect(bridge.invoke('skills.list')).rejects.toMatchObject({ status: 401 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps an unexpired employee session during a transient refresh outage', async () => {
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'expiring-session',
      initialSession: { authenticated: true, employeeId: 'employee-1',
        expiresAt: String(Math.floor(Date.now() / 1_000) + 60) },
      fetch: () => Promise.reject(new TypeError('network unavailable')),
    })

    await expect(bridge.invoke('skills.list')).rejects.toThrow('network unavailable')
    expect(bridge.getSession()).toMatchObject({ authenticated: true, employeeId: 'employee-1' })
  })

  it('keeps inference credentials on the main-process bootstrap boundary', async () => {
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test',
      sessionToken: 'employee-session',
      fetch: () => Promise.resolve(Response.json({ success: true, data: {
        modelApiKey: 'virtual-key', endpoints: { litellm: 'https://models.example.test/v1' }, models: ['deepseek-v4-pro'],
      } })),
    })
    await expect(bridge.loadRuntimeBootstrap()).resolves.toEqual({
      modelApiKey: 'virtual-key', endpoints: { litellm: 'https://models.example.test/v1' }, models: ['deepseek-v4-pro'],
    })
  })

  it('reads every catalog page instead of silently returning page one', async () => {
    const requested: string[] = []
    const client = new DeepSeekHarnessApiClient({
      baseUrl: 'https://deepseek-harness.test',
      getSessionToken: () => undefined,
      fetch: (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        requested.push(url)
        const page = Number(new URL(url).searchParams.get('page'))
        return Promise.resolve(new Response(JSON.stringify({
          success: true,
          data: page === 1 ? [{ id: 'one' }] : [{ id: 'two' }],
          pageIndex: page,
          pageSize: 1,
          totalCount: 2,
          totalPages: 2,
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      },
    })
    await expect(client.listAll<{ id: string }>('/api/v1/expert-kits', 1)).resolves.toEqual([{ id: 'one' }, { id: 'two' }])
    expect(requested.map(url => new URL(url).searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('serves runtime metadata and knowledge searches through the same authenticated boundary', async () => {
    const requests: Request[] = []
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: (input, init) => {
        requests.push(new Request(input, init))
        return Promise.resolve(Response.json({ success: true, data: { ok: true } }))
      },
    })
    await expect(bridge.invoke('expertKits.artifact', { id: 'order-expert' })).resolves.toEqual({ ok: true })
    await expect(bridge.invoke('expertKits.readme', { id: 'order-expert' })).resolves.toEqual({ ok: true })
    await expect(bridge.invoke('skills.artifact', { id: 'document-insight' })).resolves.toEqual({ ok: true })
    await expect(bridge.invoke('skills.readme', { id: 'document-insight' })).resolves.toEqual({ ok: true })
    await expect(bridge.invoke('knowledge.search', {
      query: '退款流程', knowledgeBaseRefs: ['organization:refund-sop'], knowledgeBaseIds: [], limit: 6,
    })).resolves.toEqual({ ok: true })
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/api/v1/expert-kits/order-expert/artifacts',
      '/api/v1/expert-kits/order-expert/readme',
      '/api/v1/skills/document-insight/artifacts',
      '/api/v1/skills/document-insight/readme',
      '/api/v1/knowledge-searches',
    ])
    expect(requests[4]?.method).toBe('POST')
    expect(requests[4]?.headers.get('authorization')).toBe('Bearer employee-session')
  })

  it('rejects malformed runtime product requests before sending them', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test', fetch,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' } })
    await expect(bridge.invoke('expertKits.get', { id: '../secret' })).rejects.toThrow('valid product id')
    await expect(bridge.invoke('knowledge.search', { query: '', knowledgeBaseRefs: [], knowledgeBaseIds: [] }))
      .rejects.toThrow('invalid knowledge search')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails when a catalog page omits pagination metadata', async () => {
    const client = new DeepSeekHarnessApiClient({
      baseUrl: 'https://deepseek-harness.test',
      getSessionToken: () => undefined,
      fetch: () => Promise.resolve(new Response(JSON.stringify({ success: true, data: [{ id: 'one' }] }), { status: 200 })),
    })
    await expect(client.listAll('/api/v1/expert-kits')).rejects.toMatchObject({ code: 'INVALID_PAGE_RESPONSE', status: 502 })
  })

  it('binds authenticated requests to the employee and CSRF-protects writes', async () => {
    const requests: Request[] = []
    const client = new DeepSeekHarnessApiClient({
      baseUrl: 'https://deepseek-harness.test',
      getSessionToken: () => 'employee-session',
      getEmployeeId: () => 'employee-1',
      fetch: (input, init) => {
        requests.push(new Request(input, init))
        return Promise.resolve(Response.json({ success: true, data: { sessionToken: 'rotated' } }))
      },
    })
    await client.refreshSession()
    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request.headers.get('authorization')).toBe('Bearer employee-session')
    expect(request.headers.get('x-deepseek-harness-employee-id')).toBe('employee-1')
    expect(request.headers.get('x-requested-with')).toBe('XMLHttpRequest')
  })
})
