import { invoke, isTauri } from '@tauri-apps/api/core'
import type { LocalTaskRun } from './types'

const LIMIT = 200
const MAX_STORED_MESSAGES = 120
const MAX_MESSAGE_CHARS = 240_000
const MAX_STORED_BYTES = 7 * 1024 * 1024

interface LocalTaskPage {
  items: LocalTaskRun[]
  total: number
  offset: number
  limit: number
}

export async function loadTaskHistory(employeeId: string): Promise<LocalTaskRun[]> {
  if (!isTauri()) return recoverInterruptedTasks(loadLocalTasks(employeeId))
  const localStorageTasks = loadLocalTasks(employeeId)
  const page = await invoke<LocalTaskPage>('load_local_tasks', {
    employeeId,
    query: { query: '', offset: 0, limit: LIMIT },
  })
  if (page.items.length > 0 || localStorageTasks.length === 0) {
    const tasks = validTasks(page.items)
    const recovered = recoverInterruptedTasks(tasks)
    await Promise.all(recovered.filter((task, index) => task !== tasks[index])
      .map((task) => invoke('save_local_task', { employeeId, task })))
    return recovered
  }
  const migrated = recoverInterruptedTasks(localStorageTasks)
  await Promise.all(migrated.map((task) => invoke('save_local_task', { employeeId, task })))
  window.localStorage.removeItem(storageKey(employeeId))
  return migrated
}

export function recoverInterruptedTasks(tasks: LocalTaskRun[], now = new Date().toISOString()): LocalTaskRun[] {
  return tasks.map((task) => {
    if (task.status !== 'RUNNING') return task
    const monitor = {
      ...task.monitor,
      status: 'failed' as const,
      activity: '上次运行已中断',
      updatedAt: now,
      completedAt: now,
      steps: task.monitor.steps.map((step) => step.status === 'running'
        ? { ...step, status: 'failed' as const, completedAt: now }
        : step),
      timeline: task.monitor.timeline?.map((entry) => entry.status === 'running'
        ? { ...entry, status: 'failed' as const, completedAt: now }
        : entry),
      subagents: task.monitor.subagents?.map((agent) => agent.status === 'running'
        ? { ...agent, status: 'failed' as const, completedAt: now }
        : agent),
    }
    const interrupted = {
      role: 'assistant' as const,
      text: '上次任务因应用关闭或本地 Agent 中断，未能完成。可以直接重试。',
      monitor,
    }
    const messages = task.messages.at(-1)?.role === 'assistant' && task.messages.at(-1)?.pending
      ? [...task.messages.slice(0, -1), interrupted]
      : [...task.messages, interrupted]
    return { ...task, status: 'FAILED' as const, updatedAt: now, monitor, messages }
  })
}

export async function persistTaskHistory(employeeId: string, task: LocalTaskRun): Promise<void> {
  const durable = compactTaskForStorage(task)
  if (!isTauri()) {
    saveLocalTask(employeeId, durable)
    return
  }
  await invoke('save_local_task', { employeeId, task: durable })
}

export async function removeTaskHistory(employeeId: string, id: string): Promise<void> {
  if (!isTauri()) {
    const values = loadLocalTasks(employeeId).filter((task) => task.id !== id)
    window.localStorage.setItem(storageKey(employeeId), JSON.stringify(values))
    return
  }
  await invoke('delete_local_task', { employeeId, id })
}

export function loadLocalTasks(employeeId: string, storage: Storage = window.localStorage): LocalTaskRun[] {
  try {
    const value = JSON.parse(storage.getItem(storageKey(employeeId)) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(isLocalTask).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, LIMIT)
  } catch {
    return []
  }
}

function validTasks(values: unknown[]): LocalTaskRun[] {
  return values.filter(isLocalTask).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, LIMIT)
}

export function saveLocalTask(employeeId: string, task: LocalTaskRun,
                              storage: Storage = window.localStorage): LocalTaskRun[] {
  task = compactTaskForStorage(task)
  const tasks = loadLocalTasks(employeeId, storage)
  const updated = [task, ...tasks.filter((item) => item.id !== task.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, LIMIT)
  storage.setItem(storageKey(employeeId), JSON.stringify(updated))
  return updated
}

export function compactTaskForStorage(task: LocalTaskRun): LocalTaskRun {
  let messages = task.messages.slice(-MAX_STORED_MESSAGES).map((message, index, values) => ({
    ...message,
    text: boundedMessage(message.text),
    // Old execution traces are the largest repeated part of long conversations.
    // Keep recent traces and the task-level final monitor; visible answer text is preserved.
    ...(index < values.length - 30 ? { monitor: undefined } : {}),
  }))
  let compacted = { ...task, messages }
  while (messages.length > 4 && new TextEncoder().encode(JSON.stringify(compacted)).byteLength > MAX_STORED_BYTES) {
    messages = messages.slice(2)
    compacted = { ...compacted, messages }
  }
  return compacted
}

function boundedMessage(value: string): string {
  if (value.length <= MAX_MESSAGE_CHARS) return value
  const half = Math.floor(MAX_MESSAGE_CHARS / 2)
  return `${value.slice(0, half)}\n\n……较长内容已折叠……\n\n${value.slice(-half)}`
}

function storageKey(employeeId: string): string {
  return `xiaoyin.task-history.${employeeId}`
}

function isLocalTask(value: unknown): value is LocalTaskRun {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<LocalTaskRun>
  return typeof task.id === 'string' && task.source === 'DESKTOP' && typeof task.name === 'string'
    && ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED'].includes(task.status ?? '')
    && typeof task.createdAt === 'string' && typeof task.updatedAt === 'string' && Array.isArray(task.messages)
    && isTaskMonitor(task.monitor)
}

function isTaskMonitor(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const monitor = value as Partial<LocalTaskRun['monitor']>
  return ['idle', 'running', 'completed', 'failed', 'canceled'].includes(monitor.status ?? '')
    && typeof monitor.activity === 'string' && typeof monitor.updatedAt === 'string'
    && Array.isArray(monitor.steps) && Array.isArray(monitor.artifacts)
}
