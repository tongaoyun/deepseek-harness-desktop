/**
 * Capability gaps the employee should hear about.
 *
 * A connector that fails to connect, or a knowledge base the runtime could not
 * mount, leaves the model without those tools while the reply still reads as an
 * answer. The employee asked for that capability, so the turn says what was
 * missing instead of quietly doing less.
 *
 * These ride the session projection bridge under their own key: they are live
 * notices, not session log records, so they never affect log reconstruction.
 */

export interface CapabilityNotice {
  kind: 'connector' | 'knowledge'
  id: string
  name: string
  reason: string
}

const KEY = 'xiaoyin.capabilityNotice'
let sequence = 0
const pending: CapabilityNotice[] = []

/**
 * Connectors connect before any session exists, so a gap found then waits for
 * the session it belongs to.
 */
export function rememberCapabilityNotice(notice: CapabilityNotice): void {
  if (pending.length >= 20) return
  pending.push(notice)
}

/** Report the stashed gaps against the session that is starting. */
export function flushCapabilityNotices(sessionId: string): void {
  for (const notice of pending.splice(0)) reportCapabilityNotice(sessionId, notice)
}

/** Fire-and-forget: a missing notice must never break the connector path. */
export function reportCapabilityNotice(sessionId: string, notice: CapabilityNotice): void {
  const url = process.env.XIAOYIN_SESSION_PROJECTION_URL?.trim()
  const token = process.env.XIAOYIN_SESSION_PROJECTION_TOKEN?.trim()
  if (!url || !token || !sessionId) return
  sequence += 1
  void fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, key: KEY, value: notice, seq: sequence }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined)
}

export const capabilityNoticeKey = KEY
