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
  if (fields.length !== 5) return []
  const [minute, hour, day, month, weekday] = [
    parseField(fields[0], 0, 59), parseField(fields[1], 0, 23), parseField(fields[2], 1, 31),
    parseField(fields[3], 1, 12), parseField(fields[4], 0, 7),
  ]
  if ([minute, hour, day, month, weekday].some((value) => value === null)) return []
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, minute: '2-digit', hour: '2-digit',
      day: '2-digit', month: '2-digit', weekday: 'short' })
  } catch { return [] }
  const result: Date[] = []
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)
  for (let offset = 0; offset < MAX_MINUTES && result.length < count; offset++, candidate.setMinutes(candidate.getMinutes() + 1)) {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]))
    const currentWeekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
    if (minute!.has(Number(parts.minute)) && hour!.has(Number(parts.hour) % 24)
      && day!.has(Number(parts.day)) && month!.has(Number(parts.month))
      && (weekday!.has(currentWeekday) || currentWeekday === 0 && weekday!.has(7))) result.push(new Date(candidate))
  }
  return result
}

function parseField(value: string, minimum: number, maximum: number): Set<number> | null {
  const result = new Set<number>()
  for (const segment of value.split(',')) {
    const [rangeText, stepText] = segment.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null
    let start = minimum
    let end = maximum
    if (rangeText !== '*') {
      const bounds = rangeText.split('-').map(Number)
      if (bounds.some((item) => !Number.isInteger(item))) return null
      start = bounds[0]
      end = bounds.length === 1 ? bounds[0] : bounds[1]
    }
    if (start < minimum || end > maximum || start > end) return null
    for (let current = start; current <= end; current += step) result.add(current)
  }
  return result
}
