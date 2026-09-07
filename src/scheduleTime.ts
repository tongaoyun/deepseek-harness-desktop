import { nextLocalRun, type LocalScheduleInput } from './localSchedules'

export type Frequency = 'once' | 'interval' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'
export const frequencies: { value: Frequency; label: string }[] = [
  { value: 'once', label: '不重复' }, { value: 'interval', label: '间隔' },
  { value: 'hourly', label: '每小时' }, { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' }, { value: 'monthly', label: '每月' }, { value: 'custom', label: '自定义' },
]
export function frequencyOf(input: LocalScheduleInput): Frequency {
  if (input.timing) return input.timing.kind
  if (input.timeZoneMode === 'fixed') return 'custom'
  const [m, h, d, month, w] = input.cronExpression.split(' ')
  if (!/^\d+$/.test(m) || month !== '*') return 'custom'
  if (h === '*' && d === '*' && w === '*') return 'hourly'
  if (!/^\d+$/.test(h)) return 'custom'
  if (d === '*' && w === '*') return 'daily'
  if (d === '*' && (/^[0-6](,[0-6])*$/.test(w) || w === '1-5')) return 'weekly'
  if (/^\d+$/.test(d) && w === '*') return 'monthly'
  return 'custom'
}
export function scheduleLabel(input: LocalScheduleInput): string {
  if (input.timing?.kind === 'once') return `不重复 · ${new Date(input.timing.at).toLocaleString('zh-CN')}`
  if (input.timing?.kind === 'interval') return `每隔 ${input.timing.minutes} 分钟`
  const [m, h, d, , w] = input.cronExpression.split(' ')
  const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`
  switch (frequencyOf(input)) {
    case 'hourly': return `每小时 ${m} 分`
    case 'daily': return `每天 ${time}`
    case 'weekly': return `${w === '1-5' || w === '1,2,3,4,5' ? '工作日' : `每周${w.split(',').map((day) => '日一二三四五六'[Number(day)]).join('、')}`} ${time}`
    case 'monthly': return `每月 ${d} 日 ${time}`
    default: return w === '1-5' && d === '*' ? `工作日 ${time}` : `自定义 · ${input.cronExpression}`
  }
}
export function schedulePreview(input: LocalScheduleInput): string {
  try { return `下次执行：${new Date(nextLocalRun(input, new Date())).toLocaleString('zh-CN')}` }
  catch (error) { return error instanceof Error ? error.message : String(error) }
}
