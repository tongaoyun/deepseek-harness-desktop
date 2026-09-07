import { submitAuditEvent } from './api'
import { taskOutcomeLabel, type TaskOutcome } from './taskOutcome'

export async function reportTaskAudit({
  accessToken,
  employeeId,
  endpoint,
  outcome,
  taskId,
  taskOutcome,
}: {
  accessToken: string
  employeeId: string
  endpoint: string
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELED'
  taskId: string
  taskOutcome?: TaskOutcome
}): Promise<void> {
  await submitAuditEvent(endpoint, employeeId, accessToken, {
    source: 'DESKTOP',
    category: 'AGENT',
    action: 'desktop.agent.run',
    outcome,
    resourceType: 'desktop-task',
    resourceId: taskId,
    summary: taskOutcome ? `桌面任务：${taskOutcomeLabel(taskOutcome)}` : outcome === 'SUCCEEDED' ? '桌面任务执行完成' : outcome === 'CANCELED' ? '用户已停止本轮桌面任务' : '桌面任务执行失败',
  }).catch(() => undefined)
}
