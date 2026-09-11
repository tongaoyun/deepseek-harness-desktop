import { createTaskMonitor } from './harness'
import {
  beginExecutionTurn,
  completeExecutionTurn,
  failExecutionTurn,
  observeHarnessNotification,
  projectExecutionThread,
  updateExecutionProgress,
} from './executionRuntime'
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
        ...(message.role === 'assistant' && message.outcome ? { monitor: imMessageProjection(message.createdAt, message.outcome) } : {}),
      }))
    const processed = new Set(task.processedImEventIds ?? [])
    const notifications = conversations.flatMap((item) => item.taskEvents ?? [])
      .filter((event) => !processed.has(event.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    let execution = task.execution
    let monitor = execution ? projectExecutionThread(execution) ?? task.monitor : task.monitor
    if (current && (!execution?.activeTurnId) && (notifications.length > 0 || latest.status === 'RUNNING')) {
      const started = beginExecutionTurn({
        taskId: task.id,
        sessionId: latest.sessionId || task.sessionId || '',
        operationScope: `im:${latest.conversationKey}:${latest.updatedAt}`,
        previous: execution,
        now: notifications[0]?.createdAt ?? latest.updatedAt,
      })
      execution = started.thread
      monitor = started.monitor
    }
    for (const notification of notifications) {
      if (current && execution?.activeTurnId) {
        const observed = observeHarnessNotification(execution, monitor, { requestId: 0, event: { event: notification.event } })
        execution = observed.thread
        monitor = observed.monitor
      }
      processed.add(notification.id)
    }
    if (current && execution?.activeTurnId) {
      const terminal = latest.status === 'RUNNING'
        ? updateExecutionProgress(execution, monitor, '正在通过钉钉继续任务', latest.updatedAt)
        : latest.status === 'FAILED'
          ? failExecutionTurn(execution, monitor, {
            cause: 'failure', now: latest.updatedAt,
            failure: { code: 'XY-IM', category: 'unknown', message: '钉钉任务执行失败' },
          })
          : completeExecutionTurn(execution, monitor, parseTaskOutcome(latest.outcome) ?? unverifiedTaskOutcome(), latest.updatedAt)
      execution = terminal.thread
      monitor = terminal.monitor
    }
    const taskStatus = latest.status === 'RUNNING' ? 'RUNNING' : latest.status === 'FAILED' ? 'FAILED' : 'COMPLETED'
    const updated: LocalTaskRun = {
      ...task,
      status: current ? taskStatus : task.status,
      sessionId: current ? latest.sessionId || task.sessionId : task.sessionId,
      updatedAt: latest.updatedAt > task.updatedAt ? latest.updatedAt : task.updatedAt,
      execution,
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

function imMessageProjection(updatedAt: string, reportedOutcome: TaskOutcome): TaskMonitorState {
  const outcome = parseTaskOutcome(reportedOutcome) ?? unverifiedTaskOutcome()
  return { ...createTaskMonitor(updatedAt), outcome, status: 'completed', activity: taskOutcomeLabel(outcome), updatedAt }
}
