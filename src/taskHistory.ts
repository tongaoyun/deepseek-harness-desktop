import { invoke, isTauri } from '@tauri-apps/api/core'
import type { LocalTaskRun } from './types'

const LIMIT = 200

interface LocalTaskPage {
  items: LocalTaskRun[]
  total: number
  offset: number
  limit: number
}

export async function loadTaskHistory(employeeId: string): Promise<LocalTaskRun[]> {
  if (!isTauri()) return loadLocalTasks(employeeId)
  const localStorageTasks = loadLocalTasks(employeeId)
  const page = await invoke<LocalTaskPage>('load_local_tasks', {
    employeeId,
    query: { query: '', offset: 0, limit: LIMIT },
  })
  if (page.items.length > 0 || localStorageTasks.length === 0) return validTasks(page.items)
  await Promise.all(localStorageTasks.map((task) => invoke('save_local_task', { employeeId, task })))
  window.localStorage.removeItem(storageKey(employeeId))
  return localStorageTasks
}

export async function persistTaskHistory(employeeId: string, task: LocalTaskRun): Promise<void> {
  if (!isTauri()) {
    saveLocalTask(employeeId, task)
    return
  }
  await invoke('save_local_task', { employeeId, task })
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
  const tasks = loadLocalTasks(employeeId, storage)
  const updated = [task, ...tasks.filter((item) => item.id !== task.id)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, LIMIT)
  storage.setItem(storageKey(employeeId), JSON.stringify(updated))
  return updated
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
