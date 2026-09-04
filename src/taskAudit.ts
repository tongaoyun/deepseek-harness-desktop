import { submitAuditEvent } from './api'

export async function reportTaskAudit({
  accessToken,
  employeeId,
  endpoint,
  outcome,
  taskId,
}: {
  accessToken: string
  employeeId: string
  endpoint: string
  outcome: 'SUCCEEDED' | 'FAILED'
  taskId: string
}): Promise<void> {
  await submitAuditEvent(endpoint, employeeId, accessToken, {
    source: 'DESKTOP',
    category: 'AGENT',
    action: 'desktop.agent.run',
    outcome,
    resourceType: 'desktop-task',
    resourceId: taskId,
    summary: outcome === 'SUCCEEDED' ? '桌面 Agent 执行完成' : '桌面 Agent 执行失败',
  }).catch(() => undefined)
}
