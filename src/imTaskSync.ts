import { applyHarnessNotification } from './harness'
import type { LocalImStatus } from './localIm'
import type { LocalTaskRun, TaskMonitorState } from './types'
import { parseTaskOutcome, taskOutcomeLabel, unverifiedTaskOutcome, type TaskOutcome } from './taskOutcome'

export function mergeImStatusIntoTasks(
  tasks: LocalTaskRun[], status: LocalImStatus,
): { tasks: LocalTaskRun[]; changed: LocalTaskRun[] } {
  const changed: LocalTaskRun[] = []
  const next = tasks.map((task) => {
    const conversations = status.conversations.filter((item) => item.boundTaskId === task.id)
    if (conversations.length === 0) return task
    const latest = [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!
    const current = Date.parse(latest.updatedAt) >= Date.parse(task.updatedAt)
    const messageIds = new Set(task.messages.map((message) => message.id).filter(Boolean))
    const incomingMessages = conversations.flatMap((item) => item.messages ?? [])
      .filter((message) => {
        if (messageIds.has(message.id)) return false
        messageIds.add(message.id)
        return true
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((message) => ({ ...message, source: 'dingtalk' as const,
        ...(message.role === 'assistant' && message.outcome ? { monitor: terminalMonitor({ status: 'idle', activity: '', updatedAt: message.createdAt, steps: [], artifacts: [] }, 'COMPLETED', message.createdAt, message.outcome) } : {}),
      }))
    const processed = new Set(task.processedImEventIds ?? [])
    let monitor = task.monitor
    for (const notification of conversations.flatMap((item) => item.taskEvents ?? [])
      .filter((event) => !processed.has(event.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      if (current) monitor = applyHarnessNotification(monitor, { requestId: 0, event: { event: notification.event } })
      processed.add(notification.id)
    }
    if (current) monitor = terminalMonitor(monitor, latest.status, latest.updatedAt, latest.outcome)
    const taskStatus = latest.status === 'RUNNING' ? 'RUNNING' : latest.status === 'FAILED' ? 'FAILED' : 'COMPLETED'
    const updated: LocalTaskRun = {
      ...task,
      status: current ? taskStatus : task.status,
      sessionId: current ? latest.sessionId || task.sessionId : task.sessionId,
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
  monitor: TaskMonitorState, status: 'RUNNING' | 'COMPLETED' | 'FAILED', updatedAt: string, reportedOutcome?: TaskOutcome,
): TaskMonitorState {
  if (status === 'RUNNING') return { ...monitor, outcome: undefined, status: 'running', activity: '正在通过钉钉继续任务', updatedAt }
  if (status === 'FAILED') return { ...monitor, outcome: undefined, status: 'failed', activity: '钉钉任务执行失败', updatedAt }
  const outcome = parseTaskOutcome(reportedOutcome) ?? unverifiedTaskOutcome()
  return { ...monitor, outcome, status: 'completed', activity: taskOutcomeLabel(outcome), updatedAt }
}
