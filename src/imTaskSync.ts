import { applyHarnessNotification } from './harness'
import type { LocalImStatus } from './localIm'
import type { LocalTaskRun, TaskMonitorState } from './types'

export function mergeImStatusIntoTasks(
  tasks: LocalTaskRun[], status: LocalImStatus,
): { tasks: LocalTaskRun[]; changed: LocalTaskRun[] } {
  const changed: LocalTaskRun[] = []
  const next = tasks.map((task) => {
    const conversations = status.conversations.filter((item) => item.boundTaskId === task.id)
    if (conversations.length === 0) return task
    const messageIds = new Set(task.messages.map((message) => message.id).filter(Boolean))
    const incomingMessages = conversations.flatMap((item) => item.messages ?? [])
      .filter((message) => !messageIds.has(message.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((message) => ({ ...message, source: 'dingtalk' as const }))
    const processed = new Set(task.processedImEventIds ?? [])
    let monitor = task.monitor
    for (const notification of conversations.flatMap((item) => item.taskEvents ?? [])
      .filter((event) => !processed.has(event.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      monitor = applyHarnessNotification(monitor, { requestId: 0, event: { event: notification.event } })
      processed.add(notification.id)
    }
    const latest = [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!
    monitor = terminalMonitor(monitor, latest.status, latest.updatedAt)
    const taskStatus = latest.status === 'RUNNING' ? 'RUNNING' : latest.status === 'FAILED' ? 'FAILED' : 'COMPLETED'
    const updated: LocalTaskRun = {
      ...task,
      status: taskStatus,
      sessionId: latest.sessionId || task.sessionId,
      updatedAt: latest.updatedAt > task.updatedAt ? latest.updatedAt : task.updatedAt,
      monitor,
      messages: [...task.messages, ...incomingMessages],
      processedImEventIds: [...processed].slice(-1_000),
    }
    if (JSON.stringify(updated) === JSON.stringify(task)) return task
    changed.push(updated)
    return updated
  })
  return { tasks: changed.length > 0 ? next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : tasks, changed }
}

function terminalMonitor(
  monitor: TaskMonitorState, status: 'RUNNING' | 'COMPLETED' | 'FAILED', updatedAt: string,
): TaskMonitorState {
  if (status === 'RUNNING') return { ...monitor, status: 'running', activity: '正在通过钉钉继续任务', updatedAt }
  if (status === 'FAILED') return { ...monitor, status: 'failed', activity: '钉钉任务执行失败', updatedAt }
  return { ...monitor, status: 'completed', activity: '已通过钉钉完成回复', updatedAt }
}
