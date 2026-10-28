import { describe, expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'
import { DingTalkAuthorizationTimeoutError, ensureDingTalkSession } from '../src/dingtalk-auth.ts'
import { ProductError } from '../src/errors.ts'
import { isProductMethod, isProductRuntimeMethod, type ProductEvent } from '../src/protocol.ts'

const immutableCatalog = {
  '/api/v1/connectors': [],
  '/api/v1/knowledge-bases': [],
} as const

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
}

function catalogFetch(input: Parameters<typeof fetch>[0]): Promise<Response> {
  const url = requestUrl(input)
  const data = immutableCatalog[url.pathname as keyof typeof immutableCatalog] ?? []
  return Promise.resolve(Response.json({ success: true, data, pageIndex: 1, pageSize: 100,
    totalCount: data.length, totalPages: data.length === 0 ? 0 : 1 }))
}

function catalogTransport(catalog: Readonly<Record<string, readonly unknown[]>>): typeof fetch {
  return (input) => {
    const url = requestUrl(input)
    const path = url.pathname.startsWith('/root/api/') ? url.pathname.slice('/root'.length) : url.pathname
    const connector = /^\/api\/v1\/connectors\/([^/]+)\/configuration-template$/.exec(path)
    if (connector) {
      const data = catalog['/api/v1/connectors']?.find(entry => typeof entry === 'object' && entry !== null
        && 'id' in entry && entry.id === decodeURIComponent(connector[1]!))
      return Promise.resolve(data === undefined
        ? Response.json({ success: false, errCode: 'CONNECTOR_NOT_FOUND' }, { status: 404 })
        : Response.json({ success: true, data }))
    }
    const data = catalog[path] ?? []
    return Promise.resolve(Response.json({ success: true, data, pageIndex: 1, pageSize: 100,
      totalCount: data.length, totalPages: data.length === 0 ? 0 : 1 }))
  }
}

describe('DeepSeekHarnessProductBridge', () => {
  it('does not expose the removed device-state read operation', () => {
    expect(isProductMethod('support.device.read')).toBe(false)
    expect(isProductMethod('support.device.report')).toBe(true)
  })

  it.each(['extensions.save', 'extensions.submit',
    'extensions.connector.update', 'extensions.connector.delete'])(
    'returns committed %s without waiting for a stalled knowledge catalog', async (method) => {
      const started = Promise.withResolvers<undefined>()
      const committed = vi.fn(async () => ({ committed: true }))
      let stalled = false
      const bridge = new DeepSeekHarnessProductBridge({
        serverUrl: 'https://deepseek-harness.test', connectorManagement: committed,
        sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
        fetch: async (input, init) => {
          if (stalled && requestUrl(input).pathname === '/api/v1/knowledge-bases') {
            started.resolve(undefined)
            return new Promise((_resolve, reject) => {
              const signal = init?.signal
              if (!signal) { reject(new Error('Missing request cancellation')); return }
              if (signal.aborted) reject(new Error('Catalog cancelled', { cause: signal.reason }))
              else signal.addEventListener('abort', () => { reject(new Error('Catalog cancelled', { cause: signal.reason })) }, { once: true })
            })
          }
          return catalogFetch(input)
        },
      })
      const controller = new AbortController()
      const events: ProductEvent[] = []
      bridge.subscribe(event => events.push(event))
      try {
        await bridge.refreshCatalog()
        stalled = true
        let observed: unknown
        const result = bridge.invoke(method, { kind: 'connector', id: 'document-insight', version: '1.0.0' }, controller.signal)
          .then((value) => { observed = value }, (error: unknown) => { observed = error })
        await started.promise
        await vi.waitFor(() => { expect(observed).toEqual({ committed: true }) })
        expect(events).toContainEqual({ type: 'catalog.changed' })
        await result
        await bridge.dispose()
      } finally { controller.abort(); await bridge.dispose() }
    },
  )

  it('dispatches personal library creation and limits through authenticated knowledge APIs', async () => {
    const created = { id: 'personal-1', name: 'My files', scope: 'PERSONAL', canManage: true }
    const limits = { previewMaxBytes: 50_000_000, downloadMaxBytes: 250_000_000, uploadMaxBytes: 50_000_000 }
    const fetch = vi.fn((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.pathname === '/api/v1/knowledge-file-limits') return Promise.resolve(Response.json({ success: true, data: limits }))
      if (url.pathname === '/api/v1/knowledge-bases' && init?.method === 'POST') {
        return Promise.resolve(Response.json({ success: true, data: created }))
      }
      return catalogFetch(input)
    })
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test', fetch,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' } })
    try {
      await expect(bridge.invoke('knowledge.files.limits', {})).resolves.toEqual(limits)
      await expect(bridge.invoke('knowledge.bases.create', { name: 'My files', operationId: 'personal-create-123456' })).resolves.toEqual(created)
      const creation = fetch.mock.calls.find(([input, init]) => requestUrl(input).pathname.endsWith('/knowledge-bases') && init?.method === 'POST')
      expect(creation).toBeDefined()
      if (creation === undefined) throw new Error('Missing personal creation request')
      const body = creation[1]?.body
      if (typeof body !== 'string') throw new Error('Missing personal creation body')
      expect(JSON.parse(body)).toEqual({ name: 'My files', description: '', scope: 'PERSONAL' })
      expect(new Headers(creation[1]?.headers).get('x-deepseek-harness-employee-id')).toBe('employee-1')
      expect(isProductRuntimeMethod('knowledge.bases.create')).toBe(false)
      expect(isProductRuntimeMethod('knowledge.files.limits')).toBe(false)
    } finally { await bridge.dispose() }
  })

  it('dispatches personal library deletion and tolerates a catalog refresh outage', async () => {
    const fetch = vi.fn((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.pathname === '/api/v1/knowledge-bases/mine' && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.reject(new Error('catalog offline'))
    })
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test', fetch,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' } })
    try {
      await expect(bridge.invoke('knowledge.bases.delete', { knowledgeBaseId: 'mine' })).resolves.toBeUndefined()
      expect(fetch.mock.calls.some(([input, init]) => requestUrl(input).pathname.endsWith('/knowledge-bases/mine') && init?.method === 'DELETE')).toBe(true)
    } finally { await bridge.dispose() }
  })
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

  it.each([
    'native.filesystem.list',
    'native.filesystem.read',
    'native.filesystem.write',
    'native.secure-storage.get',
    'native.secure-storage.set',
    'native.secure-storage.delete',
    'native.sqlite.query',
    'native.sqlite.execute',
    'native.dingtalk-auth.state',
    'native.attachments.put',
    'native.attachments.get',
    'native.attachments.list',
    'native.file-undo.record',
    'native.file-undo.undo',
    'native.image-preview.inspect',
  ])('rejects retired %s before dispatching native work', async (method) => {
    const nativeInvoke = vi.fn(async () => ({ ready: true }))
    const bridge = new DeepSeekHarnessProductBridge({ nativeInvoke })
    expect(isProductMethod(method)).toBe(false)
    expect(isProductRuntimeMethod(method)).toBe(false)
    await expect(bridge.invoke(method, {})).rejects.toThrow('unsupported method')
    expect(nativeInvoke).not.toHaveBeenCalled()
  })

  it('routes device identity through the main-process dispatcher', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const bridge = new DeepSeekHarnessProductBridge({
      nativeInvoke: (method, payload) => { calls.push({ method, payload }); return Promise.resolve({ ready: true }) },
    })
    await expect(bridge.invoke('native.device-identity.get', { scope: 'employee' })).resolves.toEqual({ ready: true })
    expect(calls).toEqual([{ method: 'device-identity.get', payload: { scope: 'employee' } }])
  })

  it('does not publish a delayed connector save result to another employee', async () => {
    let settle: (() => void) | undefined
    let requestSignal: AbortSignal | undefined
    const fetch = vi.fn(catalogFetch)
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test', fetch,
      sessionToken: 'first-token', initialSession: { authenticated: true, employeeId: 'employee-1' },
      connectorManagement: async (_method, _payload, _api, _identity, signal) => {
        requestSignal = signal
        await new Promise<void>((resolve) => { settle = resolve })
        throw new ProductError('EXTENSION_INSTALL_FAILED', 'Saved before the identity change', true)
      },
    })
    const events: ProductEvent[] = []
    bridge.subscribe(event => events.push(event))
    const pending = bridge.invoke('extensions.save', { kind: 'connector' })
    const rejected = expect(pending).rejects.toThrow()
    try {
      await vi.waitFor(() => { expect(settle).toBeDefined() })
      bridge.setSession({ authenticated: true, employeeId: 'employee-2' }, 'second-token')
      await bridge.refreshCatalog()
      events.length = 0
      const requests = fetch.mock.calls.length
      expect(requestSignal?.aborted).toBe(true)
      settle?.()
      await rejected
      expect(events).toEqual([])
      expect(fetch).toHaveBeenCalledTimes(requests)
    } finally { settle?.(); await bridge.dispose() }
  })

  it('requires an authenticated employee before preparing knowledge access', async () => {
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', taskCapabilities: vi.fn(),
    })
    await expect(bridge.invoke('tasks.capabilities.prepare', { knowledgeBaseIds: ['orders'] }))
      .rejects.toThrow('Employee authentication is required')
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
        if (url.endsWith('/authorization-requests')) return Promise.resolve(Response.json({ success: true,
          data: { state: 'state-12345678', authorizationUrl: 'https://login.example.test/dingtalk' } }))
        expect(url).toContain('/api/v1/dingtalk-auth/authorization-requests/state-12345678')
        return Promise.resolve(Response.json({ success: true, data: { status: 'pending', session: null } }))
      },
    })

    await bridge.invoke('auth.beginDingTalk')
    await expect(bridge.invoke('auth.pollDingTalk', { state: 'state-12345678' }))
      .resolves.toEqual({ status: 'pending', session: null })
    expect(bridge.getSession()).toEqual({ authenticated: false })
    await bridge.dispose()
  })

  it('keeps the completed DingTalk employee token outside the Renderer response', async () => {
    const expiresAt = Math.floor(Date.now() / 1_000) + 1_800
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test',
      fetch: async input => new Request(input).url.endsWith('/authorization-requests')
        ? Response.json({ success: true, data: { state: 'state-12345678', authorizationUrl: 'https://login.example.test/dingtalk' } })
        : Response.json({ success: true, data: {
          status: 'authorized', session: { sessionToken: 'private-employee-token', expiresAt,
            employee: { employeeId: 'employee-1', employeeName: 'Employee' } }, extraSecret: 'private-employee-token',
        } }),
    })
    try {
      await bridge.invoke('auth.beginDingTalk')
      const result = await bridge.invoke('auth.pollDingTalk', { state: 'state-12345678' })
      expect(result).toEqual({ status: 'authorized', session: { authenticated: true,
        employeeId: 'employee-1', displayName: 'Employee', expiresAt: String(expiresAt) } })
      expect(JSON.stringify(result)).not.toContain('private-employee-token')
    } finally { await bridge.dispose() }
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

  it.each([{ models: [] }, { models: [''] }, { models: ['deepseek-v4-flash', 'deepseek-v4-flash'] },
    { models: ['model\nforged'] }, { models: [' model'] }])('rejects malformed inference model catalogs: %j', async ({ models }) => {
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      fetch: () => Promise.resolve(Response.json({ success: true, data: {
        modelApiKey: 'virtual-key', endpoints: { litellm: 'https://models.example.test/v1' }, models,
      } })),
    })
    await expect(bridge.loadRuntimeBootstrap()).rejects.toThrow('invalid runtime bootstrap')
    await bridge.dispose()
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
    await expect(client.listAll<{ id: string }>('/api/v1/connectors', 1)).resolves.toEqual([{ id: 'one' }, { id: 'two' }])
    expect(requested.map(url => new URL(url).searchParams.get('page'))).toEqual(['1', '2'])
  })

  it('fails when a catalog page omits pagination metadata', async () => {
    const client = new DeepSeekHarnessApiClient({
      baseUrl: 'https://deepseek-harness.test',
      getSessionToken: () => undefined,
      fetch: () => Promise.resolve(new Response(JSON.stringify({ success: true, data: [{ id: 'one' }] }), { status: 200 })),
    })
    await expect(client.listAll('/api/v1/connectors')).rejects.toMatchObject({ code: 'INVALID_PAGE_RESPONSE', status: 502 })
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

  it('discovers only requested runtime connectors and rejects invalid selection without disclosing credentials', async () => {
    const connector = { id: 'erp', name: 'ERP', status: 'ready', authMode: 'none', transport: 'streamable-http',
      url: 'https://example.test/mcp', headers: {}, arguments: [], environment: {}, tools: [{ name: 'read', access: 'READ' }] }
    const enrich = vi.fn(async (value: unknown) => value)
    const fetch = vi.fn(catalogTransport({ ...immutableCatalog, '/api/v1/connectors': [connector, { ...connector, id: 'stalled' }] }))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-secret',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, connectorRuntime: enrich,
      fetch,
    })
    try {
      await expect(bridge.invokeRuntime('connectors.list', { ids: ['erp'] })).resolves.toEqual([expect.objectContaining({ id: 'erp' })])
      expect(enrich).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'erp' })], expect.any(AbortSignal), true)
      expect(fetch.mock.calls.map(([input]) => requestUrl(input).pathname)).toEqual(['/api/v1/connectors/erp/configuration-template'])
      await bridge.invoke('connectors.list')
      expect(enrich).toHaveBeenLastCalledWith(expect.any(Array), expect.any(AbortSignal), false)
      await bridge.readConnectorTransports(['erp'], new AbortController().signal)
      expect(enrich).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'erp' })], expect.any(AbortSignal), false)
      const reads = fetch.mock.calls.length
      await expect(bridge.invokeRuntime('connectors.list', { ids: [] })).resolves.toEqual([])
      await expect(bridge.invokeRuntime('connectors.list', { ids: 'erp' })).rejects.toThrow()
      expect(fetch.mock.calls).toHaveLength(reads)
      await expect(bridge.invokeRuntime('connectors.list', { ids: ['missing'] })).resolves.toEqual([])
    } finally { await bridge.dispose() }
  })

  it.each([
    { status: 403, code: 'CONNECTOR_ACCESS_DENIED' },
    { status: 503, code: 'EXTERNAL_SERVICE_ERROR' },
  ])('does not treat a $status connector query failure as an empty directory', async ({ status, code }) => {
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test',
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: async () => Response.json({ success: false, errCode: code }, { status }) })
    try { await expect(bridge.invokeRuntime('connectors.list', { ids: ['erp'] })).rejects.toMatchObject({ code }) }
    finally { await bridge.dispose() }
  })

  it('rejects a connector detail returned for another resource', async () => {
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test',
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: async () => Response.json({ success: true, data: { id: 'unrelated' } }) })
    try { await expect(bridge.invokeRuntime('connectors.list', { ids: ['erp'] })).rejects.toThrow() }
    finally { await bridge.dispose() }
  })

  it('adds the employee bearer only to Host runtime connector metadata', async () => {
    const connector = { id: 'erp', version: '1.0.0', name: 'ERP', status: 'ready', ready: true,
      authorizationStatus: 'AUTHORIZED', authMode: 'oauth', transport: 'streamable-http',
      url: '/api/v1/connectors/erp/mcp', headers: { 'x-connector-key': 'private-connector-key' }, arguments: [], environment: {},
      tools: [{ name: 'orders.get', access: 'READ' }] }
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test/root', sessionToken: 'employee-secret',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: catalogTransport({ ...immutableCatalog, '/api/v1/connectors': [connector] }),
    })

    const renderer = await bridge.invoke('connectors.list')
    expect(JSON.stringify(renderer)).not.toContain('employee-secret')
    expect(JSON.stringify(renderer)).not.toContain('private-connector-key')
    const { url: _url, headers: _headers, arguments: _arguments, environment: _environment, ...metadata } = connector
    expect(renderer).toEqual([metadata])

    const runtime = await bridge.invokeRuntime('connectors.list')
    expect(runtime).toEqual([{ ...connector,
      url: 'https://deepseek-harness.test/root/api/v1/connectors/erp/mcp',
      headers: { 'x-connector-key': 'private-connector-key', Authorization: 'Bearer employee-secret', 'X-Harness-Connector-Version': '1.0.0' } }])
    await bridge.dispose()
  })

  it.each(['connectors.authorization.status', 'connectors.authorization.revoke'])(
    'returns the authoritative %s result when a dependent directory is unavailable', async (method) => {
      let offline = false
      const events: ProductEvent[] = []
      const bridge = new DeepSeekHarnessProductBridge({
        serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
        initialSession: { authenticated: true, employeeId: 'employee-1' },
        fetch: (input) => {
          const path = requestUrl(input).pathname
          if (path.endsWith('/authorization')) return Promise.resolve(Response.json({ success: true,
            data: { connectorId: 'erp', status: method.endsWith('.revoke') ? 'REQUIRED' : 'AUTHORIZED' } }))
          if (offline && path.endsWith('/knowledge-bases')) return Promise.resolve(Response.json({ success: false,
            errCode: 'ORGANIZATION_UNAVAILABLE', errMessage: 'Organization service unavailable' }, { status: 503 }))
          return catalogFetch(input)
        },
      })
      bridge.subscribe((event) => { events.push(event) })
      try {
        await bridge.refreshCatalog()
        events.length = 0
        offline = true
        await expect(bridge.invoke(method, { id: 'erp' })).resolves.toEqual({
          connectorId: 'erp', status: method.endsWith('.revoke') ? 'REQUIRED' : 'AUTHORIZED',
        })
        expect(events.some(event => event.type === 'catalog.changed')).toBe(true)
        await expect(bridge.invoke('catalog.refresh')).rejects.toMatchObject({ code: 'ORGANIZATION_UNAVAILABLE' })
        await expect(bridge.invoke('connectors.list')).resolves.toEqual(expect.any(Array))
      } finally { await bridge.dispose() }
    },
  )

  it('returns a committed revocation before a stalled refresh and drains it during disposal', async () => {
    let finishRefresh: (() => void) | undefined
    let refreshSettled = false
    const refreshStarted = new Promise<void>((resolve) => { finishRefresh = resolve })
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: async (input, init) => {
        const path = requestUrl(input).pathname
        if (path.endsWith('/authorization')) return Response.json({ success: true, data: { connectorId: 'erp', status: 'REQUIRED' } })
        if (!path.endsWith('/knowledge-bases')) return catalogFetch(input)
        const signal = init?.signal
        if (!signal) throw new Error('Missing refresh cancellation')
        signal.throwIfAborted()
        finishRefresh?.()
        try {
          return await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('Catalog refresh aborted'))
            }, { once: true })
          })
        } finally { refreshSettled = true }
      },
    })
    try {
      await expect(bridge.invoke('connectors.authorization.revoke', { id: 'erp' })).resolves.toEqual({ connectorId: 'erp', status: 'REQUIRED' })
      await refreshStarted
      expect(refreshSettled).toBe(false)
    } finally { await bridge.dispose() }
    expect(refreshSettled).toBe(true)
  })

  it('preserves authorization failures without publishing a catalog change', async () => {
    const events: ProductEvent[] = []
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: async () => Response.json({ success: false, errCode: 'CONNECTOR_FORBIDDEN', errMessage: 'Access denied' }, { status: 403 }),
    })
    bridge.subscribe((event) => { events.push(event) })
    try {
      await expect(bridge.invoke('connectors.authorization.revoke', { id: 'erp' })).rejects.toMatchObject({ code: 'CONNECTOR_FORBIDDEN' })
      expect(events).toEqual([])
    } finally { await bridge.dispose() }
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
          return Response.json({ success: true, data: { connectorId: 'erp', status: 'PENDING', authorizationUrl: 'https://login.example' } })
        }
        if (path.endsWith('/authorization')) {
          return Response.json({ success: true, data: { connectorId: 'erp', status: request.method === 'DELETE' ? 'REQUIRED' : 'AUTHORIZED' } })
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
    expect(requests).toHaveLength(7)
    await bridge.dispose()
  })

  it('rechecks knowledge visibility on every read and rejects outages without cached grants', async () => {
    let knowledge = [{ id: 'department-sales', scope: 'DEPARTMENT' }]
    let fail = false
    const calls: string[] = []
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        calls.push(path)
        if (path === '/api/v1/knowledge-bases' && fail) return Promise.reject(new TypeError('directory unavailable'))
        return catalogTransport({ ...immutableCatalog, '/api/v1/knowledge-bases': knowledge })(input, init)
      },
    })
    await bridge.invoke('catalog.refresh')
    await expect(bridge.invoke('knowledge.bases.list')).resolves.toMatchObject([{ id: 'department-sales' }])
    knowledge = [{ id: 'department-support', scope: 'DEPARTMENT' }]
    await expect(bridge.invoke('knowledge.bases.list')).resolves.toMatchObject([{ id: 'department-support' }])
    fail = true
    await expect(bridge.invoke('knowledge.bases.list')).rejects.toMatchObject({ code: 'PRODUCT_NETWORK_UNAVAILABLE' })
    expect(calls.filter(path => path === '/api/v1/knowledge-bases')).toHaveLength(4)
    await bridge.dispose()
  })

  it('cancels only the requested refresh and awaits background HTTP settlement during disposal', async () => {
    const pending: { signal: AbortSignal; finish: () => void; cancel: (() => void) | undefined }[] = []
    const events: string[] = []
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: (input, init) => {
        const signal = init?.signal
        if (signal == null) throw new Error('HTTP cancellation signal is required')
        const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
        return new Promise<Response>((resolve, reject) => {
          const request: (typeof pending)[number] = { signal, finish: () => {
            const data = immutableCatalog[path as keyof typeof immutableCatalog] ?? []
            resolve(Response.json({ success: true, data, pageIndex: 1, pageSize: 100,
              totalCount: data.length, totalPages: data.length === 0 ? 0 : 1 }))
          }, cancel: undefined }
          signal.addEventListener('abort', () => {
            request.cancel = () => {
              const reason: unknown = signal.reason
              reject(reason instanceof Error ? reason : new Error('HTTP request cancelled'))
            }
          }, { once: true })
          pending.push(request)
        })
      },
    })
    bridge.subscribe((event) => { events.push(event.type) })
    const controller = new AbortController()
    const first = bridge.invoke('catalog.refresh', undefined, controller.signal)
    const firstCancelled = expect(first).rejects.toThrow('Cancel first refresh')
    const second = bridge.invoke('catalog.refresh', undefined, new AbortController().signal)
    await vi.waitFor(() => { expect(pending).toHaveLength(4) })
    controller.abort(new Error('Cancel first refresh'))
    expect(pending.slice(2).every(request => !request.signal.aborted)).toBe(true)
    pending.slice(0, 2).forEach((request) => { request.cancel?.() })
    pending.slice(2).forEach((request) => { request.finish() })
    await firstCancelled
    await second
    expect(events).toEqual(['catalog.changed'])
    const background = bridge.refreshCatalog()
    // Nested abort signals report either owner's disposal reason across supported Node versions.
    const backgroundCancelled = expect(background).rejects.toThrow(/^Product (?:bridge closed|catalog has been disposed)$/u)
    await vi.waitFor(() => { expect(pending).toHaveLength(6) })
    let disposed = false
    const disposal = bridge.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(pending.slice(4).every(request => request.signal.aborted)).toBe(true)
    pending.slice(4).forEach((request) => { request.cancel?.() })
    await backgroundCancelled
    await disposal
    expect(disposed).toBe(true)
    expect(events).toEqual(['catalog.changed'])
    await expect(bridge.refreshCatalog()).rejects.toThrow('Product catalog has been disposed')
    expect(pending).toHaveLength(6)
  })
})
