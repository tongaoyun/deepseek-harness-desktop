import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { ensureDingTalkSession } from '../src/dingtalk-auth.ts'
import type { ProductSession } from '../src/protocol.ts'

function refreshed(token = 'rotated-token') {
  return Response.json({ success: true, data: { sessionToken: token, refreshToken: 'remembered-login', refreshExpiresAt: Math.floor(Date.now() / 1000) + 2592000,
    expiresAt: Math.floor(Date.now() / 1000) + 1800,
    employee: { employeeId: '10001', employeeName: 'Employee', teamId: '' } } })
}

it('establishes a token-only employee identity for concurrent startup and explicit refresh waiters', async () => {
  const started = Promise.withResolvers<undefined>()
  const response = Promise.withResolvers<Response>()
  const opened = vi.fn(async (_url: string) => {})
  const persisted = vi.fn((_session: ProductSession, _token: string | undefined) => {})
  const tokens: Array<string | null> = []
  let refreshSignal: AbortSignal | null | undefined
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'valid-token', refreshToken: 'remembered-login',
    persistSession: persisted,
    fetch: async (input, init) => {
      if (new Request(input).url.endsWith('/session/refresh')) {
        tokens.push(new Headers(init?.headers).get('authorization'))
        refreshSignal = init?.signal
        started.resolve(undefined)
        return response.promise
      }
      return Response.json({ success: true, data: 52428800, pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  const signIn = ensureDingTalkSession(bridge, opened)
  const explicit = bridge.invoke('auth.refresh')
  const completed = expect(Promise.all([signIn, explicit])).resolves.toEqual([
    expect.objectContaining({ authenticated: true, employeeId: '10001' }),
    expect.objectContaining({ authenticated: true, employeeId: '10001' }),
  ])
  try {
    await started.promise
    response.resolve(refreshed())
    await completed
    expect(refreshSignal?.aborted).toBe(false)
    expect(tokens).toEqual(['Bearer valid-token'])
    expect(opened).not.toHaveBeenCalled()
    expect(persisted).toHaveBeenCalledExactlyOnceWith(bridge.getSession(), 'rotated-token', 'remembered-login')
  } finally {
    response.resolve(refreshed())
    await Promise.allSettled([completed, signIn, explicit])
    await bridge.dispose()
  }
})

it('shares the background token rotation with startup sign-in without reopening OAuth', async () => {
  const started = Promise.withResolvers<boolean>()
  const response = Promise.withResolvers<Response>()
  const refreshTokens: Array<string | null> = []
  const opened = vi.fn(async (_url: string) => {})
  const persisted: Array<{ session: ProductSession; token: string | undefined }> = []
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'valid-token', refreshToken: 'remembered-login',
    initialSession: { authenticated: true, employeeId: '10001', expiresAt: String(Date.now() / 1000 + 120) },
    persistSession: (session, token) => { persisted.push({ session, token }) },
    fetch: async (input, init) => {
      const url = new Request(input).url
      if (url.endsWith('/session/refresh')) {
        refreshTokens.push(new Headers(init?.headers).get('authorization'))
        if (refreshTokens.length === 1) { started.resolve(true); return response.promise }
        return Response.json({ success: false, errCode: 'EMPLOYEE_UNAUTHORIZED',
          errMessage: 'The original token has already rotated' }, { status: 401 })
      }
      if (url.endsWith('/authorization-requests')) return Response.json({ success: true,
        data: { state: 'state-1234567890', authorizationUrl: 'https://login.test/dingtalk' } })
      if (url.includes('/authorization-requests/')) return Response.json({ success: true,
        data: { status: 'completed', session: { sessionToken: 'oauth-token', employee: { employeeId: '10001' } } } })
      return Response.json({ success: true, data: 52428800, pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  let signIn: Promise<ProductSession> | undefined
  try {
    await started.promise
    signIn = ensureDingTalkSession(bridge, opened, { pollMs: 0 })
    expect(refreshTokens).toEqual(['Bearer valid-token'])
    response.resolve(refreshed())
    await expect(signIn).resolves.toMatchObject({ authenticated: true, employeeId: '10001' })
    expect(opened).not.toHaveBeenCalled()
    expect(persisted).toEqual([{ session: bridge.getSession(), token: 'rotated-token' }])
    expect(refreshTokens).toHaveLength(1)
  } finally {
    response.resolve(refreshed())
    await Promise.allSettled([signIn])
    await bridge.dispose()
  }
})

it.each([false, true])('retains the token rotation after a sign-in waiter cancels, with another waiter=%s', async (otherWaiter) => {
  const started = Promise.withResolvers<boolean>()
  const response = Promise.withResolvers<Response>()
  const persisted = Promise.withResolvers<string | undefined>()
  const opened = vi.fn(async (_url: string) => {})
  const tokens: Array<string | null> = []
  let refreshSignal: AbortSignal | null | undefined
  let requestToken: string | null = null
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'valid-token', refreshToken: 'remembered-login',
    initialSession: { authenticated: true, employeeId: '10001', expiresAt: String(Date.now() / 1000 + 3600) },
    persistSession: (_session, token) => { persisted.resolve(token) },
    fetch: async (input, init) => {
      const url = new Request(input).url
      if (url.endsWith('/session/refresh')) {
        tokens.push(new Headers(init?.headers).get('authorization'))
        refreshSignal = init?.signal
        started.resolve(true)
        return response.promise
      }
      if (url.endsWith('/libraries/file-policy')) {
        requestToken = new Headers(init?.headers).get('authorization')
        return Response.json({ success: true, data: 52428800 })
      }
      return Response.json({ success: true, data: 52428800, pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  const caller = new AbortController()
  const reason = new Error('Caller cancelled sign-in')
  const signIn = ensureDingTalkSession(bridge, opened, { signal: caller.signal })
  const cancelled = expect(signIn).rejects.toBe(reason)
  let live: Promise<unknown> | undefined
  try {
    await started.promise
    if (otherWaiter) live = bridge.invoke('auth.refresh')
    expect(tokens).toEqual(['Bearer valid-token'])
    caller.abort(reason)
    await cancelled
    expect(refreshSignal?.aborted).toBe(false)
    expect(opened).not.toHaveBeenCalled()
    response.resolve(refreshed())
    await expect(persisted.promise).resolves.toBe('rotated-token')
    if (live) await expect(live).resolves.toMatchObject({ authenticated: true, employeeId: '10001' })
    await expect(bridge.invoke('library.files.policy', {})).resolves.toEqual(52428800)
    expect(requestToken).toBe('Bearer rotated-token')
    expect(tokens).toHaveLength(1)
  } finally {
    response.resolve(refreshed())
    await Promise.allSettled([cancelled, live])
    await bridge.dispose()
  }
})

it.each([
  ['employee-change', '10001'], ['employee-change', undefined],
  ['disposal', '10001'], ['disposal', undefined],
] as const)('cancels refresh waiters on %s with restored employee %s and drains the issued rotation', async (event, employeeId) => {
  const started = Promise.withResolvers<boolean>()
  const response = Promise.withResolvers<Response>()
  const persisted = vi.fn((_session: ProductSession, _token: string | undefined) => {})
  let refreshSignal: AbortSignal | null | undefined
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'valid-token', refreshToken: 'remembered-login',
    initialSession: { authenticated: true, ...(employeeId === undefined ? {} : { employeeId }),
      expiresAt: String(Date.now() / 1000 + 3600) },
    persistSession: persisted,
    fetch: async (input, init) => {
      if (new Request(input).url.endsWith('/session/refresh')) {
        refreshSignal = init?.signal
        started.resolve(true)
        return response.promise
      }
      return Response.json({ success: true, data: 52428800, pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  const pending = bridge.invoke('auth.refresh', undefined, new AbortController().signal)
  const rejected = expect(pending).rejects.toMatchObject({ message: event === 'employee-change'
    ? 'Product employee identity changed' : 'Product bridge closed' })
  let disposed = false
  let disposal: Promise<void> | undefined
  try {
    await started.promise
    if (event === 'employee-change') bridge.setSession({ authenticated: true, employeeId: '10002' }, 'employee-b-token', undefined)
    else disposal = bridge.dispose().then(() => { disposed = true })
    await rejected
    expect(refreshSignal?.aborted).toBe(true)
    expect(disposed).toBe(false)
    response.resolve(refreshed())
    await disposal
    if (event === 'employee-change') {
      await bridge.dispose()
      expect(bridge.getSession()).toEqual({ authenticated: true, employeeId: '10002' })
      expect(persisted).toHaveBeenCalledExactlyOnceWith({ authenticated: true, employeeId: '10002' }, 'employee-b-token', undefined)
    } else {
      expect(disposed).toBe(true)
      expect(persisted).not.toHaveBeenCalled()
    }
  } finally {
    response.resolve(refreshed())
    await Promise.allSettled([rejected, disposal])
    await bridge.dispose()
  }
})

it('restores an expired access grant weeks later using only the remembered credential and retains it while offline', async () => {
  const opened = vi.fn(async (_url: string) => {})
  const events: string[] = []
  const persisted = vi.fn()
  let offline = true
  const bodies: unknown[] = []
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'expired-access', refreshToken: 'remembered-login',
    initialSession: { authenticated: true, employeeId: '10001',
      expiresAt: String(Math.floor(Date.now() / 1000) - 21 * 86400),
      loginExpiresAt: String(Math.floor(Date.now() / 1000) + 9 * 86400) },
    persistSession: persisted, fetch: async (input, init) => {
      if (new Request(input).url.endsWith('/session/refresh')) {
        bodies.push(JSON.parse(await new Response(init?.body).text()))
        if (offline) throw new TypeError('Offline')
        return refreshed()
      }
      return Response.json({ success: true, data: 52428800, pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  bridge.subscribe((event) => { events.push(event.type) })
  try {
    await expect(ensureDingTalkSession(bridge, opened)).rejects.toMatchObject({ code: 'PRODUCT_NETWORK_UNAVAILABLE' })
    expect(bridge.getSession().authenticated).toBe(true)
    expect(persisted).not.toHaveBeenCalled()
    expect(events).not.toContain('auth.required')
    expect(opened).not.toHaveBeenCalled()
    offline = false
    await expect(ensureDingTalkSession(bridge, opened)).resolves.toMatchObject({ authenticated: true, employeeId: '10001' })
    expect(bodies).toEqual([{ refreshToken: 'remembered-login' }, { refreshToken: 'remembered-login' }])
    expect(persisted).toHaveBeenCalledWith(bridge.getSession(), 'rotated-token', 'remembered-login')
    expect(opened).not.toHaveBeenCalled()
  } finally { await bridge.dispose() }
})

it('clears revoked or expired remembered login only after the server rejects the credential', async () => {
  const persisted = vi.fn()
  const events: string[] = []
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'expired-access', refreshToken: 'revoked-login',
    initialSession: { authenticated: true, employeeId: '10001' }, persistSession: persisted,
    fetch: async () => Response.json({ success: false, errCode: 'EMPLOYEE_UNAUTHORIZED', errMessage: 'Login expired' }, { status: 401 }) })
  bridge.subscribe((event) => { events.push(event.type) })
  try {
    await expect(bridge.invoke('auth.refresh')).rejects.toMatchObject({ status: 401 })
    expect(bridge.getSession()).toEqual({ authenticated: false })
    expect(persisted).toHaveBeenCalledWith({ authenticated: false }, undefined, undefined)
    expect(events.filter(type => type === 'auth.required')).toHaveLength(1)
  } finally { await bridge.dispose() }
})

it('does not repeat a business write when its access grant is rejected and login refresh succeeds', async () => {
  let writes = 0
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'old-access', refreshToken: 'remembered-login',
    initialSession: { authenticated: true, employeeId: '10001' }, fetch: async (input) => {
      const url = new Request(input).url
      if (url.endsWith('/session/refresh')) return refreshed()
      if (url.endsWith('/authorization-requests')) { writes++; return Response.json({ success: false,
        errCode: 'EMPLOYEE_UNAUTHORIZED', errMessage: 'Access expired' }, { status: 401 }) }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  try {
    await expect(bridge.invoke('connectors.authorization.begin', { id: 'erp' })).rejects.toMatchObject({ status: 401 })
    expect(writes).toBe(1)
    expect(bridge.getSession().authenticated).toBe(true)
  } finally { await bridge.dispose() }
})

it('retains remembered login if logout is offline, then revokes it without exposing credentials', async () => {
  let offline = true
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'old-access', refreshToken: 'remembered-login',
    initialSession: { authenticated: true, employeeId: '10001' }, fetch: async (input, init) => {
      if (new Request(input).url.endsWith('/employee-auth/session')) {
        expect(init?.method).toBe('DELETE')
        expect(JSON.parse(await new Response(init?.body).text())).toEqual({ refreshToken: 'remembered-login' })
        if (offline) throw new TypeError('Offline')
        return Response.json({ success: true, data: 'revoked' })
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  try {
    await expect(bridge.invoke('auth.signOut')).rejects.toMatchObject({ code: 'PRODUCT_NETWORK_UNAVAILABLE' })
    expect(bridge.getSession().authenticated).toBe(true)
    offline = false
    await expect(bridge.invoke('auth.signOut')).resolves.toEqual({ authenticated: false })
    expect(bridge.getSession()).toEqual({ authenticated: false })
  } finally { await bridge.dispose() }
})

it('coalesces logout and refuses to clear a new identity after an old logout response arrives', async () => {
  const response = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<undefined>()
  let revocations = 0
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'old-access', refreshToken: 'remembered-login',
    initialSession: { authenticated: true, employeeId: '10001' }, fetch: async (input) => {
      if (new Request(input).url.endsWith('/employee-auth/session')) {
        revocations++; started.resolve(undefined); return response.promise
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  try {
    const first = bridge.invoke('auth.signOut'), second = bridge.invoke('auth.signOut')
    const outcomes = Promise.allSettled([first, second])
    await started.promise
    expect(revocations).toBe(1)
    bridge.setSession({ authenticated: true, employeeId: '10002' }, 'new-access', 'new-login')
    response.resolve(Response.json({ success: true, data: 'revoked' }))
    await outcomes
    expect(bridge.getSession()).toEqual({ authenticated: true, employeeId: '10002' })
  } finally { response.resolve(Response.json({ success: true, data: 'revoked' })); await bridge.dispose() }
})

it('allows a new logout after the same employee signs in again while an old logout is pending', async () => {
  const oldResponse = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<undefined>()
  const credentials: unknown[] = []
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'old-access', refreshToken: 'old-login',
    initialSession: { authenticated: true, employeeId: '10001' }, fetch: async (input, init) => {
      if (new Request(input).url.endsWith('/employee-auth/session')) {
        credentials.push(JSON.parse(await new Response(init?.body).text()))
        if (credentials.length === 1) { started.resolve(undefined); return oldResponse.promise }
        return Response.json({ success: true, data: 'revoked' })
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  let oldLogout: Promise<unknown> | undefined
  try {
    oldLogout = bridge.invoke('auth.signOut')
    const oldOutcome = Promise.allSettled([oldLogout])
    await started.promise
    bridge.setSession({ authenticated: true, employeeId: '10001' }, 'new-access', 'new-login')
    await expect(bridge.invoke('auth.signOut')).resolves.toEqual({ authenticated: false })
    expect(credentials).toEqual([{ refreshToken: 'old-login' }, { refreshToken: 'new-login' }])
    oldResponse.resolve(Response.json({ success: true, data: 'revoked' }))
    await oldOutcome
    expect(bridge.getSession()).toEqual({ authenticated: false })
  } finally {
    oldResponse.resolve(Response.json({ success: true, data: 'revoked' }))
    await Promise.allSettled([oldLogout])
    await bridge.dispose()
  }
})
