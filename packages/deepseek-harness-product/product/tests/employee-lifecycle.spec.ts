import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { ensureDingTalkSession, DingTalkAuthorizationTimeoutError } from '../src/dingtalk-auth.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function refreshed(employeeId: string, sessionToken: string) {
  return Response.json({ success: true, data: { sessionToken, employee: { employeeId } } })
}

function authorization(state = 'state-1234567890') {
  return Response.json({ success: true, data: { state, authorizationUrl: 'https://login.test/dingtalk' } })
}

function authorized() {
  return Response.json({ success: true, data: { status: 'authorized', session: {
    sessionToken: 'token-a', employee: { employeeId: 'employee-a' },
  } } })
}

it('continues browser sign-in when a concurrent refresh invalidates an expired stored session', async () => {
  let refreshes = 0
  const opened = vi.fn(async (_url: string) => {})
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'expired-token', initialSession: { authenticated: true, employeeId: 'employee-a',
      expiresAt: String(Date.now() / 1000 + 10) },
    fetch: async (input, init) => {
      const url = new Request(input).url
      if (url.endsWith('/session/refresh')) {
        if (++refreshes === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const reason: unknown = init.signal?.reason
              reject(reason instanceof Error ? reason : new DOMException('Request aborted', 'AbortError'))
            }, { once: true })
          })
        }
        return Response.json({ success: false, errCode: 'EMPLOYEE_UNAUTHORIZED', errMessage: 'Expired session' }, { status: 401 })
      }
      if (url.endsWith('/authorization-requests')) return authorization()
      if (url.includes('/authorization-requests/')) return authorized()
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  try {
    await expect(ensureDingTalkSession(bridge, opened, { pollMs: 0 })).resolves.toMatchObject({ authenticated: true, employeeId: 'employee-a' })
    expect(refreshes).toBe(2)
    expect(opened).toHaveBeenCalledExactlyOnceWith('https://login.test/dingtalk')
  } finally { await bridge.dispose() }
})

it.each(['employee-changed', 'superseded', 'cancelled'] as const)('rejects an obsolete OAuth poll after %s', async (reason) => {
  const started = deferred<boolean>()
  const response = deferred<Response>()
  let begins = 0
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', fetch: async (input) => {
    const url = new Request(input).url
    if (url.endsWith('/authorization-requests')) return authorization(++begins === 1 ? 'state-1234567890' : 'state-2222222222')
    if (url.includes('/authorization-requests/')) { started.resolve(true); return response.promise }
    return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
  } })
  const controller = new AbortController()
  try {
    await bridge.invoke('auth.beginDingTalk')
    const pending = bridge.invoke('auth.pollDingTalk', { state: 'state-1234567890' }, controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await started.promise
    if (reason === 'employee-changed') bridge.setSession({ authenticated: true, employeeId: 'employee-b' }, 'token-b')
    if (reason === 'superseded') await bridge.invoke('auth.beginDingTalk')
    if (reason === 'cancelled') controller.abort(new Error('Caller cancelled login'))
    response.resolve(authorized())
    await rejected
    expect(bridge.getSession()).toEqual(reason === 'employee-changed'
      ? { authenticated: true, employeeId: 'employee-b' } : { authenticated: false })
    await expect(bridge.invoke('auth.pollDingTalk', { state: 'unrelated-state' })).rejects.toThrow('no longer current')
  } finally { response.resolve(authorized()); await bridge.dispose() }
})

it.each(['refresh', 'begin', 'poll'] as const)('propagates cancelled sign-in through the %s request', async (stage) => {
  const started = deferred<boolean>()
  const response = deferred<Response>()
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    ...stage === 'refresh' ? { sessionToken: 'old-token', initialSession: { authenticated: true, employeeId: 'employee-a' } } : {},
    fetch: async (input) => {
      const url = new Request(input).url
      if (stage === 'refresh' && url.endsWith('/session/refresh')
        || stage === 'begin' && url.endsWith('/authorization-requests')
        || stage === 'poll' && url.includes('/authorization-requests/')) { started.resolve(true); return response.promise }
      return authorization()
    } })
  const controller = new AbortController()
  try {
    const pending = ensureDingTalkSession(bridge, async () => {}, { pollMs: 0, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('Caller cancelled login')
    await started.promise
    controller.abort(new Error('Caller cancelled login'))
    response.resolve(stage === 'refresh' ? refreshed('employee-a', 'new-token') : stage === 'begin' ? authorization() : authorized())
    await rejected
    expect(bridge.getSession().authenticated).toBe(stage === 'refresh')
  } finally { response.resolve(authorized()); await bridge.dispose() }
})

it('times out a sign-in while waiting for an authorization response', async () => {
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', fetch: async (_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('Authorization cancelled', { cause: init.signal?.reason }))
      }, { once: true })
    })
  } })
  try {
    await expect(ensureDingTalkSession(bridge, async () => {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(DingTalkAuthorizationTimeoutError)
    expect(bridge.getSession()).toEqual({ authenticated: false })
  } finally { await bridge.dispose() }
})

it.each(['success', 'unauthorized'] as const)('discards a previous employee refresh %s after another employee signs in', async (outcome) => {
  const started = deferred<boolean>()
  const response = deferred<Response>()
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'token-a', initialSession: { authenticated: true, employeeId: 'employee-a' },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (request.url.endsWith('/session/refresh')) {
        if (request.headers.get('authorization') === 'Bearer token-b') return refreshed('employee-b', 'new-b')
        started.resolve(true); return response.promise
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  try {
    const pending = bridge.invoke('auth.refresh')
    const rejected = expect(pending).rejects.toThrow('Product employee identity changed')
    await started.promise
    bridge.setSession({ authenticated: true, employeeId: 'employee-b' }, 'token-b')
    await bridge.invoke('auth.refresh')
    response.resolve(outcome === 'success' ? refreshed('employee-a', 'new-a') : Response.json({
      success: false, errCode: 'EMPLOYEE_UNAUTHORIZED', errMessage: 'Old session expired',
    }, { status: 401 }))
    await rejected
    expect(bridge.getSession()).toMatchObject({ authenticated: true, employeeId: 'employee-b' })
  } finally { await bridge.dispose() }
})

it.each(['skills.get', 'bootstrap'] as const)('cancels an old %s failure without signing out the new employee', async (method) => {
  const started = deferred<boolean>()
  const response = deferred<Response>()
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'token-a', initialSession: { authenticated: true, employeeId: 'employee-a' },
    fetch: async (input) => {
      if (new Request(input).url.endsWith(method === 'bootstrap' ? '/bootstrap' : '/skills/skill-test')) {
        started.resolve(true); return response.promise
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  try {
    const pending = method === 'bootstrap' ? bridge.loadRuntimeBootstrap() : bridge.invoke(method, { id: 'skill-test' })
    const rejected = expect(pending).rejects.toThrow('Product employee identity changed')
    await started.promise
    bridge.setSession({ authenticated: true, employeeId: 'employee-b' }, 'token-b')
    response.resolve(Response.json({ success: false, errCode: 'EMPLOYEE_UNAUTHORIZED', errMessage: 'Old session expired' }, { status: 401 }))
    await rejected
    expect(bridge.getSession()).toMatchObject({ authenticated: true, employeeId: 'employee-b' })
  } finally { await bridge.dispose() }
})

it('does not sign out a renewed session when an older token returns unauthorized', async () => {
  const started = deferred<boolean>()
  const response = deferred<Response>()
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'old-token', initialSession: { authenticated: true, employeeId: 'employee-a' },
    fetch: async (input) => {
      const url = new Request(input).url
      if (url.endsWith('/skills/skill-test')) { started.resolve(true); return response.promise }
      if (url.endsWith('/session/refresh')) return refreshed('employee-a', 'new-token')
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  try {
    const pending = bridge.invoke('skills.get', { id: 'skill-test' })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'EMPLOYEE_UNAUTHORIZED' })
    await started.promise
    await bridge.invoke('auth.refresh')
    response.resolve(Response.json({ success: false, errCode: 'EMPLOYEE_UNAUTHORIZED', errMessage: 'Old token expired' }, { status: 401 }))
    await rejected
    expect(bridge.getSession()).toMatchObject({ authenticated: true, employeeId: 'employee-a' })
  } finally { await bridge.dispose() }
})
