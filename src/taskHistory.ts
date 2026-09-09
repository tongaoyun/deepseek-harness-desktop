import { invoke, isTauri } from '@tauri-apps/api/core'
import type { LocalTaskRun } from './types'
import { taskInterruption } from './taskInterruption'

const LIMIT = 200
const writes = new Map<string, Promise<void>>()

function orderedWrite(employeeId: string, id: string, write: () => Promise<void>): Promise<void> {
  const key = JSON.stringify([employeeId, id])
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(write)
  writes.set(key, next)
  void next.finally(() => { if (writes.get(key) === next) writes.delete(key) }).catch(() => undefined)
  return next
}

export interface LocalTaskPage {
  items: LocalTaskRun[]
  total: number
  offset: number
  limit: number
}

export async function loadTaskHistoryPage(employeeId: string, query = '', offset = 0, excludeIds: string[] = []): Promise<LocalTaskPage> {
  await Promise.all([...writes.entries()].filter(([key]) => JSON.parse(key)[0] === employeeId).map(([, write]) => write.catch(() => undefined)))
  if (isTauri()) {
    const page = await invoke<LocalTaskPage>('load_local_tasks', { employeeId, query: { query, offset, limit: LIMIT, excludeIds } })
    // Loaded live tasks take precedence in App; older interrupted tasks must not look active.
    return { ...page, items: recoverInterruptedTasks(validTasks(page.items)) }
  }
  const needle = query.trim().toLocaleLowerCase()
  const excluded = new Set(excludeIds)
  const tasks = loadLocalTasks(employeeId).filter((task) => !excluded.has(task.id) && (!needle || task.name.toLocaleLowerCase().includes(needle)
    || task.messages.some((message) => message.text.toLocaleLowerCase().includes(needle))))
  return { items: recoverInterruptedTasks(tasks.slice(offset, offset + LIMIT)), total: tasks.length, offset, limit: LIMIT }
}

export async function loadTaskById(employeeId: string, id: string): Promise<LocalTaskRun | undefined> {
  await writes.get(JSON.stringify([employeeId, id]))?.catch(() => undefined)
  const task = isTauri() ? await invoke<unknown>('load_local_task', { employeeId, id }) : loadLocalTasks(employeeId).find((item) => item.id === id)
  if (task == null) return undefined
  if (!isLocalTask(task)) throw new Error('本地会话数据无效，原始数据已保留')
  return recoverInterruptedTasks([task])[0]
}

export async function loadTaskHistory(employeeId: string): Promise<LocalTaskRun[]> {
  await Promise.all([...writes.entries()].filter(([key]) => JSON.parse(key)[0] === employeeId).map(([, write]) => write.catch(() => undefined)))
  if (!isTauri()) return recoverInterruptedTasks(loadLocalTasks(employeeId).slice(0, LIMIT))
  const page = await invoke<LocalTaskPage>('load_local_tasks', {
    employeeId,
    query: { query: '', offset: 0, limit: LIMIT },
  })
  if (page.items.length > 0) {
    const tasks = validTasks(page.items)
    const recovered = recoverInterruptedTasks(tasks)
    await Promise.all(recovered.filter((task, index) => task !== tasks[index])
      .map((task) => invoke('save_local_task', { employeeId, task })))
    return recovered
  }
  const localStorageTasks = loadLocalTasks(employeeId)
  const migrated = recoverInterruptedTasks(localStorageTasks)
  await Promise.all(migrated.map((task) => invoke('save_local_task', { employeeId, task })))
  window.localStorage.removeItem(storageKey(employeeId))
  return migrated.slice(0, LIMIT)
}

export function recoverInterruptedTasks(tasks: LocalTaskRun[], now = new Date().toISOString()): LocalTaskRun[] {
  return tasks.map((task) => {
    if (task.status !== 'RUNNING') return task
    const monitor = {
      ...task.monitor,
      interruption: taskInterruption(task.monitor, 'exit', task.updatedAt),
      status: 'failed' as const,
      activity: '上次运行已中断',
      failure: { code: 'XY-INTERRUPTED', category: 'local-agent' as const, detail: '应用关闭或本地执行进程中断，已保留最近保存的进度与成果。' },
      updatedAt: now,
      completedAt: task.updatedAt,
      steps: task.monitor.steps.map((step) => step.status === 'running'
        ? { ...step, label: `${step.label}（结果待核对）`, status: 'canceled' as const, completedAt: task.updatedAt }
        : step),
      timeline: task.monitor.timeline?.map((entry) => entry.status === 'running'
        ? { ...entry, label: `${entry.label}（结果待核对）`, status: 'canceled' as const, completedAt: task.updatedAt }
        : entry),
      subagents: task.monitor.subagents?.map((agent) => agent.status === 'running'
        ? { ...agent, status: 'canceled' as const, completedAt: task.updatedAt }
        : agent),
    }
    const interrupted = {
      role: 'assistant' as const,
      text: [task.messages.at(-1)?.role === 'assistant' && task.messages.at(-1)?.pending ? task.messages.at(-1)!.text.trim() : '',
        '上次任务因应用关闭或本地 Agent 中断，未能完成。已保留最近保存的进度与成果，请检查实际结果后继续，不要重复已经完成的操作。'].filter(Boolean).join('\n\n'),
      monitor,
    }
    const messages = task.messages.at(-1)?.role === 'assistant' && task.messages.at(-1)?.pending
      ? [...task.messages.slice(0, -1), interrupted]
      : [...task.messages, interrupted]
    return { ...task, sessionId: undefined, status: 'FAILED' as const, updatedAt: now, monitor, messages }
  })
}

export async function persistTaskHistory(employeeId: string, task: LocalTaskRun): Promise<void> {
  const durable = structuredClone(compactTaskForStorage(task))
  await orderedWrite(employeeId, task.id, async () => {
    if (!isTauri()) saveLocalTask(employeeId, durable)
    else await invoke('save_local_task', { employeeId, task: durable })
  })
}

export async function removeTaskHistory(employeeId: string, id: string): Promise<void> {
  await orderedWrite(employeeId, id, async () => {
    if (!isTauri()) {
      const values = loadLocalTasks(employeeId).filter((task) => task.id !== id)
      window.localStorage.setItem(storageKey(employeeId), JSON.stringify(values))
    } else await invoke('delete_local_task', { employeeId, id })
  })
}

export function loadLocalTasks(employeeId: string, storage: Storage = window.localStorage): LocalTaskRun[] {
  try {
    const value = JSON.parse(storage.getItem(storageKey(employeeId)) ?? '[]')
    if (!Array.isArray(value) || !value.every(isLocalTask)) throw new Error('会话格式无效')
    return value.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  } catch {
    throw new Error('本地历史无法读取，原始数据已保留；请检查存储后重试，不会覆盖为空历史')
  }
}

function validTasks(values: unknown[]): LocalTaskRun[] {
  if (!values.every(isLocalTask)) throw new Error('本地会话数据无效，原始数据已保留')
  return values.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function saveLocalTask(employeeId: string, task: LocalTaskRun,
                              storage: Storage = window.localStorage): LocalTaskRun[] {
  task = compactTaskForStorage(task)
  const tasks = loadLocalTasks(employeeId, storage)
  const updated = [task, ...tasks.filter((item) => item.id !== task.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  storage.setItem(storageKey(employeeId), JSON.stringify(updated))
  return updated
}

export function compactTaskForStorage(task: LocalTaskRun): LocalTaskRun {
  // Display pagination and model context limits must never truncate durable history.
  return task
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
    && task.messages.every((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')
    && isTaskMonitor(task.monitor)
}

function isTaskMonitor(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const monitor = value as Partial<LocalTaskRun['monitor']>
  return ['idle', 'running', 'completed', 'failed', 'canceled'].includes(monitor.status ?? '')
    && typeof monitor.activity === 'string' && typeof monitor.updatedAt === 'string'
    && Array.isArray(monitor.steps) && Array.isArray(monitor.artifacts)
}
