import type { XiaoyinTaskProjection } from './types'

export function taskDurationLabel(projection: XiaoyinTaskProjection, now = Date.now()): string {
  const startedAt = projection.startedAt ?? projection.steps[0]?.startedAt
  if (!startedAt) return ''
  const start = Date.parse(startedAt)
  const end = projection.status === 'running' ? now : Date.parse(projection.completedAt ?? projection.updatedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ''
  const seconds = Math.max(1, Math.round((end - start) / 1_000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes}分钟${remainder}秒` : `${remainder}秒`
}
