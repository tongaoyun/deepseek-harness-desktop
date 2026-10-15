import { describe, expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'
import { DingTalkAuthorizationTimeoutError, ensureDingTalkSession } from '../src/dingtalk-auth.ts'
import { ProductError } from '../src/errors.ts'
import { compareVersions } from '../src/catalog-manager.ts'
import { isProductMethod, isProductRuntimeMethod, type ProductEvent } from '../src/protocol.ts'

const immutableCatalog = {
  '/api/v1/expert-kits': [{ id: 'order-expert', version: '1.0.0', sha256: 'a'.repeat(64),
    skillIds: [], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] }],
  '/api/v1/skills': [{ id: 'document-insight', version: '1.0.0', sha256: 'b'.repeat(64),
    connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] }],
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
    const data = catalog[path] ?? []
    return Promise.resolve(Response.json({ success: true, data, pageIndex: 1, pageSize: 100,
      totalCount: data.length, totalPages: data.length === 0 ? 0 : 1 }))
  }
}

describe('DeepSeekHarnessProductBridge', () => {
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

  it('compares minimum desktop versions using semantic prerelease ordering', () => {
    expect(compareVersions('0.2.0-rc.2', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.1')).toBeGreaterThan(0)
    expect(() => compareVersions('0.2.0', 'invalid')).toThrow('semantic version')
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

  it.each(['extensions.save', 'extensions.submit', 'extensions.delete', 'extensions.connector.update', 'extensions.connector.delete'])(
    'preserves committed %s results when the following catalog refresh fails', async (method) => {
      let offline = false
      const authoring = vi.fn(() => Promise.resolve({ committed: true }))
      const bridge = new DeepSeekHarnessProductBridge({
        serverUrl: 'https://deepseek-harness.test', authoring,
        sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
        fetch: input => offline ? Promise.reject(new Error('Catalog unavailable')) : catalogFetch(input),
      })
      try {
        await expect(bridge.invoke('skills.list')).resolves.toHaveLength(1)
        offline = true
        await expect(bridge.invoke(method, { kind: 'skill', id: 'document-insight', version: '1.0.0' }))
          .resolves.toEqual({ committed: true })
        expect(authoring).toHaveBeenCalledTimes(1)
        await expect(bridge.invoke('skills.list')).rejects.toThrow('Catalog unavailable')
      } finally { await bridge.dispose() }
    },
  )

  it('routes allowlisted native capabilities through the main-process dispatcher', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const bridge = new DeepSeekHarnessProductBridge({
      nativeInvoke: (method, payload) => { calls.push({ method, payload }); return Promise.resolve({ ready: true }) },
    })
    await expect(bridge.invoke('native.device-identity.get', { scope: 'employee' })).resolves.toEqual({ ready: true })
    expect(calls).toEqual([{ method: 'device-identity.get', payload: { scope: 'employee' } }])
  })

  it('refreshes committed content and authoring state after a device installation failure', async () => {
    let reads = 0
    const failure = new ProductError('EXTENSION_INSTALL_FAILED', 'Saved, but installation failed', true)
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test',
      sessionToken: 'private-token', initialSession: { authenticated: true, employeeId: 'employee-1' },
      authoring: async () => { throw failure },
      fetch: (input) => { reads++; return catalogFetch(input) },
    })
    const events: ProductEvent[] = []
    bridge.subscribe(event => events.push(event))
    try {
      await bridge.invoke('skills.list')
      const before = reads
      await expect(bridge.invoke('extensions.authoring.save', { sessionId: 'creation', revision: 1 })).rejects.toBe(failure)
      expect(reads).toBeGreaterThan(before)
      expect(events).toContainEqual({ type: 'authoring.changed', payload: { sessionId: 'creation' } })
      expect(events).toContainEqual(expect.objectContaining({ type: 'catalog.changed' }))
    } finally { await bridge.dispose() }
  })

  it('does not publish a delayed authoring result to another employee', async () => {
    let settle: (() => void) | undefined
    let requestSignal: AbortSignal | undefined
    const fetch = vi.fn(catalogFetch)
    const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test', fetch,
      sessionToken: 'first-token', initialSession: { authenticated: true, employeeId: 'employee-1' },
      authoring: async (_method, _payload, _api, _identity, signal) => {
        requestSignal = signal
        await new Promise<void>((resolve) => { settle = resolve })
        throw new ProductError('EXTENSION_INSTALL_FAILED', 'Saved before the identity change', true)
      },
    })
    const events: ProductEvent[] = []
    bridge.subscribe(event => events.push(event))
    const pending = bridge.invoke('extensions.authoring.save', { sessionId: 'first-creation', revision: 1 })
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

  it('prepares an Expert Kit through the task runtime with its captured Session and cancellation', async () => {
    const result = { kind: 'CURRENT_SESSION', presetId: 'product-task-fixture', dependencyChecks: [] }
    const taskCapabilities = vi.fn(() => Promise.resolve(result))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', taskCapabilities,
      sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: catalogFetch,
    })

    const signal = new AbortController().signal
    const request = { sessionId: 'source-session', expertKitId: 'order-expert' }
    await expect(bridge.invoke('tasks.capabilities.prepare', request, signal)).resolves.toEqual(result)
    expect(taskCapabilities).toHaveBeenCalledExactlyOnceWith('prepare', request, expect.any(AbortSignal))
    await expect(bridge.invoke('expertKits.preset.prepare', { id: 'order-expert' })).rejects.toThrow('unsupported method')
    await bridge.dispose()
  })

  it('requires an authenticated employee before preparing an Expert Kit Preset', async () => {
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', taskCapabilities: vi.fn(),
    })
    await expect(bridge.invoke('tasks.capabilities.prepare', { expertKitId: 'order-expert' }))
      .rejects.toThrow('Employee authentication is required')
  })

  it('installs one Skill through the Host without preparing a Session', async () => {
    const installedSkills = vi.fn(() => Promise.resolve({ id: 'document-insight', version: '1.0.0', sha256: 'b'.repeat(64) }))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', installedSkills,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: catalogFetch,
    })

    await expect(bridge.invoke('skills.install', { id: 'document-insight' }))
      .resolves.toEqual({
        id: 'document-insight', version: '1.0.0', sha256: 'b'.repeat(64),
      })
    expect(installedSkills).toHaveBeenCalledExactlyOnceWith('install', { id: 'document-insight' }, expect.any(AbortSignal))
    await expect(bridge.invoke('skills.prepare', { id: 'document-insight' })).rejects.toThrow()
    await bridge.dispose()
  })

  it('uninstalls device Skills without requiring a visible resource or an available server', async () => {
    const installedSkills = vi.fn((operation: 'install' | 'uninstall' | 'read') =>
      Promise.resolve(operation === 'read' ? { installed: [], available: [], frozen: false } : { id: 'hidden-skill' }))
    const taskCapabilities = vi.fn()
    const authoring = vi.fn()
    const fetch = vi.fn(() => Promise.reject(new Error('Server unavailable')))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', installedSkills, taskCapabilities, authoring, fetch,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
    })
    const events: ProductEvent[] = []
    bridge.subscribe(event => events.push(event))
    try {
      await expect(bridge.invoke('skills.installed.read')).resolves.toEqual({ installed: [], available: [], frozen: false })
      await expect(bridge.invoke('skills.uninstall', { id: 'hidden-skill' })).resolves.toEqual({ id: 'hidden-skill' })
      expect(installedSkills.mock.calls).toEqual([
        ['read', {}, expect.any(AbortSignal)], ['uninstall', { id: 'hidden-skill' }, expect.any(AbortSignal)],
      ])
      expect(events).toEqual([{ type: 'catalog.changed' }])
      expect(fetch).not.toHaveBeenCalled()
      expect(taskCapabilities).not.toHaveBeenCalled()
      expect(authoring).not.toHaveBeenCalled()
      expect(isProductMethod('skills.uninstall')).toBe(true)
      expect(isProductRuntimeMethod('skills.uninstall')).toBe(false)
    } finally { await bridge.dispose() }
  })

  it.each(['skills.install', 'skills.uninstall', 'skills.installed.read'] as const)(
    'requires employee authentication for %s', async (method) => {
      const installedSkills = vi.fn()
      const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test', installedSkills })
      try {
        await expect(bridge.invoke(method, { id: 'document-insight' })).rejects.toThrow('Employee authentication is required')
        expect(installedSkills).not.toHaveBeenCalled()
      } finally { await bridge.dispose() }
    },
  )

  it('requires a Skill resource ID before uninstalling', async () => {
    const installedSkills = vi.fn()
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', installedSkills,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
    })
    try {
      await expect(bridge.invoke('skills.uninstall')).rejects.toThrow('a valid product id is required')
      expect(installedSkills).not.toHaveBeenCalled()
    } finally { await bridge.dispose() }
  })

  it('retains failed Skill uninstalls without emitting a catalog commit event', async () => {
    const failure = new ProductError('PRODUCT_REQUEST_CANCELLED', 'Cancelled', true)
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test',
      installedSkills: () => Promise.reject(failure), sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
    })
    const listener = vi.fn()
    bridge.subscribe(listener)
    try {
      await expect(bridge.invoke('skills.uninstall', { id: 'document-insight' })).rejects.toBe(failure)
      expect(listener).not.toHaveBeenCalled()
    } finally { await bridge.dispose() }
  })

  it.each(['skills.install', 'skills.uninstall', 'skills.installed.read'] as const)(
    'cancels pending %s when the authenticated employee changes', async (method) => {
      let serverUnavailable = false
      const operation = vi.fn((_operation: string, _payload: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
        new Promise<unknown>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
          }, { once: true })
        }))
      const bridge = new DeepSeekHarnessProductBridge({
        serverUrl: 'https://deepseek-harness.test', installedSkills: operation,
        sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
        fetch: input => serverUnavailable ? Promise.reject(new Error('Server unavailable')) : catalogFetch(input),
      })
      const events: ProductEvent[] = []
      bridge.subscribe(event => events.push(event))
      try {
        const pending = bridge.invoke(method, { id: 'document-insight' })
        const rejected = expect(pending).rejects.toThrow('Product employee identity changed')
        await vi.waitFor(() => { expect(operation).toHaveBeenCalledTimes(1) })
        events.length = 0
        serverUnavailable = true
        bridge.setSession({ authenticated: true, employeeId: 'employee-2' }, 'other-employee-session')
        await rejected
        expect(operation.mock.calls[0]?.[2]?.aborted).toBe(true)
        expect(events.filter(event => event.type === 'catalog.changed')).toHaveLength(0)
      } finally { await bridge.dispose() }
    },
  )

  it('forwards caller cancellation and suppresses a cancelled Skill uninstall commit event', async () => {
    const cancellation = new Error('Caller cancelled')
    const controller = new AbortController()
    const installedSkills = vi.fn((_operation: string, _payload: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
      new Promise<unknown>((resolve) => {
        signal?.addEventListener('abort', () => { resolve({ id: 'document-insight' }) }, { once: true })
      }))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', installedSkills,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
    })
    const listener = vi.fn()
    bridge.subscribe(listener)
    try {
      const pending = bridge.invoke('skills.uninstall', { id: 'document-insight' }, controller.signal)
      const rejected = expect(pending).rejects.toBe(cancellation)
      await vi.waitFor(() => { expect(installedSkills).toHaveBeenCalledTimes(1) })
      controller.abort(cancellation)
      await rejected
      expect(listener).not.toHaveBeenCalled()
    } finally { await bridge.dispose() }
  })

  it('cancels the remote installation check before dispatching a Skill to Host', async () => {
    const cancellation = new Error('Installation cancelled')
    const controller = new AbortController()
    const installedSkills = vi.fn()
    const fetch = vi.fn((_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('Cancelled'))
        }, { once: true })
      }))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', installedSkills, fetch,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
    })
    const listener = vi.fn()
    bridge.subscribe(listener)
    try {
      const pending = bridge.invoke('skills.install', { id: 'document-insight' }, controller.signal)
      const rejected = expect(pending).rejects.toBe(cancellation)
      await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1) })
      controller.abort(cancellation)
      await rejected
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
      expect(installedSkills).not.toHaveBeenCalled()
      expect(listener).not.toHaveBeenCalled()
    } finally { await bridge.dispose() }
  })

  it('routes device Kit installation, inspection, and uninstall without preparing tasks or deleting resources', async () => {
    const kit = { id: 'order-expert', version: '1.0.0', sha256: 'a'.repeat(64) }
    const installedExpertKits = vi.fn((operation: 'install' | 'uninstall' | 'read') =>
      Promise.resolve(operation === 'read' ? { installed: [kit] } : operation === 'install' ? kit : { id: kit.id }))
    const taskCapabilities = vi.fn()
    const authoring = vi.fn()
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', installedExpertKits, taskCapabilities, authoring,
      sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
      fetch: vi.fn(() => Promise.reject(new Error('Server unavailable'))),
    })
    const events: unknown[] = []
    bridge.subscribe(event => events.push(event))
    const signal = new AbortController().signal
    await expect(bridge.invoke('expertKits.install', { id: kit.id }, signal)).resolves.toEqual(kit)
    await expect(bridge.invoke('expertKits.installed.read')).resolves.toEqual({ installed: [kit] })
    await expect(bridge.invoke('expertKits.uninstall', { id: kit.id }, signal)).resolves.toEqual({ id: kit.id })
    expect(installedExpertKits.mock.calls).toEqual([
      ['install', { id: kit.id }, expect.any(AbortSignal)], ['read', {}, expect.any(AbortSignal)],
      ['uninstall', { id: kit.id }, expect.any(AbortSignal)],
    ])
    expect(events).toEqual([{ type: 'catalog.changed' }, { type: 'catalog.changed' }])
    expect(taskCapabilities).not.toHaveBeenCalled()
    expect(authoring).not.toHaveBeenCalled()
    await bridge.dispose()
  })

  it.each(['expertKits.install', 'expertKits.uninstall', 'expertKits.installed.read'] as const)(
    'requires employee authentication for %s', async (method) => {
      const installedExpertKits = vi.fn()
      const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://deepseek-harness.test', installedExpertKits })
      await expect(bridge.invoke(method, { id: 'order-expert' })).rejects.toThrow('Employee authentication is required')
      expect(installedExpertKits).not.toHaveBeenCalled()
      await bridge.dispose()
    },
  )

  it('retains failed Kit uninstalls without emitting a catalog commit event', async () => {
    const failure = new ProductError('PRODUCT_REQUEST_CANCELLED', 'Cancelled', true)
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test',
      installedExpertKits: () => Promise.reject(failure), sessionToken: 'employee-session',
      initialSession: { authenticated: true, employeeId: 'employee-1' },
    })
    const listener = vi.fn()
    bridge.subscribe(listener)
    await expect(bridge.invoke('expertKits.uninstall', { id: 'order-expert' })).rejects.toBe(failure)
    expect(listener).not.toHaveBeenCalled()
    await bridge.dispose()
  })

  it.each(['expertKits.install', 'expertKits.uninstall', 'expertKits.installed.read', 'tasks.capabilities.prepare'] as const)(
    'cancels pending %s when the authenticated employee changes', async (method) => {
      const operation = vi.fn((_operation: string, _payload: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
        new Promise<unknown>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
          }, { once: true })
        }))
      const bridge = new DeepSeekHarnessProductBridge({
        serverUrl: 'https://deepseek-harness.test', installedExpertKits: operation, taskCapabilities: operation,
        sessionToken: 'employee-session', initialSession: { authenticated: true, employeeId: 'employee-1' },
        fetch: vi.fn(() => Promise.reject(new Error('Server unavailable'))),
      })
      const events: ProductEvent[] = []
      bridge.subscribe(event => events.push(event))
      try {
        const pending = bridge.invoke(method, { id: 'order-expert', sessionId: 'source-session' })
        const rejected = expect(pending).rejects.toThrow('Product employee identity changed')
        await vi.waitFor(() => { expect(operation).toHaveBeenCalledTimes(1) })
        bridge.setSession({ authenticated: true, employeeId: 'employee-2' }, 'other-employee-session')
        await rejected
        expect(operation.mock.calls[0]?.[2]?.aborted).toBe(true)
        expect(events.filter(event => event.type === 'catalog.changed')).toHaveLength(0)
      } finally { await bridge.dispose() }
    },
  )

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

    try {
      await expect(bridge.invoke('skills.list')).rejects.toMatchObject({ code: 'PRODUCT_NETWORK_UNAVAILABLE' })
      expect(bridge.getSession()).toMatchObject({ authenticated: true, employeeId: 'employee-1' })
    } finally { await bridge.dispose() }
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
    expect(connectors).toEqual([{ id: '/api/v1/connectors', availabilityStatus: 'AUTHORIZATION_REQUIRED', tools: [] }])
    expect(requests.sort()).toEqual([
      '/api/v1/connectors', '/api/v1/expert-kits', '/api/v1/knowledge-bases', '/api/v1/skills',
    ])
    expect(events).toEqual(['catalog.changed'])
    await bridge.dispose()
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

    await expect(bridge.invoke('catalog.refresh')).rejects.toMatchObject({ code: 'PRODUCT_NETWORK_UNAVAILABLE' })
    await expect(bridge.invoke('skills.list')).resolves.toEqual([
      { id: '/api/v1/skills', availabilityStatus: 'AVAILABLE' },
    ])
    expect(events).toEqual(['catalog.changed'])
    await bridge.dispose()
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
    await bridge.dispose()
  })

  it('adds the employee bearer only to Host runtime connector metadata', async () => {
    const connector = { id: 'erp', name: 'ERP', status: 'ready', ready: true,
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
    expect(renderer).toEqual([{ ...metadata, availabilityStatus: 'AVAILABLE' }])

    const runtime = await bridge.invokeRuntime('connectors.list')
    expect(runtime).toEqual([{ ...connector, availabilityStatus: 'AVAILABLE',
      url: 'https://deepseek-harness.test/root/api/v1/connectors/erp/mcp',
      headers: { 'x-connector-key': 'private-connector-key', Authorization: 'Bearer employee-secret' } }])
    await bridge.dispose()
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
    await bridge.dispose()
  })

  it('preserves the runtime dependency failure without catalog-based preparation', async () => {
    const failure = new ProductError('KIT_SKILL_MISSING', 'Missing bundled Skill', false,
      [{ kind: 'expert-kit', id: 'order-expert' }, { kind: 'skill', id: 'order-query' }],
      { dependencyChecks: [{ kind: 'SKILL', reference: 'order-query', status: 'MISSING' }] })
    const taskCapabilities = vi.fn(() => Promise.reject(failure))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '2.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, taskCapabilities,
      fetch: catalogFetch,
    })
    await expect(bridge.invoke('tasks.capabilities.prepare', { expertKitId: 'order-expert' })).rejects.toBe(failure)
    expect(taskCapabilities).toHaveBeenCalledOnce()
    await bridge.dispose()
  })

  it('installs Skill content independently of task dependencies', async () => {
    const installedSkills = vi.fn(() => Promise.resolve({ id: 'order-query', version: '2.0.0', sha256: 'e'.repeat(64) }))
    const skill = { id: 'order-query', version: '2.0.0', sha256: 'e'.repeat(64),
      minimumDesktopVersion: '1.0.0', connectorRefs: ['erp'],
      requiredTools: ['orders.get'], knowledgeBaseRefs: ['organization:orders'] }
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '2.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, installedSkills,
      fetch: catalogTransport({
        ...immutableCatalog,
        '/api/v1/skills': [skill],
        '/api/v1/connectors': [{ id: 'erp', ready: true, tools: [{ name: 'orders.get' }] }],
        '/api/v1/knowledge-bases': [{ id: 'kb-1', referenceKey: 'organization:orders' }],
      }),
    })

    await expect(bridge.invoke('skills.install', { id: 'order-query' })).resolves.toEqual({
      id: 'order-query', version: '2.0.0', sha256: 'e'.repeat(64),
    })
    await bridge.dispose()
  })

  it('does not reuse a prepared state after the catalog publishes a new content identity', async () => {
    let skill = { id: 'order-query', version: '1.0.0', sha256: 'a'.repeat(64),
      minimumDesktopVersion: '1.0.0', connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] }
    const installedSkills = vi.fn(() => Promise.resolve(skill))
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '2.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, installedSkills,
      fetch: (input, init) => catalogTransport({ ...immutableCatalog, '/api/v1/skills': [skill] })(input, init),
    })

    await bridge.invoke('skills.install', { id: 'order-query' })
    await expect(bridge.invoke('skills.list')).resolves.toEqual([
      expect.objectContaining({ version: '1.0.0', availabilityStatus: 'AVAILABLE' }),
    ])

    skill = { ...skill, version: '2.0.0', sha256: 'b'.repeat(64), minimumDesktopVersion: '9.0.0' }
    await bridge.invoke('catalog.refresh')

    await expect(bridge.invoke('skills.list')).resolves.toEqual([
      expect.objectContaining({ version: '2.0.0', availabilityStatus: 'INCOMPATIBLE' }),
    ])
    await expect(bridge.invoke('skills.install', { id: 'order-query' })).rejects.toThrow('installation is unavailable')
    expect(installedSkills).toHaveBeenCalledTimes(1)
    await bridge.dispose()
  })

  it.each([
    ['connector', { connectorRefs: ['missing-connector'] }, {}, 'requires unavailable connector'],
    ['knowledge base', { knowledgeBaseRefs: ['company:missing'] }, {}, 'requires unavailable knowledge'],
  ] as const)('allows installation with an unavailable %s dependency', async (_label, overrides, extra, _diagnostic) => {
    const installedSkills = vi.fn(() => Promise.resolve({ installed: true }))
    const skill = { id: 'order-query', version: '1.0.0', sha256: 'f'.repeat(64),
      connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [], ...overrides }
    const bridge = new DeepSeekHarnessProductBridge({
      serverUrl: 'https://deepseek-harness.test', sessionToken: 'employee-session', desktopVersion: '1.0.0',
      initialSession: { authenticated: true, employeeId: 'employee-1' }, installedSkills,
      fetch: catalogTransport({ ...immutableCatalog, '/api/v1/skills': [skill], ...extra }),
    })

    await expect(bridge.invoke('skills.install', { id: 'order-query' })).resolves.toEqual({ installed: true })
    expect(installedSkills).toHaveBeenCalledExactlyOnceWith('install', { id: 'order-query' }, expect.any(AbortSignal))
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
    await vi.waitFor(() => { expect(pending).toHaveLength(8) })
    controller.abort(new Error('Cancel first refresh'))
    expect(pending.slice(4).every(request => !request.signal.aborted)).toBe(true)
    pending.slice(0, 4).forEach((request) => { request.cancel?.() })
    pending.slice(4).forEach((request) => { request.finish() })
    await firstCancelled
    await second
    expect(events).toEqual(['catalog.changed'])
    const background = bridge.refreshCatalog()
    const backgroundCancelled = expect(background).rejects.toThrow('closed')
    await vi.waitFor(() => { expect(pending).toHaveLength(12) })
    let disposed = false
    const disposal = bridge.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    pending.slice(8).forEach((request) => { request.cancel?.() })
    await backgroundCancelled
    await disposal
    expect(disposed).toBe(true)
    expect(events).toEqual(['catalog.changed'])
  })
})
