import { describe, expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'
import { DingTalkAuthorizationTimeoutError, ensureDingTalkSession } from '../src/dingtalk-auth.ts'

const immutableCatalog = {
  '/api/v1/expert-kits': [{ id: 'order-expert', version: '1.0.0', sha256: 'a'.repeat(64),
    skillIds: [], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] }],
  '/api/v1/skills': [{ id: 'document-insight', version: '1.0.0', sha256: 'b'.repeat(64),
    connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] }],
  '/api/v1/connectors': [],
  '/api/v1/knowledge-bases': [],
} as const

function catalogFetch(input: Parameters<typeof fetch>[0]): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const data = immutableCatalog[url.pathname as keyof typeof immutableCatalog] ?? []
  return Promise.resolve(Response.json({ success: true, data, pageIndex: 1, pageSize: 100,
    totalCount: data.length, totalPages: data.length === 0 ? 0 : 1 }))
}

function catalogTransport(catalog: Readonly<Record<string, readonly unknown[]>>): typeof fetch {
  return (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const path = url.pathname.startsWith('/root/api/') ? url.pathname.slice('/root'.length) : url.pathname
    const data = catalog[path] ?? []
    return Promise.resolve(Response.json({ success: true, data, pageIndex: 1, pageSize: 100,
      totalCount: data.length, totalPages: data.length === 0 ? 0 : 1 }))
  }
}

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
      sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: catalogFetch,
    })

    await expect(bridge.invoke('expertKits.preset.prepare', { id: 'order-expert' }))
      .resolves.toEqual({ presetId: 'deepseek-harness-expert-kit-fixture', contentVersion: {
        id: 'order-expert', version: '1.0.0', sha256: 'a'.repeat(64),
      }, dependencyChecks: [] })
    expect(prepareExpertKit).toHaveBeenCalledExactlyOnceWith({
      id: 'order-expert', version: '1.0.0', sha256: 'a'.repeat(64),
    })
  })

  it('requires an authenticated employee before preparing an Expert Kit Preset', async () => {
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', prepareExpertKit: vi.fn(),
    })
    await expect(bridge.invoke('expertKits.preset.prepare', { id: 'order-expert' }))
      .rejects.toThrow('Employee authentication is required')
  })

  it('prepares one immutable Skill Preset through the Host runtime', async () => {
    const prepareSkill = vi.fn(() => Promise.resolve('deepseek-harness-skill-fixture'))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', prepareSkill,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: catalogFetch,
    })

    await expect(bridge.invoke('skills.prepare', { id: 'document-insight' }))
      .resolves.toEqual({ presetId: 'deepseek-harness-skill-fixture', contentVersion: {
        id: 'document-insight', version: '1.0.0', sha256: 'b'.repeat(64),
      }, dependencyChecks: [] })
    expect(prepareSkill).toHaveBeenCalledExactlyOnceWith({
      id: 'document-insight', version: '1.0.0', sha256: 'b'.repeat(64),
    })
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
    expect(fetch).toHaveBeenCalledTimes(4)
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
    if (request === undefined) throw new Error('expected one authenticated request')
    expect(request.headers.get('authorization')).toBe('Bearer employee-session')
    expect(request.headers.get('x-deepseek-harness-employee-id')).toBe('employee-1')
    expect(request.headers.get('x-requested-with')).toBe('XMLHttpRequest')
  })

  it('coalesces complete catalog refreshes and emits a real change event once', async () => {
    const requests: string[] = []
    const events: string[] = []
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: async (input) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        requests.push(path)
        await Promise.resolve()
        return Response.json({ success: true, data: [{ id: path }], pageIndex: 1, pageSize: 100,
          totalCount: 1, totalPages: 1 })
      },
    })
    bridge.subscribe((event) => { events.push(event.type) })

    const [skills, connectors] = await Promise.all([
      bridge.invoke('skills.list'), bridge.invoke('connectors.list'),
    ])

    expect(skills).toEqual([{ id: '/api/v1/skills', availabilityStatus: 'AVAILABLE' }])
    expect(connectors).toEqual([{ id: '/api/v1/connectors', availabilityStatus: 'AUTHORIZATION_REQUIRED' }])
    expect(requests.sort()).toEqual([
      '/api/v1/connectors', '/api/v1/expert-kits', '/api/v1/knowledge-bases', '/api/v1/skills',
    ])
    expect(events).toEqual(['catalog.changed'])
    bridge.dispose()
  })

  it('keeps the last successful catalog snapshot when a refresh fails', async () => {
    let fail = false
    const events: string[] = []
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: (input) => {
        if (fail) return Promise.reject(new TypeError('catalog unavailable'))
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        return Promise.resolve(Response.json({ success: true, data: [{ id: path }], pageIndex: 1, pageSize: 100,
          totalCount: 1, totalPages: 1 }))
      },
    })
    bridge.subscribe((event) => { events.push(event.type) })
    await bridge.invoke('skills.list')
    fail = true

    await expect(bridge.invoke('catalog.refresh')).rejects.toThrow('catalog unavailable')
    await expect(bridge.invoke('skills.list')).resolves.toEqual([
      { id: '/api/v1/skills', availabilityStatus: 'AVAILABLE' },
    ])
    expect(events).toEqual(['catalog.changed'])
    bridge.dispose()
  })

  it('marks capability dependencies unavailable before a user starts them', async () => {
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '2.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: catalogTransport({
        '/api/v1/expert-kits': [{ id: 'order-expert', version: '1.0.0', sha256: 'a'.repeat(64),
          skillIds: ['missing-skill'], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] }],
        '/api/v1/skills': [{ id: 'order-query', version: '1.0.0', sha256: 'b'.repeat(64),
          connectorRefs: ['erp'], requiredTools: [], knowledgeBaseRefs: [] }],
        '/api/v1/connectors': [{ id: 'erp', ready: false, authorizationStatus: 'REQUIRED', tools: [] }],
        '/api/v1/knowledge-bases': [],
      }),
    })

    await expect(bridge.invoke('expertKits.list')).resolves.toEqual([
      expect.objectContaining({ id: 'order-expert', availabilityStatus: 'UNAVAILABLE' }),
    ])
    await expect(bridge.invoke('skills.list')).resolves.toEqual([
      expect.objectContaining({ id: 'order-query', availabilityStatus: 'AUTHORIZATION_REQUIRED' }),
    ])
    bridge.dispose()
  })

  it('adds the employee bearer only to Host runtime connector metadata', async () => {
    const connector = { id: 'erp', name: 'ERP', status: 'ready', ready: true,
      authorizationStatus: 'AUTHORIZED', authMode: 'oauth', transport: 'streamable-http',
      url: '/api/v1/connectors/erp/mcp', headers: {}, arguments: [], environment: {},
      tools: [{ name: 'orders.get', access: 'READ' }] }
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test/root', sessionToken: 'employee-secret',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: catalogTransport({ ...immutableCatalog, '/api/v1/connectors': [connector] }),
    })

    const renderer = await bridge.invoke('connectors.list')
    expect(JSON.stringify(renderer)).not.toContain('employee-secret')
    expect(renderer).toEqual([{ ...connector, availabilityStatus: 'AVAILABLE' }])

    const runtime = await bridge.invokeRuntime('connectors.list')
    expect(runtime).toEqual([{ ...connector, availabilityStatus: 'AVAILABLE',
      url: 'https://deepseek-harness.test/root/api/v1/connectors/erp/mcp',
      headers: { Authorization: 'Bearer employee-secret' } }])
    bridge.dispose()
  })

  it('uses employee-scoped authorization resources and refreshes the catalog after revocation', async () => {
    const requests: Request[] = []
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        const path = new URL(request.url).pathname
        if (path.endsWith('/authorization-requests')) {
          return Response.json({ success: true, data: { status: 'PENDING', authorizationUrl: 'https://login.example' } })
        }
        if (path.endsWith('/authorization')) {
          return Response.json({ success: true, data: { status: request.method === 'DELETE' ? 'REQUIRED' : 'AUTHORIZED' } })
        }
        const data = immutableCatalog[path as keyof typeof immutableCatalog] ?? []
        return Response.json({ success: true, data, pageIndex: 1, pageSize: 100,
          totalCount: data.length, totalPages: data.length === 0 ? 0 : 1 })
      },
    })

    await expect(bridge.invoke('connectors.authorization.status', { id: 'erp' }))
      .resolves.toMatchObject({ status: 'AUTHORIZED' })
    await expect(bridge.invoke('connectors.authorization.begin', { id: 'erp' }))
      .resolves.toMatchObject({ status: 'PENDING' })
    await expect(bridge.invoke('connectors.authorization.revoke', { id: 'erp' }))
      .resolves.toMatchObject({ status: 'REQUIRED' })
    const authorizationRequests = requests.filter(request => new URL(request.url).pathname.includes('/connectors/erp/authorization'))
    expect(authorizationRequests.map(request => [request.method, new URL(request.url).pathname])).toEqual([
      ['GET', '/api/v1/connectors/erp/authorization'],
      ['POST', '/api/v1/connectors/erp/authorization-requests'],
      ['DELETE', '/api/v1/connectors/erp/authorization'],
    ])
    expect(authorizationRequests.every(request => request.headers.get('authorization') === 'Bearer employee-session'))
      .toBe(true)
    expect(authorizationRequests.filter(request => request.method !== 'GET')
      .every(request => request.headers.get('x-requested-with') === 'XMLHttpRequest')).toBe(true)
    expect(requests).toHaveLength(11)
    bridge.dispose()
  })

  it('returns the immutable content version and verified Expert Kit dependencies', async () => {
    const prepareExpertKit = vi.fn(() => Promise.resolve('deepseek-harness-expert-kit-valid'))
    const kit = { id: 'order-expert', version: '2.0.0', sha256: 'c'.repeat(64),
      minimumDesktopVersion: '1.0.0', skillIds: ['order-query'], connectorRefs: ['erp'],
      requiredTools: ['orders.get'], knowledgeBaseRefs: ['organization:orders'] }
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '2.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, prepareExpertKit,
      fetch: catalogTransport({
        '/api/v1/expert-kits': [kit],
        '/api/v1/skills': [{ id: 'order-query' }],
        '/api/v1/connectors': [{ id: 'erp', ready: true, tools: [{ name: 'orders.get' }] }],
        '/api/v1/knowledge-bases': [{ id: 'kb-1', referenceKey: 'organization:orders' }],
      }),
    })

    await expect(bridge.invoke('expertKits.preset.prepare', { id: 'order-expert' })).resolves.toEqual({
      presetId: 'deepseek-harness-expert-kit-valid',
      contentVersion: { id: 'order-expert', version: '2.0.0', sha256: 'c'.repeat(64) },
      dependencyChecks: [
        { kind: 'DESKTOP_VERSION', reference: '1.0.0', status: 'READY' },
        { kind: 'SKILL', reference: 'order-query', status: 'READY' },
        { kind: 'DATA_CONNECTION', reference: 'erp', status: 'READY' },
        { kind: 'TOOL', reference: 'orders.get', status: 'READY' },
        { kind: 'KNOWLEDGE_BASE', reference: 'organization:orders', status: 'READY' },
      ],
    })
    bridge.dispose()
  })

  it('returns the immutable content version and verified standalone Skill dependencies', async () => {
    const prepareSkill = vi.fn(() => Promise.resolve('deepseek-harness-skill-valid'))
    const skill = { id: 'order-query', version: '2.0.0', sha256: 'e'.repeat(64),
      minimumDesktopVersion: '1.0.0', connectorRefs: ['erp'],
      requiredTools: ['orders.get'], knowledgeBaseRefs: ['organization:orders'] }
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '2.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, prepareSkill,
      fetch: catalogTransport({
        ...immutableCatalog,
        '/api/v1/skills': [skill],
        '/api/v1/connectors': [{ id: 'erp', ready: true, tools: [{ name: 'orders.get' }] }],
        '/api/v1/knowledge-bases': [{ id: 'kb-1', referenceKey: 'organization:orders' }],
      }),
    })

    await expect(bridge.invoke('skills.prepare', { id: 'order-query' })).resolves.toEqual({
      presetId: 'deepseek-harness-skill-valid',
      contentVersion: { id: 'order-query', version: '2.0.0', sha256: 'e'.repeat(64) },
      dependencyChecks: [
        { kind: 'DESKTOP_VERSION', reference: '1.0.0', status: 'READY' },
        { kind: 'DATA_CONNECTION', reference: 'erp', status: 'READY' },
        { kind: 'TOOL', reference: 'orders.get', status: 'READY' },
        { kind: 'KNOWLEDGE_BASE', reference: 'organization:orders', status: 'READY' },
      ],
    })
    bridge.dispose()
  })

  it('does not reuse a prepared state after the catalog publishes a new content identity', async () => {
    let skill = { id: 'order-query', version: '1.0.0', sha256: 'a'.repeat(64),
      minimumDesktopVersion: '1.0.0', connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] }
    const prepareSkill = vi.fn(() => Promise.resolve('deepseek-harness-skill-v1'))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '2.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, prepareSkill,
      fetch: (input, init) => catalogTransport({ ...immutableCatalog, '/api/v1/skills': [skill] })(input, init),
    })

    await bridge.invoke('skills.prepare', { id: 'order-query' })
    await expect(bridge.invoke('skills.list')).resolves.toEqual([
      expect.objectContaining({ version: '1.0.0', availabilityStatus: 'AVAILABLE' }),
    ])

    skill = { ...skill, version: '2.0.0', sha256: 'b'.repeat(64), minimumDesktopVersion: '9.0.0' }
    await bridge.invoke('catalog.refresh')

    await expect(bridge.invoke('skills.list')).resolves.toEqual([
      expect.objectContaining({ version: '2.0.0', availabilityStatus: 'INCOMPATIBLE' }),
    ])
    bridge.dispose()
  })

  it.each([
    ['data connection', { connectorRefs: ['missing-connector'] }, {}, 'requires unavailable data connection'],
    ['tool', { connectorRefs: ['erp'], requiredTools: ['missing-tool'] }, {
      '/api/v1/connectors': [{ id: 'erp', ready: true, tools: [{ name: 'orders.get' }] }],
    }, 'requires unavailable tool'],
    ['knowledge base', { knowledgeBaseRefs: ['organization:missing'] }, {}, 'requires unavailable knowledge'],
  ] as const)('blocks a standalone Skill with an unavailable %s dependency', async (_label, overrides, extra, message) => {
    const prepareSkill = vi.fn(() => Promise.resolve('must-not-run'))
    const skill = { id: 'order-query', version: '1.0.0', sha256: 'f'.repeat(64),
      connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [], ...overrides }
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '1.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, prepareSkill,
      fetch: catalogTransport({ ...immutableCatalog, '/api/v1/skills': [skill], ...extra }),
    })

    await expect(bridge.invoke('skills.prepare', { id: 'order-query' })).rejects.toThrow(message)
    expect(prepareSkill).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it.each([
    ['desktop version', { minimumDesktopVersion: '9.0.0' }, {}, 'requires desktop'],
    ['Skill', { skillIds: ['missing-skill'] }, {}, 'requires unavailable Skill'],
    ['data connection', { connectorRefs: ['missing-connector'] }, {}, 'requires unavailable data connection'],
    ['tool', { connectorRefs: ['erp'], requiredTools: ['missing-tool'] }, {
      '/api/v1/connectors': [{ id: 'erp', ready: true, tools: [{ name: 'orders.get' }] }],
    }, 'requires unavailable tool'],
    ['knowledge base', { knowledgeBaseRefs: ['organization:missing'] }, {}, 'requires unavailable knowledge'],
  ] as const)('blocks an Expert Kit with an unavailable %s dependency', async (_label, overrides, extra, message) => {
    const prepareExpertKit = vi.fn(() => Promise.resolve('must-not-run'))
    const kit = { id: 'order-expert', version: '1.0.0', sha256: 'd'.repeat(64),
      skillIds: [], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [], ...overrides }
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '1.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, prepareExpertKit,
      fetch: catalogTransport({ ...immutableCatalog, '/api/v1/expert-kits': [kit], ...extra }),
    })

    await expect(bridge.invoke('expertKits.preset.prepare', { id: 'order-expert' })).rejects.toThrow(message)
    expect(prepareExpertKit).not.toHaveBeenCalled()
    bridge.dispose()
  })
})
