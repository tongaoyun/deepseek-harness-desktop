import type { ProductSession } from './protocol.ts'
import { DeepSeekHarnessApiError } from './http-client.ts'
import { setTimeout as delay } from 'node:timers/promises'

/** Product bridge operations required by the DingTalk OAuth flow. */
export interface DingTalkAuthInvoker {
  invoke(method: 'auth.getSession' | 'auth.refresh' | 'auth.beginDingTalk' | 'auth.pollDingTalk', payload?: unknown, signal?: AbortSignal): Promise<unknown>
  getSession(): ProductSession
}

/** Validated browser authorization request returned by the server. */
export interface DingTalkAuthorization {
  readonly state: string
  readonly authorizationUrl: string
}

/** Signals that one browser authorization attempt expired and may be started again. */
export class DingTalkAuthorizationTimeoutError extends Error {
  constructor() {
    super('deepseek-harness DingTalk: authorization timed out')
    this.name = 'DingTalkAuthorizationTimeoutError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authorization(value: unknown): DingTalkAuthorization {
  if (!record(value) || typeof value.state !== 'string' || value.state.length < 8
    || typeof value.authorizationUrl !== 'string') throw new Error('deepseek-harness DingTalk: invalid authorization response')
  const url = new URL(value.authorizationUrl)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('deepseek-harness DingTalk: invalid authorization URL')
  return { state: value.state, authorizationUrl: url.href }
}

/**
 * Refresh an existing enterprise session or complete one browser-based OAuth attempt.
 * @param bridge - Product bridge used for session refresh and OAuth polling.
 * @param openExternal - System-browser opener for the authorization URL.
 * @param options - Complete sign-in timeout, polling interval and caller cancellation.
 * @returns The authenticated employee session.
 */
export async function ensureDingTalkSession(
  bridge: DingTalkAuthInvoker,
  openExternal: (url: string) => Promise<void>,
  options: { readonly timeoutMs?: number; readonly pollMs?: number; readonly signal?: AbortSignal } = {},
): Promise<ProductSession> {
  options.signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000)
  const signal = AbortSignal.any([timeout, ...options.signal ? [options.signal] : []])
  try {
    const sessionBeforeRefresh = bridge.getSession()
    try { await bridge.invoke('auth.refresh', undefined, signal) } catch (error) {
      signal.throwIfAborted()
      const unauthorized = error instanceof DeepSeekHarnessApiError
        && error.status === 401 && error.code === 'EMPLOYEE_UNAUTHORIZED'
      const invalidated = sessionBeforeRefresh.authenticated && !bridge.getSession().authenticated
      if (!unauthorized && !invalidated) throw error
    }
    signal.throwIfAborted()
    if (bridge.getSession().authenticated) return bridge.getSession()
    const attempt = authorization(await bridge.invoke('auth.beginDingTalk', undefined, signal))
    signal.throwIfAborted()
    await openExternal(attempt.authorizationUrl)
    for (;;) {
      await delay(options.pollMs ?? 1_500, undefined, { signal })
      const poll = await bridge.invoke('auth.pollDingTalk', { state: attempt.state }, signal)
      signal.throwIfAborted()
      if (bridge.getSession().authenticated) return bridge.getSession()
      if (record(poll) && (poll.status === 'expired' || poll.status === 'invalid')) {
        throw new DingTalkAuthorizationTimeoutError()
      }
    }
  } catch (error) {
    options.signal?.throwIfAborted()
    if (timeout.aborted) throw new DingTalkAuthorizationTimeoutError()
    throw error
  }
}
