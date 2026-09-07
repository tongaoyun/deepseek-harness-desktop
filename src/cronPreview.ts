const MAX_MINUTES = 366 * 24 * 60

export interface CronPreset { label: string; expression: string }

export const cronPresets: CronPreset[] = [
  { label: '每天 9:00', expression: '0 9 * * *' },
  { label: '工作日 9:00', expression: '0 9 * * 1-5' },
  { label: '每天 18:00', expression: '0 18 * * *' },
  { label: '每周一 9:00', expression: '0 9 * * 1' },
  { label: '每月 1 日 9:00', expression: '0 9 1 * *' },
]

export function nextCronRuns(expression: string, timeZone: string, count = 3, from = new Date()): Date[] {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*,/-]+$/.test(field))
    || !Number.isSafeInteger(count) || count <= 0 || !Number.isFinite(from.getTime()) || !timeZone.trim()) return []
  try {
    const schedule = new Cron(fields.join(' '), {
      timezone: timeZone, domAndDow: true, paused: true,
      stopAt: new Date(Math.floor(from.getTime() / 60_000) * 60_000 + MAX_MINUTES * 60_000),
    })
    return schedule.nextRuns(count, from)
  } catch { return [] }
}
import { Cron } from 'croner'
