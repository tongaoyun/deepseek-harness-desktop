import type { LocalScheduleRun } from './localSchedules'

export const scheduleRunLabels: Record<LocalScheduleRun['status'], string> = {
  RUNNING: '执行中', COMPLETED: '成功', FAILED: '失败', CANCELED: '已停止', INTERRUPTED: '已中断', MISSED: '已错过',
}
export type RecordGrouping = 'day' | 'week' | 'month'
export function scheduleRecordGroup(at: string, grouping: RecordGrouping): string {
  const date = new Date(at)
  if (grouping === 'month') return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`
  if (grouping === 'week') date.setDate(date.getDate() - (date.getDay() + 6) % 7)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}${grouping === 'week' ? ' 起的一周' : ''}`
}
