import type { LocalTaskRun } from './types'

const LIMIT = 100

export function loadLocalTasks(employeeId: string, storage: Storage = window.localStorage): LocalTaskRun[] {
  try {
    const value = JSON.parse(storage.getItem(storageKey(employeeId)) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(isLocalTask).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, LIMIT)
  } catch {
    return []
  }
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
    && ['RUNNING', 'COMPLETED', 'FAILED'].includes(task.status ?? '')
    && typeof task.createdAt === 'string' && typeof task.updatedAt === 'string' && Array.isArray(task.messages)
}
