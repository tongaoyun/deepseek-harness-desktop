import { invoke, isTauri } from '@tauri-apps/api/core'
import type { LocalTaskRun } from './types'
import { failExecutionTurn, migrateLegacyExecution, projectExecutionThread, projectExecutionTurn } from './executionRuntime'
import { createTaskMonitor } from './harness'

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
  return recoverInterruptedTasks([canonicalizeTaskProjection(task)])[0]
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
    const running = task.execution
      ? { thread: task.execution, monitor: projectExecutionThread(task.execution) ?? task.monitor }
      : migrateLegacyExecution(
        task.id,
        task.sessionId ?? '',
        { ...task.monitor, operationScope: task.monitor.operationScope ?? crypto.randomUUID() },
        task.monitor.startedAt || task.createdAt || task.updatedAt,
      )
    const failed = failExecutionTurn(running.thread, running.monitor, {
      cause: 'exit', checkpointAt: task.updatedAt, now,
    })
    const { thread: execution, monitor } = failed
    const interrupted = {
      role: 'assistant' as const,
      text: [task.messages.at(-1)?.role === 'assistant' && task.messages.at(-1)?.pending ? task.messages.at(-1)!.text.trim() : '',
        '上次任务因应用关闭或本地 Agent 中断，未能完成。已保留最近保存的进度与成果，请检查实际结果后继续，不要重复已经完成的操作。'].filter(Boolean).join('\n\n'),
      monitor,
      executionTurnId: execution.turns.at(-1)?.id,
    }
    const messages = task.messages.at(-1)?.role === 'assistant' && task.messages.at(-1)?.pending
      ? [...task.messages.slice(0, -1), interrupted]
      : [...task.messages, interrupted]
    return { ...task, sessionId: undefined, status: 'FAILED' as const, updatedAt: now, execution, monitor, messages }
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
    return value.map(canonicalizeTaskProjection).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  } catch {
    throw new Error('本地历史无法读取，原始数据已保留；请检查存储后重试，不会覆盖为空历史')
  }
}

function validTasks(values: unknown[]): LocalTaskRun[] {
  if (!values.every(isLocalTask)) throw new Error('本地会话数据无效，原始数据已保留')
  return values.map((task) => canonicalizeTaskProjection(task)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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
  return canonicalizeTaskProjection(task)
}

function canonicalizeTaskProjection(task: LocalTaskRun): LocalTaskRun {
  if (!task.execution) return task
  const monitor = projectExecutionThread(task.execution)
  if (!monitor) return task
  const turns = task.execution.turns.map((turn) => {
    const projection = projectExecutionTurn(createTaskMonitor(turn.startedAt), turn)
    return { id: turn.id, projection }
  })
  const projectionsById = new Map(turns.map((turn) => [turn.id, turn.projection]))
  const claimedTurnIds = new Set<string>()
  const messages = task.messages.map((message, index) => {
    if (message.role !== 'assistant' || !message.monitor) return message
    let turnId = message.executionTurnId && projectionsById.has(message.executionTurnId)
      ? message.executionTurnId : undefined
    if (!turnId && message.monitor.operationScope) {
      const candidates = turns.filter((turn) => turn.projection.operationScope === message.monitor!.operationScope)
      turnId = candidates.find((turn) => !claimedTurnIds.has(turn.id)
        && (turn.projection.updatedAt === message.monitor!.updatedAt
          || turn.projection.completedAt === message.monitor!.completedAt))?.id
        ?? candidates.find((turn) => !claimedTurnIds.has(turn.id))?.id
        ?? candidates.at(-1)?.id
    }
    if (!turnId && index === task.messages.length - 1) turnId = task.execution!.turns.at(-1)?.id
    const projection = turnId ? projectionsById.get(turnId) : undefined
    if (turnId) claimedTurnIds.add(turnId)
    return projection ? { ...message, executionTurnId: turnId, monitor: projection } : message
  })
  const turnStatus = task.execution.turns.at(-1)?.status
  const status = turnStatus === 'running' ? 'RUNNING'
    : turnStatus === 'completed' ? 'COMPLETED'
      : turnStatus === 'canceled' ? 'CANCELED'
        : turnStatus === 'failed' ? 'FAILED' : task.status
  return { ...task, status, monitor, messages }
}

function storageKey(employeeId: string): string {
  return `xiaoyin.task-history.${employeeId}`
}

function isLocalTask(value: unknown): value is LocalTaskRun {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<LocalTaskRun>
  const executionValid = task.execution !== undefined && isExecutionThread(task.execution)
  return typeof task.id === 'string' && task.source === 'DESKTOP' && typeof task.name === 'string'
    && ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED'].includes(task.status ?? '')
    && typeof task.createdAt === 'string' && typeof task.updatedAt === 'string' && Array.isArray(task.messages)
    && task.messages.every((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string'
      && (message.executionTurnId === undefined || typeof message.executionTurnId === 'string'))
    && (task.execution === undefined || executionValid)
    && (isTaskMonitor(task.monitor) || executionValid)
}

function isExecutionThread(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const thread = value as NonNullable<LocalTaskRun['execution']>
  if (thread.protocolVersion !== 1 || typeof thread.id !== 'string' || !Array.isArray(thread.turns)
    || (thread.activeTurnId !== undefined && typeof thread.activeTurnId !== 'string')) return false
  const valid = thread.turns.every((turn) => turn && typeof turn.id === 'string' && typeof turn.sessionId === 'string'
      && ['running', 'completed', 'failed', 'canceled'].includes(turn.status)
      && typeof turn.startedAt === 'string' && Number.isSafeInteger(turn.nextSequence)
      && turn.sourceCursors && typeof turn.sourceCursors === 'object' && !Array.isArray(turn.sourceCursors)
      && Object.values(turn.sourceCursors).every((sequence) => Number.isSafeInteger(sequence) && sequence > 0)
      && Array.isArray(turn.items) && turn.items.every(isExecutionItem)
      && Array.isArray(turn.events) && turn.events.length > 0
      && turn.events[0]?.type === 'turn.started'
      && turn.events.every((event, index) => event && typeof event.id === 'string'
        && Number.isSafeInteger(event.sequence) && event.sequence > 0
        && (index === 0 || event.sequence > turn.events[index - 1]!.sequence)
        && event.turnId === turn.id && executionEventTypes.has(event.type)
        && typeof event.occurredAt === 'string' && isExecutionProjection(event.projection))
      && turn.nextSequence > turn.events.at(-1)!.sequence)
  return valid && (thread.activeTurnId === undefined
    || thread.turns.some((turn) => turn.id === thread.activeTurnId && turn.status === 'running'))
}

const executionEventTypes = new Set([
  'turn.started', 'turn.retry.started', 'turn.interrupt.requested', 'turn.interrupt.failed', 'turn.progress.updated',
  'item.started', 'item.updated', 'item.completed', 'item.failed', 'approval.requested', 'approval.decided',
  'turn.completed', 'turn.failed', 'turn.interrupted', 'verification.recorded', 'file.changes.updated',
])

function isExecutionItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const item = value as { id?: unknown; kind?: unknown; status?: unknown; label?: unknown; startedAt?: unknown }
  return typeof item.id === 'string' && typeof item.label === 'string' && typeof item.startedAt === 'string'
    && ['analysis', 'assistant', 'tool-call', 'approval', 'subagent', 'warning', 'error', 'verification', 'provider-turn'].includes(String(item.kind))
    && ['running', 'completed', 'failed', 'canceled'].includes(String(item.status))
}

function isExecutionProjection(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const projection = value as Record<string, unknown>
  if (typeof projection.updatedAt !== 'string') return false
  for (const key of ['steps', 'timeline', 'subagents', 'changes', 'artifacts', 'visuals', 'knowledgeSources', 'replaceCollections']) {
    if (projection[key] !== undefined && !Array.isArray(projection[key])) return false
  }
  return projection.status === undefined || ['idle', 'running', 'completed', 'failed', 'canceled'].includes(String(projection.status))
}

function isTaskMonitor(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const monitor = value as Partial<LocalTaskRun['monitor']>
  return ['idle', 'running', 'completed', 'failed', 'canceled'].includes(monitor.status ?? '')
    && typeof monitor.activity === 'string' && typeof monitor.updatedAt === 'string'
    && Array.isArray(monitor.steps) && Array.isArray(monitor.artifacts)
}
