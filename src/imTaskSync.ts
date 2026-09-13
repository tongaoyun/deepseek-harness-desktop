import { createXiaoyinTaskProjection, normalizeHarnessProjection } from './harness'
import type { LocalImStatus } from './localIm'
import type { LocalTaskRun, XiaoyinTaskProjection } from './types'
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
        ...(message.role === 'assistant' && message.outcome ? { projection: imMessageProjection(message.createdAt, message.outcome) } : {}),
      }))
    let projection = task.projection
    if (current) {
      const outcome = parseTaskOutcome(latest.outcome)
      const storedProjection = latest.taskProjection ? normalizeHarnessProjection(latest.taskProjection) : undefined
      projection = storedProjection ?? (latest.status === 'RUNNING'
        ? { ...projection, status: 'running', activity: '正在通过钉钉继续任务', updatedAt: latest.updatedAt }
        : latest.status === 'FAILED'
          ? { ...projection, status: 'failed', activity: '钉钉任务执行失败', updatedAt: latest.updatedAt, completedAt: latest.updatedAt }
          : { ...projection, status: 'completed', activity: taskOutcomeLabel(outcome ?? unverifiedTaskOutcome()), outcome: outcome ?? unverifiedTaskOutcome(), updatedAt: latest.updatedAt, completedAt: latest.updatedAt })
      if (latest.status !== 'RUNNING') {
        projection = latest.status === 'FAILED'
          ? { ...projection, status: 'failed', activity: '钉钉任务执行失败', updatedAt: latest.updatedAt, completedAt: latest.updatedAt }
          : { ...projection, status: 'completed', activity: taskOutcomeLabel(outcome ?? unverifiedTaskOutcome()), outcome: outcome ?? unverifiedTaskOutcome(), updatedAt: latest.updatedAt, completedAt: latest.updatedAt }
      }
    }
    const taskStatus = latest.status === 'RUNNING' ? 'RUNNING' : latest.status === 'FAILED' ? 'FAILED' : 'COMPLETED'
    const updated: LocalTaskRun = {
      ...task,
      status: current ? taskStatus : task.status,
      sessionId: current ? latest.sessionId || task.sessionId : task.sessionId,
      updatedAt: latest.updatedAt > task.updatedAt ? latest.updatedAt : task.updatedAt,
      projection,
      messages: [...task.messages, ...incomingMessages],
    }
    if (JSON.stringify(updated) === JSON.stringify(task)) return task
    changed.push(updated)
    return updated
  })
  return { tasks: changed.length > 0 ? next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : tasks, changed }
}

function imMessageProjection(updatedAt: string, reportedOutcome: TaskOutcome): XiaoyinTaskProjection {
  const outcome = parseTaskOutcome(reportedOutcome) ?? unverifiedTaskOutcome()
  return { ...createXiaoyinTaskProjection(updatedAt), outcome, status: 'completed', activity: taskOutcomeLabel(outcome), updatedAt }
}
