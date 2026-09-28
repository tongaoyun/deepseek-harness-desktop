import type { ProductSession } from './protocol.ts'

/** Product bridge operations required by the DingTalk OAuth flow. */
export interface DingTalkAuthInvoker {
  invoke(method: 'auth.getSession' | 'auth.refresh' | 'auth.beginDingTalk' | 'auth.pollDingTalk', payload?: unknown): Promise<unknown>
  getSession(): ProductSession
}

/** Validated browser authorization request returned by the server. */
export interface DingTalkAuthorization {
  readonly state: string
  readonly authorizationUrl: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authorization(value: unknown): DingTalkAuthorization {
  if (!record(value) || typeof value.state !== 'string' || value.state.length < 8
    || typeof value.authorizationUrl !== 'string') throw new Error('xiaoyin DingTalk: invalid authorization response')
  const url = new URL(value.authorizationUrl)
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('xiaoyin DingTalk: invalid authorization URL')
  return { state: value.state, authorizationUrl: url.href }
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, milliseconds) })

/**
 * Refresh an existing enterprise session or complete one browser-based OAuth attempt.
 * @param bridge - Product bridge used for session refresh and OAuth polling.
 * @param openExternal - System-browser opener for the authorization URL.
 * @param options - Optional timeout and polling intervals.
 * @returns The authenticated employee session.
 */
export async function ensureDingTalkSession(
  bridge: DingTalkAuthInvoker,
  openExternal: (url: string) => Promise<void>,
  options: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<ProductSession> {
  if (bridge.getSession().authenticated) return bridge.getSession()
  try { await bridge.invoke('auth.refresh') } catch { /* A missing session starts a fresh OAuth attempt below. */ }
  if (bridge.getSession().authenticated) return bridge.getSession()
  const attempt = authorization(await bridge.invoke('auth.beginDingTalk'))
  await openExternal(attempt.authorizationUrl)
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  while (Date.now() < deadline) {
    await wait(options.pollMs ?? 1_500)
    await bridge.invoke('auth.pollDingTalk', { state: attempt.state })
    if (bridge.getSession().authenticated) return bridge.getSession()
  }
  throw new Error('xiaoyin DingTalk: authorization timed out')
}
