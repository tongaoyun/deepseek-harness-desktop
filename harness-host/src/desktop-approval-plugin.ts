import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

export const name = 'xiaoyin-desktop-approval'
export const inject = ['approval']

export function apply(ctx: Context): void {
  ctx.on('approval/request', async (request, next): Promise<ApprovalOutcome> => {
    const url = process.env.XIAOYIN_APPROVAL_BRIDGE_URL
    const token = process.env.XIAOYIN_APPROVAL_BRIDGE_TOKEN
    if (!url || !token) return next()
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: request.toolName, reason: request.reason }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (!response.ok) return 'unavailable'
      const value = await response.json() as { outcome?: unknown }
      return isOutcome(value.outcome) ? value.outcome : 'unavailable'
    } catch {
      return request.signal?.aborted ? 'cancelled' : 'unavailable'
    }
  })
}

function isOutcome(value: unknown): value is ApprovalOutcome {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}
