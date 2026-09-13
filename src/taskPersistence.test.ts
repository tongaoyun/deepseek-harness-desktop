import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { persistTaskHistory, removeTaskHistory, loadTaskById, loadTaskHistory, loadTaskHistoryPage, compactTaskForStorage } from './taskHistory'
import { createXiaoyinTaskProjection } from './harness'
import type { LocalTaskRun } from './types'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))

it('serializes snapshots, final state and deletion, and captures immutable save inputs', async () => {
  let finish: () => void = () => {}
  vi.mocked(invoke).mockReset().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve })).mockResolvedValue(undefined)
  const task = fixture('ordered')
  const first = persistTaskHistory('employee', task)
  task.messages[0].text = 'mutated after saving'
  const final = persistTaskHistory('employee', { ...task, status: 'COMPLETED' })
  const deletion = removeTaskHistory('employee', task.id)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
  expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ task: { messages: [{ text: 'partial' }] } })
  finish()
  await Promise.all([first, final, deletion])
  expect(vi.mocked(invoke).mock.calls.map(([method]) => method)).toEqual(['save_local_task', 'save_local_task', 'delete_local_task'])
  expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({ task: { status: 'COMPLETED' } })
})

it('does not permanently block saving after a failed write', async () => {
  vi.mocked(invoke).mockReset().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  const task = fixture('recover-save')
  await expect(persistTaskHistory('employee', task)).rejects.toThrow('disk full')
  await expect(persistTaskHistory('employee', { ...task, status: 'COMPLETED' })).resolves.toBeUndefined()
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('stores only a local index once a task has an official Harness session', () => {
  const task = { ...fixture('indexed'), sessionId: 'session-indexed', projection: { ...createXiaoyinTaskProjection(), executionStarted: true }, messages: [
    { role: 'user' as const, text: '原始请求' },
    { role: 'assistant' as const, text: '完整执行结果' },
  ] }
  const stored = compactTaskForStorage(task)
  expect(stored.messages).toEqual([])
  expect(stored.messagePreview).toBe('完整执行结果')
  expect(stored.projection.steps).toEqual([])
  expect(stored.projection.artifacts).toEqual(task.projection.artifacts)
})

it('retains the initial prompt when a reserved Session has no execution event yet', () => {
  const task = { ...fixture('not-started'), sessionId: 'session-not-started', messages: [
    { role: 'user' as const, text: '检查订单并生成报告' },
    { role: 'assistant' as const, text: '', pending: true },
  ] }
  expect(compactTaskForStorage(task).messages).toEqual(task.messages)
  expect(compactTaskForStorage({ ...task, status: 'FAILED' }).messages[0]?.text).toBe('检查订单并生成报告')
  expect(compactTaskForStorage({ ...task, status: 'COMPLETED' }).messages).toEqual([])
})

it('compacts a pure chat turn after Harness emits visible response events', () => {
  const task = { ...fixture('chat-stream'), sessionId: 'session-chat-stream', messages: [
    { role: 'user' as const, text: '总结这段内容' },
    { role: 'assistant' as const, text: '正在总结', pending: true },
  ], projection: {
    ...createXiaoyinTaskProjection(),
    timeline: [{ id: 'assistant:0:1', kind: 'assistant' as const, label: '说明', text: '正在总结', status: 'running' as const, occurredAt: '2026-09-13T01:00:00Z' }],
  } }
  const stored = compactTaskForStorage(task)
  expect(stored.messages).toEqual([])
  expect(stored.messagePreview).toBe('正在总结')
  expect(stored.projection.timeline).toEqual([])
})

function fixture(id: string): LocalTaskRun {
  return { id, source: 'DESKTOP', name: '任务', status: 'RUNNING', createdAt: '', updatedAt: '', projection: createXiaoyinTaskProjection(), messages: [{ role: 'assistant', text: 'partial', pending: true }] }
}

it('opens an archived task directly from storage and keeps its interrupted output', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ ...fixture('older-than-first-page'), archivedAt: '2026-09-01' })
  const task = await loadTaskById('employee', 'older-than-first-page')
  expect(invoke).toHaveBeenCalledWith('load_local_task', { employeeId: 'employee', id: 'older-than-first-page' })
  expect(task).toMatchObject({ status: 'FAILED', archivedAt: '2026-09-01' })
  expect(task?.messages.at(-1)?.text).toContain('partial')
  expect(task?.messages.at(-1)?.text).toContain('不要重复')
})

it('hydrates a stripped task from the official Harness session inspection', async () => {
  const indexed = { ...fixture('durable'), status: 'COMPLETED' as const, sessionId: 'session-durable', messages: [], messagePreview: '摘要' }
  vi.mocked(invoke).mockReset()
    .mockResolvedValueOnce(indexed)
    .mockResolvedValueOnce({ sessionId: 'session-durable', status: 'completed', updatedAt: '2026-09-12T00:00:00.000Z', pendingTools: 0,
      projection: { ...indexed.projection, status: 'completed', activity: '任务已完成', updatedAt: '2026-09-12T00:00:00.000Z' },
      messages: [{ id: 'user-1', role: 'user', text: '原始请求' }, { id: 'assistant-1', role: 'assistant', text: '完整结果' }] })
  const task = await loadTaskById('employee', 'durable')
  expect(task?.messages.map((message) => message.text)).toEqual(['原始请求', '完整结果'])
  expect(task?.projection.activity).toBe('任务已完成')
  expect(invoke).toHaveBeenLastCalledWith('inspect_harness_session', { employeeId: 'employee', sessionId: 'session-durable' })
})

it('rejects a stripped task when its official Harness transcript cannot be read', async () => {
  const indexed = { ...fixture('unavailable'), status: 'COMPLETED' as const, sessionId: 'session-unavailable', messages: [], messagePreview: '仅用于列表检索的摘要' }
  vi.mocked(invoke).mockReset()
    .mockResolvedValueOnce(indexed)
    .mockRejectedValueOnce(new Error('Harness unavailable'))
  await expect(loadTaskById('employee', indexed.id)).rejects.toThrow('无法打开完整任务')
  expect(invoke).toHaveBeenLastCalledWith('inspect_harness_session', { employeeId: 'employee', sessionId: indexed.sessionId })
})

it('distinguishes missing tasks from unreadable stored tasks', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'broken' })
  expect(await loadTaskById('employee', 'deleted')).toBeUndefined()
  await expect(loadTaskById('employee', 'broken')).rejects.toThrow('原始数据已保留')
})

it('identifies legacy local records without overwriting their original payload', async () => {
  const oldRecord = { id: 'old', source: 'DESKTOP', name: '旧任务', messages: [] }
  vi.mocked(invoke).mockReset().mockResolvedValueOnce({ items: [oldRecord], total: 1, offset: 0, limit: 200 })
  await expect(loadTaskHistoryPage('employee')).rejects.toThrow('缺少运行投影（旧开发格式或数据损坏）')
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('load_local_tasks', expect.any(Object))
})

it('loads valid tasks while reporting unreadable native rows without writing over them', async () => {
  const valid = { ...fixture('valid'), status: 'COMPLETED' as const }
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce({ items: [valid], total: 1, invalidCount: 2, offset: 0, limit: 200 })
  await expect(loadTaskHistory('employee')).resolves.toEqual({ tasks: [valid], invalidCount: 2 })
  expect(invoke).toHaveBeenCalledTimes(2)
  expect(invoke).toHaveBeenCalledWith('load_local_tasks', { employeeId: 'employee', query: { query: '', offset: 0, limit: 200 } })
})

it('keeps recovered Harness content in memory but persists only its local index', async () => {
  const running = {
    ...fixture('interrupted'), sessionId: 'session-interrupted', updatedAt: '2026-09-13T01:00:00Z',
    messages: [{ role: 'user' as const, text: '原始要求' }, { role: 'assistant' as const, text: '已完成前半部分', pending: true }],
    projection: { ...createXiaoyinTaskProjection(), status: 'running' as const, executionStarted: true, steps: [{ id: 'tool-1', kind: 'tool' as const, label: '检查文件', status: 'running' as const, startedAt: '2026-09-13T01:00:00Z' }] },
  }
  vi.mocked(invoke).mockReset()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce({ items: [running], total: 1, invalidCount: 0, offset: 0, limit: 200 })
    .mockRejectedValueOnce(new Error('Harness unavailable'))
    .mockResolvedValueOnce(undefined)

  const { tasks } = await loadTaskHistory('employee')
  expect(tasks[0]?.messages.at(-1)?.text).toContain('已完成前半部分')
  expect(tasks[0]?.projection.steps[0]?.label).toContain('结果待核对')
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['local_task_history_migrated', 'load_local_tasks', 'inspect_harness_session', 'save_local_task'])
  const saved = vi.mocked(invoke).mock.calls[3]![1] as { task: LocalTaskRun }
  expect(saved.task.status).toBe('FAILED')
  expect(saved.task.messages).toEqual([])
  expect(saved.task.messagePreview).toContain('已完成前半部分')
  expect(saved.task.projection.steps).toEqual([])
})

it('can reopen a pre-execution failure without an available Harness Session', async () => {
  const running = { ...fixture('pre-execution'), sessionId: 'session-reserved', updatedAt: '2026-09-13T01:00:00Z', messages: [
    { role: 'user' as const, text: '检查订单并生成报告' },
    { role: 'assistant' as const, text: '', pending: true },
  ] }
  vi.mocked(invoke).mockReset()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce({ items: [running], total: 1, invalidCount: 0, offset: 0, limit: 200 })
    .mockRejectedValueOnce(new Error('Session not found'))
    .mockResolvedValueOnce(undefined)

  const result = await loadTaskHistory('employee')
  const stored = (vi.mocked(invoke).mock.calls[3]![1] as { task: LocalTaskRun }).task
  expect(result.tasks[0]?.status).toBe('FAILED')
  expect(stored.messages[0]?.text).toBe('检查订单并生成报告')
  expect(stored.messages.at(-1)?.text).toContain('不要重复已经完成的操作')

  vi.mocked(invoke).mockReset().mockResolvedValueOnce(stored).mockRejectedValueOnce(new Error('Session not found'))
  const reopened = await loadTaskById('employee', stored.id)
  expect(reopened?.messages[0]?.text).toBe('检查订单并生成报告')
  expect(reopened?.status).toBe('FAILED')
})

it('does not read or clear old WebView history when native storage has only unreadable rows', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce({ items: [], total: 0, invalidCount: 2, offset: 0, limit: 200 })
  const storage = { getItem: vi.fn(() => { throw new Error('broken WebView storage') }), removeItem: vi.fn() }
  vi.stubGlobal('window', { localStorage: storage })
  try {
    await expect(loadTaskHistory('employee')).resolves.toEqual({ tasks: [], invalidCount: 2 })
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllGlobals() }
})

it('queries unseen task IDs instead of advancing an unstable offset', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 200 })
  await loadTaskHistoryPage('employee', 'invoice', 0, ['already-visible'])
  expect(invoke).toHaveBeenCalledWith('load_local_tasks', { employeeId: 'employee', query: { query: 'invoice', offset: 0, limit: 200, excludeIds: ['already-visible'] } })
})
