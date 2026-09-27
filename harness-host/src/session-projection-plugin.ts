import type { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/cordis' {
  interface Context { sessionProjections: SessionProjectionRegistry }
}

export const name = 'xiaoyin-session-projection-bridge'
export const inject = ['sessionProjections']

type ProjectionRegistry = {
  onChanged(listener: (session: { id: string }, key: string, value: unknown, seq: number) => void): () => void
}

export function apply(ctx: Context): void {
  const url = process.env.XIAOYIN_SESSION_PROJECTION_URL?.trim()
  const token = process.env.XIAOYIN_SESSION_PROJECTION_TOKEN?.trim()
  if (!url || !token) return
  const registry = ctx.sessionProjections as unknown as ProjectionRegistry
  const dispose = registry.onChanged((session, key, value, seq) => {
    // Harness-owned projections are consumed by the official Conversation
    // client. Only Xiaoyin product projections belong on this bridge.
    if (!key.startsWith('xiaoyin.')) return
    void fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, key, value, seq }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined)
  })
  ctx.effect(() => dispose, 'xiaoyin session projection bridge')
}
