import { parseTaskOutcome, unverifiedTaskOutcome, type TaskOutcome } from '../harness-host/src/task-outcome'
import type { LocalTaskRun } from './types'

export { parseTaskOutcome, unverifiedTaskOutcome }
export type { TaskOutcome }

const labels: Record<TaskOutcome['status'], string> = {
  completed: '已完成', partial: '部分完成', needs_input: '等待补充',
  needs_confirmation: '等待确认', blocked: '受阻', unverified: '本轮已结束',
}
export function taskOutcomeLabel(outcome: unknown): string {
  const parsed = parseTaskOutcome(outcome)
  return parsed ? labels[parsed.status] : '本轮已结束'
}
export function isUnverifiedTaskOutcome(outcome: unknown): boolean {
  return parseTaskOutcome(outcome)?.status === 'unverified'
}
export function taskStatusLabel(task: LocalTaskRun): string {
  if (task.status === 'RUNNING') return '运行中'
  if (task.status === 'CANCELED') return '已停止'
  if (task.status === 'FAILED') return task.monitor.failure?.code === 'XY-INTERRUPTED' ? '已中断' : '执行失败'
  return taskOutcomeLabel(task.monitor.outcome)
}
