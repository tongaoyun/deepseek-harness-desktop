import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { ensureDingTalkSession } from '../src/dingtalk-auth.ts'
import type { ProductSession } from '../src/protocol.ts'

function refreshed(token = 'rotated-token') {
  return Response.json({ success: true, data: { sessionToken: token,
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
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'valid-token',
    persistSession: persisted,
    fetch: async (input, init) => {
      if (new Request(input).url.endsWith('/session/refresh')) {
        tokens.push(new Headers(init?.headers).get('authorization'))
        refreshSignal = init?.signal
        started.resolve(undefined)
        return response.promise
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
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
    expect(persisted).toHaveBeenCalledExactlyOnceWith(bridge.getSession(), 'rotated-token')
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
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'valid-token',
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
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
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
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'valid-token',
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
      if (url.endsWith('/knowledge-references/resolve')) {
        requestToken = new Headers(init?.headers).get('authorization')
        return Response.json({ success: true, data: [] })
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
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
    await expect(bridge.invoke('knowledge.references.resolve', {})).resolves.toEqual([])
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
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'valid-token',
    initialSession: { authenticated: true, ...(employeeId === undefined ? {} : { employeeId }),
      expiresAt: String(Date.now() / 1000 + 3600) },
    persistSession: persisted,
    fetch: async (input, init) => {
      if (new Request(input).url.endsWith('/session/refresh')) {
        refreshSignal = init?.signal
        started.resolve(true)
        return response.promise
      }
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    } })
  const pending = bridge.invoke('auth.refresh', undefined, new AbortController().signal)
  const rejected = expect(pending).rejects.toMatchObject({ message: event === 'employee-change'
    ? 'Product employee identity changed' : 'Product bridge closed' })
  let disposed = false
  let disposal: Promise<void> | undefined
  try {
    await started.promise
    if (event === 'employee-change') bridge.setSession({ authenticated: true, employeeId: '10002' }, 'employee-b-token')
    else disposal = bridge.dispose().then(() => { disposed = true })
    await rejected
    expect(refreshSignal?.aborted).toBe(true)
    expect(disposed).toBe(false)
    response.resolve(refreshed())
    await disposal
    if (event === 'employee-change') {
      await bridge.dispose()
      expect(bridge.getSession()).toEqual({ authenticated: true, employeeId: '10002' })
      expect(persisted).toHaveBeenCalledExactlyOnceWith({ authenticated: true, employeeId: '10002' }, 'employee-b-token')
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
