import { afterEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { searchHarnessSessionsPage } from './harness'
import { loadTaskHistory, loadTaskHistoryPage } from './taskHistory'
import type { LocalTaskRun } from './types'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))
vi.mock('./harness', () => ({ inspectHarnessSession: vi.fn(), searchHarnessSessionsPage: vi.fn() }))

afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals() })

it('does not read stale WebView history after native migration, even when the native history is empty', async () => {
  const getItem = vi.fn(() => '{broken')
  vi.stubGlobal('window', { localStorage: { getItem } })
  vi.mocked(invoke).mockImplementation(async (command) => command === 'local_task_history_migrated'
    ? true : { items: [], total: 0, invalidCount: 0, offset: 0, limit: 200 })
  await expect(loadTaskHistory('employee')).resolves.toEqual({ tasks: [], invalidCount: 0 })
  expect(getItem).not.toHaveBeenCalled()
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['local_task_history_migrated', 'load_local_tasks'])
})

it('imports once, then never resurrects a deleted task when clearing the old key fails', async () => {
  const task: LocalTaskRun = {
    id: 'old-task', source: 'DESKTOP', name: '旧任务', status: 'COMPLETED',
    createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z', entries: [],
    projection: { status: 'completed', activity: '完成', updatedAt: '2026-09-13T00:00:00Z', steps: [], artifacts: [] },
  }
  let migrated = false, tasks: LocalTaskRun[] = []
  vi.stubGlobal('window', { localStorage: {
    getItem: () => JSON.stringify([task]), removeItem: () => { throw new Error('WebView storage unavailable') },
  } })
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'local_task_history_migrated') return migrated
    if (command === 'import_local_task_history') { tasks = (args as { tasks: LocalTaskRun[] }).tasks; migrated = true; return true }
    if (command === 'load_local_tasks') return { items: tasks, total: tasks.length, invalidCount: 0, offset: 0, limit: 200 }
    throw new Error(`Unexpected command: ${command}`)
  })
  expect((await loadTaskHistory('employee')).tasks).toHaveLength(1)
  tasks = []
  await expect(loadTaskHistory('employee')).resolves.toEqual({ tasks: [], invalidCount: 0 })
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'import_local_task_history')).toHaveLength(1)
})

it('paginates full-message Harness hits without repeating the first page', async () => {
  const tasks = Array.from({ length: 230 }, (_, index): LocalTaskRun => ({
    id: `task-${index}`, source: 'DESKTOP', name: `任务 ${index}`, status: 'COMPLETED',
    createdAt: new Date(Date.UTC(2026, 8, 12, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 12, 0, index)).toISOString(),
    sessionId: `session-${index}`, entries: [],
    projection: { status: 'completed', activity: '完成', updatedAt: '2026-09-12T00:00:00Z', steps: [], artifacts: [] },
  })).reverse()
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { query, offset, limit, excludeIds } = (args as { query: { query: string; offset: number; limit: number; excludeIds: string[] } }).query
    const matches = tasks.filter((task) => !excludeIds.includes(task.id) && (!query || task.name.includes(query)))
    return { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit }
  })
  vi.mocked(searchHarnessSessionsPage).mockImplementation(async (_employeeId, ids, _query, _limit, cursor) => {
    const start = cursor ? Number(cursor) : 0
    return {
      items: ids.slice(start, start + 200).map((sessionId) => ({ sessionId, excerpt: '深度分析', updatedAt: '2026-09-12T00:00:00Z' })),
      ...(start + 200 < ids.length ? { nextCursor: String(start + 200) } : {}),
    }
  })

  const first = await loadTaskHistoryPage('employee-1', '深度')
  expect(first).toMatchObject({ total: 230, offset: 0, limit: 200 })
  expect(first.items).toHaveLength(200)

  const second = await loadTaskHistoryPage('employee-1', '深度', 0, first.items.map((item) => item.id))
  expect(second).toMatchObject({ total: 30, offset: 0, limit: 200 })
  expect(second.items).toHaveLength(30)
  expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(230)

  const offsetPage = await loadTaskHistoryPage('employee-1', '深度', 210)
  expect(offsetPage).toMatchObject({ total: 230, offset: 210, limit: 200 })
  expect(offsetPage.items).toHaveLength(20)
  expect(offsetPage.items.map((item) => item.id)).toEqual(second.items.slice(10).map((item) => item.id))
})

it('merges local metadata and Harness body matches in task recency order', async () => {
  const tasks: LocalTaskRun[] = [
    { id: 'body', name: '其他任务', sessionId: 'session-body', updatedAt: '2026-09-13T03:00:00Z' },
    { id: 'title', name: '库存报告', sessionId: 'session-title', updatedAt: '2026-09-13T02:00:00Z' },
    { id: 'unrelated', name: '排期', sessionId: 'session-unrelated', updatedAt: '2026-09-13T01:00:00Z' },
  ].map((value) => ({
    ...value, source: 'DESKTOP', status: 'COMPLETED', createdAt: value.updatedAt, entries: [],
    projection: { status: 'completed', activity: '完成', updatedAt: value.updatedAt, steps: [], artifacts: [] },
  }))
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { query, offset, limit, excludeIds } = (args as { query: { query: string; offset: number; limit: number; excludeIds: string[] } }).query
    const matches = tasks.filter((task) => !excludeIds.includes(task.id) && (!query || task.name.includes(query)))
    return { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit }
  })
  vi.mocked(searchHarnessSessionsPage).mockResolvedValue({
    items: [{ sessionId: 'session-body', excerpt: '库存不足', updatedAt: '2026-09-13T03:00:00Z' }],
  })

  const page = await loadTaskHistoryPage('employee-1', '库存')
  expect(page.items.map((task) => task.id)).toEqual(['body', 'title'])
  expect(page.total).toBe(2)
  expect(vi.mocked(searchHarnessSessionsPage).mock.calls[0]?.[1]).toEqual(['session-body', 'session-unrelated'])

  vi.mocked(searchHarnessSessionsPage).mockRejectedValue(new Error('Host unavailable'))
  await expect(loadTaskHistoryPage('employee-1', '库存')).resolves.toMatchObject({ items: [{ id: 'title' }], total: 1 })
  await expect(loadTaskHistoryPage('employee-1', '正文独有')).rejects.toThrow('Host unavailable')
})

it('preserves local index pagination beyond the bounded Harness candidate set', async () => {
  const task: LocalTaskRun = {
    id: 'older-local-match', source: 'DESKTOP', name: '库存记录', status: 'COMPLETED',
    createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
    entries: [], projection: { status: 'completed', activity: '完成', updatedAt: '2026-09-13T00:00:00Z', steps: [], artifacts: [] },
  }
  vi.mocked(invoke).mockResolvedValueOnce({ items: [task], total: 2_001, offset: 0, limit: 200 })
    .mockResolvedValueOnce({ items: [task], total: 2_001, offset: 0, limit: 200 })
    .mockResolvedValueOnce({ items: [task], total: 2_001, offset: 2_000, limit: 200 })

  const page = await loadTaskHistoryPage('employee-1', '库存', 2_000)
  expect(page).toMatchObject({ items: [{ id: task.id }], total: 2_001, offset: 2_000, limit: 200 })
  expect(searchHarnessSessionsPage).not.toHaveBeenCalled()
})

it('finds a body match beyond the first 2,000 Session IDs using bounded requests', async () => {
  const tasks = Array.from({ length: 2_001 }, (_, index): LocalTaskRun => ({
    id: `task-${index}`, source: 'DESKTOP', name: `任务 ${index}`, status: 'COMPLETED',
    createdAt: new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(),
    sessionId: `session-${index}`, entries: [],
    projection: { status: 'completed', activity: '完成', updatedAt: '2026-09-13T00:00:00Z', steps: [], artifacts: [] },
  })).reverse()
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { query, offset, limit, excludeIds } = (args as { query: { query: string; offset: number; limit: number; excludeIds: string[] } }).query
    const matches = tasks.filter((task) => !excludeIds.includes(task.id) && (!query || task.name.includes(query)))
    return { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit }
  })
  vi.mocked(searchHarnessSessionsPage).mockImplementation(async (_employeeId, ids) => ({
    items: ids.includes('session-0')
      ? [{ sessionId: 'session-0', excerpt: '深度分析', updatedAt: '2026-09-13T00:00:00Z' }]
      : [],
  }))

  const page = await loadTaskHistoryPage('employee-1', '深度')
  expect(page).toMatchObject({ items: [{ id: 'task-0' }], total: 1, offset: 0, limit: 200 })
  expect(vi.mocked(searchHarnessSessionsPage).mock.calls.map(([, ids]) => ids.length)).toEqual([2_000, 1])
})

it('does not skip a candidate moved ahead of the current page while scanning', async () => {
  const tasks = Array.from({ length: 430 }, (_, index): LocalTaskRun => ({
    id: `task-${index}`, source: 'DESKTOP', name: `任务 ${index}`, status: 'COMPLETED',
    createdAt: new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(),
    sessionId: `session-${index}`, entries: [],
    projection: { status: 'completed', activity: '完成', updatedAt: '2026-09-13T00:00:00Z', steps: [], artifacts: [] },
  }))
  let candidatePages = 0
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { query, offset, limit, excludeIds } = (args as { query: { query: string; offset: number; limit: number; excludeIds: string[] } }).query
    if (!query && ++candidatePages === 2) {
      tasks[50]!.updatedAt = '2026-09-14T00:00:00Z'
    }
    const matches = tasks.filter((task) => !excludeIds.includes(task.id) && (!query || task.name.includes(query)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit }
  })
  vi.mocked(searchHarnessSessionsPage).mockImplementation(async (_employeeId, ids) => ({
    items: ids.map((sessionId) => ({ sessionId, excerpt: '深度分析', updatedAt: '2026-09-13T00:00:00Z' })),
  }))

  const page = await loadTaskHistoryPage('employee-1', '深度')
  expect(page.total).toBe(430)
  expect(page.items[0]?.id).toBe('task-50')
  expect(candidatePages).toBe(3)
  expect(vi.mocked(searchHarnessSessionsPage).mock.calls[0]?.[1]).toHaveLength(430)
})

it('sorts a later Harness batch ahead of older local title matches', async () => {
  const tasks = Array.from({ length: 2_002 }, (_, index): LocalTaskRun => ({
    id: `task-${index}`, source: 'DESKTOP', name: index === 0 ? '库存标题' : `任务 ${index}`, status: 'COMPLETED',
    createdAt: new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(),
    sessionId: `session-${index}`, entries: [],
    projection: { status: 'completed', activity: '完成', updatedAt: '2026-09-13T00:00:00Z', steps: [], artifacts: [] },
  }))
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { query, offset, limit, excludeIds } = (args as { query: { query: string; offset: number; limit: number; excludeIds: string[] } }).query
    const matches = tasks.filter((task) => !excludeIds.includes(task.id) && (!query || task.name.includes(query)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit }
  })
  vi.mocked(searchHarnessSessionsPage).mockImplementation(async (_employeeId, ids) => ({
    items: ids.includes('session-1')
      ? [{ sessionId: 'session-1', excerpt: '库存正文', updatedAt: '2026-09-13T00:00:00Z' }]
      : [],
  }))

  const page = await loadTaskHistoryPage('employee-1', '库存')
  expect(page.items.map((task) => task.id)).toEqual(['task-1', 'task-0'])
  expect(vi.mocked(searchHarnessSessionsPage).mock.calls.map(([, ids]) => ids.length)).toEqual([2_000, 1])
})

it('stops launching Harness batches after a stale search is canceled', async () => {
  const tasks = Array.from({ length: 4_001 }, (_, index): LocalTaskRun => ({
    id: `task-${index}`, source: 'DESKTOP', name: `任务 ${index}`, status: 'COMPLETED',
    createdAt: new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 13, 0, index)).toISOString(),
    sessionId: `session-${index}`, entries: [],
    projection: { status: 'completed', activity: '完成', updatedAt: '2026-09-13T00:00:00Z', steps: [], artifacts: [] },
  }))
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const { query, offset, limit, excludeIds } = (args as { query: { query: string; offset: number; limit: number; excludeIds: string[] } }).query
    const matches = tasks.filter((task) => !excludeIds.includes(task.id) && (!query || task.name.includes(query)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    return { items: matches.slice(offset, offset + limit), total: matches.length, offset, limit }
  })
  const controller = new AbortController()
  vi.mocked(searchHarnessSessionsPage).mockImplementation(async () => {
    controller.abort()
    return { items: [] }
  })

  await expect(loadTaskHistoryPage('employee-1', '深度', 0, [], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(searchHarnessSessionsPage).toHaveBeenCalledTimes(1)
  expect(vi.mocked(searchHarnessSessionsPage).mock.calls[0]?.[1]).toHaveLength(2_000)
})
