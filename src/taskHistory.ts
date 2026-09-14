import { invoke, isTauri } from '@tauri-apps/api/core'
import type { LocalTaskRun } from './types'
import { inspectHarnessSession, searchHarnessSessionsPage, type HarnessSessionSearchHit, type HarnessSessionSearchPage } from './harness'

const LIMIT = 200
const writes = new Map<string, Promise<void>>()
const MAX_HARNESS_SEARCH_ITEMS = 2_000

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
  invalidCount?: number
  offset: number
  limit: number
}

export function unreadableHistoryWarning(count: number): string {
  return `${count} 条旧格式或损坏的本地会话未显示，原始数据已保留`
}

/** Consume the official cursor until the candidate set is exhausted. */
export async function collectHarnessSessionSearch(
  search: (cursor?: string) => Promise<HarnessSessionSearchPage>,
  maxItems = MAX_HARNESS_SEARCH_ITEMS,
  signal?: AbortSignal,
): Promise<HarnessSessionSearchHit[]> {
  let restarted = false
  for (;;) {
    signal?.throwIfAborted()
    const items: HarnessSessionSearchHit[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    try {
      while (items.length < maxItems) {
        signal?.throwIfAborted()
        const page = await search(cursor)
        signal?.throwIfAborted()
        items.push(...page.items.slice(0, maxItems - items.length))
        if (!page.nextCursor || cursors.has(page.nextCursor)) break
        cursors.add(page.nextCursor)
        cursor = page.nextCursor
      }
      return items
    } catch (error) {
      // Harness cursors are generation-bound. If the index changed between
      // pages, restart once so the caller receives one coherent result set.
      if (restarted || !isStaleSessionSearchCursor(error)) throw error
      restarted = true
    }
  }
}

function isStaleSessionSearchCursor(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /stale cursor|cursor is stale|游标.*过期|游标.*失效|语料库.*变化/iu.test(message)
}

async function collectIndexedTasks(employeeId: string, query: string, excludeIds: string[], firstPage: LocalTaskPage, signal?: AbortSignal): Promise<LocalTaskRun[]> {
  const items = [...firstPage.items]
  const seen = new Set([...excludeIds, ...items.map((task) => task.id)])
  while (items.length < firstPage.total) {
    signal?.throwIfAborted()
    const next = await invoke<LocalTaskPage>('load_local_tasks', {
      employeeId, query: { query, offset: 0, limit: LIMIT, excludeIds: [...seen] },
    })
    signal?.throwIfAborted()
    const fresh = next.items.filter((task) => !seen.has(task.id))
    if (!fresh.length) break
    items.push(...fresh)
    for (const task of fresh) seen.add(task.id)
  }
  return validTasks(items)
}

export async function loadTaskHistoryPage(employeeId: string, query = '', offset = 0, excludeIds: string[] = [], signal?: AbortSignal): Promise<LocalTaskPage> {
  signal?.throwIfAborted()
  await Promise.all([...writes.entries()].filter(([key]) => JSON.parse(key)[0] === employeeId).map(([, write]) => write.catch(() => undefined)))
  signal?.throwIfAborted()
  if (isTauri()) {
    if (!query.trim()) {
      const page = await invoke<LocalTaskPage>('load_local_tasks', { employeeId, query: { query, offset, limit: LIMIT, excludeIds } })
      return { ...page, items: await recoverInterruptedTasksWithHarness(employeeId, validTasks(page.items)) }
    }
    const [indexedPage, candidatesPage] = await Promise.all([
      invoke<LocalTaskPage>('load_local_tasks', { employeeId, query: { query, offset: 0, limit: LIMIT, excludeIds } }),
      invoke<LocalTaskPage>('load_local_tasks', { employeeId, query: { query: '', offset: 0, limit: LIMIT, excludeIds } }),
    ])
    signal?.throwIfAborted()
    if (indexedPage.total === candidatesPage.total) {
      const page = offset === 0 ? indexedPage : await invoke<LocalTaskPage>('load_local_tasks', { employeeId, query: { query, offset, limit: LIMIT, excludeIds } })
      signal?.throwIfAborted()
      return { ...page, items: await recoverInterruptedTasksWithHarness(employeeId, validTasks(page.items)) }
    }
    const indexed = await collectIndexedTasks(employeeId, query, excludeIds, indexedPage, signal)
    const candidates = await collectIndexedTasks(employeeId, '', excludeIds, candidatesPage, signal)
    const indexedIds = new Set(indexed.map((task) => task.id))
    const ids = [...new Set(candidates.flatMap((task) => task.sessionId && !indexedIds.has(task.id) ? [task.sessionId] : []))]
    let hits: HarnessSessionSearchHit[] = []
    try {
      for (let index = 0; index < ids.length; index += MAX_HARNESS_SEARCH_ITEMS) {
        signal?.throwIfAborted()
        const batch = ids.slice(index, index + MAX_HARNESS_SEARCH_ITEMS)
        hits.push(...await collectHarnessSessionSearch((cursor) => searchHarnessSessionsPage(employeeId, batch, query, LIMIT, cursor), MAX_HARNESS_SEARCH_ITEMS, signal))
      }
    } catch (error) {
      if (signal?.aborted) throw error
      if (!indexed.length) throw error
      // An unavailable Host must not hide results already in the local index.
      hits = []
    }
    const hitIds = new Set(hits.map((hit) => hit.sessionId))
    const matches = [...new Map([
      ...indexed,
      ...candidates.filter((task) => task.sessionId && hitIds.has(task.sessionId)),
    ].map((task) => [task.id, task])).values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
    const page = { items: matches.slice(offset, offset + LIMIT), total: matches.length, offset, limit: LIMIT }
    return { ...page, invalidCount: candidatesPage.invalidCount, items: await recoverInterruptedTasksWithHarness(employeeId, page.items) }
  }
  const needle = query.trim().toLocaleLowerCase()
  const excluded = new Set(excludeIds)
  const tasks = loadLocalTasks(employeeId).filter((task) => !excluded.has(task.id) && (!needle || task.name.toLocaleLowerCase().includes(needle)
    || task.sessionId?.toLocaleLowerCase().includes(needle)
    || task.invocationTokens?.some((token) => token.toLocaleLowerCase().includes(needle))
    || task.messagePreview?.toLocaleLowerCase().includes(needle)))
  return { items: recoverInterruptedTasks(tasks.slice(offset, offset + LIMIT)), total: tasks.length, offset, limit: LIMIT }
}

export async function loadTaskById(employeeId: string, id: string): Promise<LocalTaskRun | undefined> {
  await writes.get(JSON.stringify([employeeId, id]))?.catch(() => undefined)
  const task = isTauri() ? await invoke<unknown>('load_local_task', { employeeId, id }) : loadLocalTasks(employeeId).find((item) => item.id === id)
  if (task == null) return undefined
  if (!isLocalTask(task)) throw invalidTaskError(task)
  const indexed = canonicalizeTaskProjection(task)
  const recovered = (await recoverInterruptedTasksWithHarness(employeeId, [indexed], new Date().toISOString(), true))[0]
  if (indexed.sessionId && indexed.messages.length === 0 && recovered.messages.length === 0) {
    throw new Error('Harness 会话内容暂时无法读取，无法打开完整任务；请稍后重试')
  }
  return recovered
}

export async function loadTaskHistory(employeeId: string): Promise<{ tasks: LocalTaskRun[]; invalidCount: number }> {
  await Promise.all([...writes.entries()].filter(([key]) => JSON.parse(key)[0] === employeeId).map(([, write]) => write.catch(() => undefined)))
  if (!isTauri()) return { tasks: recoverInterruptedTasks(loadLocalTasks(employeeId).slice(0, LIMIT)), invalidCount: 0 }
  if (!await invoke<boolean>('local_task_history_migrated', { employeeId })) {
    let raw: string | null
    try { raw = window.localStorage.getItem(storageKey(employeeId)) }
    catch { return { tasks: [], invalidCount: 0 } } // Retry migration if WebView storage becomes readable later.
    const migrated = raw === null ? [] : recoverInterruptedTasks(loadLocalTasks(employeeId))
    const imported = await invoke<boolean>('import_local_task_history', { employeeId, tasks: migrated })
    if (imported && raw !== null) {
      try { window.localStorage.removeItem(storageKey(employeeId)) }
      catch { /* The native migration marker prevents another import. */ }
    }
  }
  const page = await invoke<LocalTaskPage>('load_local_tasks', {
    employeeId,
    query: { query: '', offset: 0, limit: LIMIT },
  })
  if (page.items.length > 0) {
    const tasks = validTasks(page.items)
    const recovered = await recoverInterruptedTasksWithHarness(employeeId, tasks)
    await Promise.all(recovered.filter((task, index) => task !== tasks[index])
      .map((task) => persistTaskHistory(employeeId, task)))
    return { tasks: recovered, invalidCount: page.invalidCount ?? 0 }
  }
  return { tasks: [], invalidCount: page.invalidCount ?? 0 }
}

export function recoverInterruptedTasks(tasks: LocalTaskRun[], now = new Date().toISOString()): LocalTaskRun[] {
  return tasks.map((task) => {
    if (task.status !== 'RUNNING') return task
    const projection = {
      ...task.projection,
      status: 'failed' as const,
      activity: '上次运行已中断，等待核对',
      updatedAt: now,
      completedAt: task.updatedAt,
      interruption: {
        checkpointAt: task.updatedAt,
        cause: 'exit' as const,
        pendingOperations: task.projection.steps.filter((step) => step.status === 'running').map((step) => {
          const timeline = task.projection.timeline?.find((entry) => entry.id === step.id)
          return { id: step.id, label: step.label, ...(step.toolName || timeline?.toolName ? { toolName: step.toolName ?? timeline?.toolName } : {}) }
        }),
      },
      steps: task.projection.steps.map((step) => step.status === 'running'
        ? { ...step, status: 'canceled' as const, label: `${step.label}（结果待核对）`, completedAt: task.updatedAt }
        : step),
      timeline: task.projection.timeline?.map((entry) => entry.status === 'running'
        ? { ...entry, status: 'canceled' as const, label: `${entry.label}（结果待核对）`, completedAt: task.updatedAt }
        : entry),
      subagents: task.projection.subagents?.map((agent) => agent.status === 'running'
        ? { ...agent, status: 'canceled' as const, completedAt: task.updatedAt }
        : agent),
      failure: { code: 'XY-INTERRUPTED', category: 'local-agent', detail: '应用关闭或本地执行进程中断。Harness Session 已保留，继续前请核对实际结果。' },
    }
    const interrupted = {
      role: 'assistant' as const,
      text: [task.messages.at(-1)?.role === 'assistant' && task.messages.at(-1)?.pending ? task.messages.at(-1)!.text.trim() : '',
        '上次任务因应用关闭或本地 Agent 中断，未能完成。已保留最近保存的进度与成果，请检查实际结果后继续，不要重复已经完成的操作。'].filter(Boolean).join('\n\n'),
      projection,
    }
    const messages = task.messages.at(-1)?.role === 'assistant' && task.messages.at(-1)?.pending
      ? [...task.messages.slice(0, -1), interrupted]
      : [...task.messages, interrupted]
    return { ...task, status: 'FAILED' as const, updatedAt: now, projection, messages }
  })
}

/** Prefer the Harness projection index when a task has a durable session. */
export async function recoverInterruptedTasksWithHarness(employeeId: string, tasks: LocalTaskRun[], now = new Date().toISOString(), hydrateCompleted = false): Promise<LocalTaskRun[]> {
  if (!isTauri()) return recoverInterruptedTasks(tasks, now)
  const inspected = await Promise.all(tasks.map(async (task) => {
    if (!task.sessionId || (!hydrateCompleted && task.status !== 'RUNNING')) return undefined
    try { return await inspectHarnessSession(employeeId, task.sessionId) } catch { return undefined }
  }))
  return tasks.map((task, index) => {
    const result = inspected[index]
    if (!result) return task.status === 'RUNNING' ? recoverInterruptedTasks([task], now)[0] : task
    if (task.status === 'RUNNING' && (!result.projection || !['completed', 'failed'].includes(result.status))) return recoverInterruptedTasks([task], now)[0]
    const status = result.status === 'completed' ? 'COMPLETED' : result.status === 'failed' ? 'FAILED' : task.status
    const messages = result.messages?.map((message) => ({ id: message.id, role: message.role, text: message.text, pending: false }))
    return {
      ...task,
      status: status as LocalTaskRun['status'],
      updatedAt: result.updatedAt || task.updatedAt,
      ...(result.projection ? { projection: result.projection } : {}),
      ...(messages?.length ? { messages, messagePreview: messages.at(-1)?.text.slice(-500) } : {}),
    }
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
  if (!values.every(isLocalTask)) throw invalidTaskError(values.find((task) => !isLocalTask(task)))
  return values.map((task) => canonicalizeTaskProjection(task)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function invalidTaskError(value: unknown): Error {
  if (value && typeof value === 'object' && 'source' in value && value.source === 'DESKTOP'
    && !('projection' in value)) {
    return new Error('本地会话缺少运行投影（旧开发格式或数据损坏），原始数据已保留')
  }
  return new Error('本地会话数据无效，原始数据已保留')
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
  const copy = structuredClone(task)
  // A session ID is reserved before Harness starts. Keep the prompt if a
  // failed or interrupted turn has no execution event to recover from yet.
  if (!copy.sessionId || (copy.status !== 'COMPLETED' && !hasHarnessSessionEvidence(copy))) return copy
  const lastMessage = copy.messages.at(-1)?.text?.trim()
  return {
    ...copy,
    messages: [],
    ...(lastMessage ? { messagePreview: lastMessage.slice(-500) } : {}),
    projection: {
      ...copy.projection,
      // Expandable execution details are rebuilt from the Harness event log.
      steps: [], timeline: [], subagents: [], changes: [], visuals: [], knowledgeSources: [],
      artifacts: copy.projection.artifacts.slice(-20),
    },
  }
}

function hasHarnessSessionEvidence(task: LocalTaskRun): boolean {
  const projection = task.projection
  return projection.executionStarted === true || projection.steps.length > 0
    || Boolean(projection.timeline?.length || projection.tokenUsage || projection.compactions
      || projection.contextPressure || projection.outputRetention?.prunedResults
      || projection.outputRetention?.omittedTokens)
}

function canonicalizeTaskProjection(task: LocalTaskRun): LocalTaskRun {
  return task
}

function storageKey(employeeId: string): string {
  return `xiaoyin.task-history.${employeeId}`
}

function isLocalTask(value: unknown): value is LocalTaskRun {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<LocalTaskRun>
  const allowedFields = new Set(['id', 'source', 'name', 'status', 'createdAt', 'updatedAt', 'archivedAt', 'sessionId', 'scheduleId', 'scheduleRunId', 'invocationTokens', 'model', 'reasoningEffort', 'executionMode', 'localDirectories', 'capabilitySnapshot', 'projection', 'messages', 'messagePreview', 'processedImEventIds'])
  return Object.keys(task).every((key) => allowedFields.has(key)) && task.source === 'DESKTOP' && typeof task.id === 'string' && typeof task.name === 'string'
    && ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELED'].includes(task.status ?? '')
    && typeof task.createdAt === 'string' && typeof task.updatedAt === 'string' && Array.isArray(task.messages)
    && (task.scheduleId === undefined || typeof task.scheduleId === 'string')
    && (task.scheduleRunId === undefined || typeof task.scheduleRunId === 'string')
    && (task.reasoningEffort === undefined || ['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(task.reasoningEffort))
    && task.messages.every((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')
    && isTaskProjection(task.projection)
}

function isTaskProjection(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const projection = value as Partial<LocalTaskRun['projection']>
  return ['idle', 'running', 'completed', 'failed', 'canceled'].includes(projection.status ?? '')
    && typeof projection.activity === 'string' && typeof projection.updatedAt === 'string'
    && Array.isArray(projection.steps) && Array.isArray(projection.artifacts)
}
