import { normalizeHarnessProjection } from './harness'
import type { ConversationEntry } from './conversation/types'
import type { LocalImStatus } from './localIm'
import type { LocalTaskRun } from './types'

export function mergeImStatusIntoTasks(
  tasks: LocalTaskRun[], status: LocalImStatus,
): { tasks: LocalTaskRun[]; changed: LocalTaskRun[] } {
  const changed: LocalTaskRun[] = []
  const next = tasks.map((task) => {
    const conversations = status.conversations.filter((item) => item.boundTaskId === task.id)
    if (conversations.length === 0) return task
    const latest = [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!
    const current = Date.parse(latest.updatedAt) >= Date.parse(task.updatedAt)
    const entryIds = new Set(task.entries.map((entry) => entry.id))
    const incomingEntries: ConversationEntry[] = conversations.flatMap((item) => item.messages ?? [])
      .filter((message) => {
        if (entryIds.has(message.id)) return false
        entryIds.add(message.id)
        return true
      })
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((message) => message.role === 'user'
        ? { id: message.id, role: 'user' as const, text: message.text, source: 'dingtalk' as const }
        : {
            id: message.id,
            role: 'assistant' as const,
            status: 'completed' as const,
            segments: [{ kind: 'text' as const, id: `${message.id}:text`, text: message.text }],
            meta: {},
          })
    let projection = task.projection
    if (current) {
      const storedProduct = latest.taskProjection ? normalizeHarnessProjection(latest.taskProjection) : undefined
      const storedProjection = storedProduct ? { ...projection, updatedAt: storedProduct.updatedAt, changes: storedProduct.changes, artifacts: storedProduct.artifacts, visuals: storedProduct.visuals, knowledgeSources: storedProduct.knowledgeSources } : undefined
      projection = storedProjection ?? (latest.status === 'RUNNING'
        ? { ...projection, status: 'running', activity: '正在通过钉钉继续任务', updatedAt: latest.updatedAt }
        : latest.status === 'FAILED'
          ? { ...projection, status: 'failed', activity: '钉钉任务执行失败', updatedAt: latest.updatedAt, completedAt: latest.updatedAt }
          : { ...projection, status: 'completed', activity: '任务已完成', updatedAt: latest.updatedAt, completedAt: latest.updatedAt })
      if (latest.status !== 'RUNNING') {
        projection = latest.status === 'FAILED'
          ? { ...projection, status: 'failed', activity: '钉钉任务执行失败', updatedAt: latest.updatedAt, completedAt: latest.updatedAt }
          : { ...projection, status: 'completed', activity: '任务已完成', updatedAt: latest.updatedAt, completedAt: latest.updatedAt }
      }
    }
    const taskStatus = latest.status === 'RUNNING' ? 'RUNNING' : latest.status === 'FAILED' ? 'FAILED' : 'COMPLETED'
    const updated: LocalTaskRun = {
      ...task,
      status: current ? taskStatus : task.status,
      sessionId: current ? latest.sessionId || task.sessionId : task.sessionId,
      updatedAt: latest.updatedAt > task.updatedAt ? latest.updatedAt : task.updatedAt,
      projection,
      entries: [...task.entries, ...incomingEntries],
    }
    if (JSON.stringify(updated) === JSON.stringify(task)) return task
    changed.push(updated)
    return updated
  })
  return { tasks: changed.length > 0 ? next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : tasks, changed }
}
