/**
 * Capability gaps the employee should hear about.
 *
 * A connector that fails to connect, or a knowledge base the runtime could not
 * mount, leaves the model without those tools while the reply still reads as an
 * answer. The employee asked for that capability, so the turn says what was
 * missing instead of quietly doing less.
 *
 * These are live product notices, not Harness session events.
 */

export interface CapabilityNotice {
  kind: 'connector' | 'knowledge'
  id: string
  name: string
  reason: string
}

const KEY = 'xiaoyin.capabilityNotice'
const MAX_DELIVERY_ATTEMPTS = 4
let sequence = 0
const pending: CapabilityNotice[] = []
const deliveries = new Map<string, Promise<void>>()

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
  for (const notice of pending.splice(0)) void reportCapabilityNotice(sessionId, notice)
}

/** A missing bridge must never break the connector path. */
export function reportCapabilityNotice(sessionId: string, notice: CapabilityNotice): Promise<void> {
  const url = process.env.XIAOYIN_SESSION_PROJECTION_URL?.trim()
  const token = process.env.XIAOYIN_SESSION_PROJECTION_TOKEN?.trim()
  if (!url || !token || !sessionId) return Promise.resolve()
  sequence += 1
  const body = JSON.stringify({ sessionId, key: KEY, value: notice, seq: sequence })
  // The desktop rejects older projection sequences, so retries within a
  // session must finish before the next notice can be sent.
  const previous = deliveries.get(sessionId)
  const delivery = previous ? previous.then(() => deliver(url, token, body)) : deliver(url, token, body)
  deliveries.set(sessionId, delivery)
  void delivery.finally(() => { if (deliveries.get(sessionId) === delivery) deliveries.delete(sessionId) }).catch(() => undefined)
  return delivery
}

async function deliver(url: string, token: string, body: string): Promise<void> {
  let failure = 'network error'
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      })
      if (response.ok) return
      failure = `HTTP ${response.status}`
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) break
    } catch {
      failure = 'network error'
    }
    if (attempt + 1 < MAX_DELIVERY_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 200 * 2 ** attempt))
    }
  }
  process.stderr.write(`Capability notice delivery failed (${failure}); the desktop may not show this gap\n`)
}

export const capabilityNoticeKey = KEY
