import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { persistCapabilityNotice, persistTaskHistory, removeTaskHistory, loadTaskById, loadTaskHistory, loadTaskHistoryPage, compactTaskForStorage } from './taskHistory'
import { createXiaoyinTaskProjection } from './harness'
import { assistantEntry, lastEntryText, userEntry } from './conversation/testing'
import type { LocalTaskRun } from './types'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))

it('serializes snapshots, final state and deletion, and captures immutable save inputs', async () => {
  let finish: () => void = () => {}
  vi.mocked(invoke).mockReset().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve })).mockResolvedValue(undefined)
  const task = fixture('ordered')
  const first = persistTaskHistory('employee', task)
  ;(task.entries[0] as { segments: unknown[] }).segments[0] = { kind: 'text', id: 'turn:1:1', text: 'mutated after saving' }
  const final = persistTaskHistory('employee', { ...task, status: 'COMPLETED' })
  const deletion = removeTaskHistory('employee', task.id)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
  expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ task: { entries: [{ role: 'assistant', segments: [{ text: 'partial' }] }] } })
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

it('appends a notice immediately after the running task save, without waiting for a checkpoint', async () => {
  let finish!: () => void
  vi.mocked(invoke).mockReset().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve })).mockResolvedValue(undefined)
  const running = persistTaskHistory('employee', { ...fixture('immediate'), sessionId: 'session-immediate' })
  const notice = { sessionId: 'session-immediate', turnId: 'pending', segment: {
    kind: 'notice' as const, id: 'notice:knowledge:scope', level: 'warning' as const, text: '范围无效',
  } }
  const saved = persistCapabilityNotice('employee', 'immediate', notice)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
  finish()
  await Promise.all([running, saved])
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['save_local_task', 'append_local_task_capability_notice'])
  expect(invoke).toHaveBeenLastCalledWith('append_local_task_capability_notice', { employeeId: 'employee', id: 'immediate', notice })
})

it('restores a pre-turn-start notice on the next official turn after a restart', async () => {
  const task = { ...fixture('crash'), sessionId: 'session-crash', status: 'COMPLETED' as const,
    entries: [], capabilityNotices: [{ sessionId: 'session-crash', turnId: 'pending', afterTurnId: 'turn:1', segment: {
      kind: 'notice' as const, id: 'notice:connector:erp', level: 'warning' as const, text: '连接失败',
    } }],
  }
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(task).mockResolvedValueOnce({
    sessionId: 'session-crash', status: 'completed', updatedAt: '2026-09-12T00:00:00Z', pendingTools: 0,
    projection: task.projection, transcript: [userEntry('u1', '此前请求'), assistantEntry('turn:1', '此前结果'),
      userEntry('u2', '继续'), assistantEntry('turn:2', '恢复结果')],
  })
  const restored = await loadTaskById('employee', 'crash')
  expect(restored?.entries[1]).toMatchObject({ segments: [{ text: '此前结果' }] })
  expect(restored?.entries[3]).toMatchObject({ segments: [{ kind: 'notice', text: '连接失败' }, { text: '恢复结果' }] })
})

it('keeps a pending notice when the failed official session has no assistant turn yet', async () => {
  const notice = { sessionId: 'session-no-reply', turnId: 'pending', afterTurnId: 'turn:1', segment: {
    kind: 'notice' as const, id: 'notice:knowledge:scope', level: 'warning' as const, text: '范围无效',
  } }
  const task = { ...fixture('no-reply'), sessionId: 'session-no-reply', capabilityNotices: [notice], entries: [] }
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(task).mockResolvedValueOnce({
    sessionId: 'session-no-reply', status: 'failed', updatedAt: '2026-09-12T00:00:00Z', pendingTools: 0,
    projection: task.projection, transcript: [userEntry('u1', '此前请求'), assistantEntry('turn:1', '此前结果'), userEntry('u2', '查询知识库')],
  })
  const restored = await loadTaskById('employee', task.id)
  expect(restored?.entries[1]).toMatchObject({ segments: [{ text: '此前结果' }] })
  expect(restored?.entries[3]).toMatchObject({ id: 'pending', status: 'failed', segments: [notice.segment] })
})

it('shows a durable pre-turn notice after interruption even before Harness has a transcript', async () => {
  const notice = { sessionId: 'session-interrupted', turnId: 'pending', segment: {
    kind: 'notice' as const, id: 'notice:knowledge:scope', level: 'warning' as const, text: '范围无效',
  } }
  const task = { ...fixture('interrupted-notice'), sessionId: 'session-interrupted',
    entries: [userEntry('u1', '查询知识库'), assistantEntry('pending', [], {}, 'streaming')],
    capabilityNotices: [notice] }
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(task).mockResolvedValueOnce(undefined)
  const recovered = await loadTaskById('employee', task.id)
  expect(recovered?.status).toBe('FAILED')
  const last = recovered?.entries.at(-1)
  expect(last?.role).toBe('assistant')
  if (last?.role !== 'assistant') return
  expect(last.segments[0]).toEqual(notice.segment)
  expect(last.segments[1]).toMatchObject({ kind: 'text', text: expect.stringContaining('上次任务') })
})

it('restores a notice after interruption when the running snapshot was compacted', async () => {
  const notice = { sessionId: 'session-compacted', turnId: 'pending', segment: {
    kind: 'notice' as const, id: 'notice:knowledge:scope', level: 'warning' as const, text: '范围无效',
  } }
  const task = { ...fixture('compacted-notice'), sessionId: notice.sessionId, entries: [], capabilityNotices: [notice] }
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(task).mockResolvedValueOnce(undefined)
  const restored = await loadTaskById('employee', task.id)
  expect(restored?.entries[0]).toMatchObject({ status: 'failed', segments: [notice.segment, { kind: 'text', text: expect.stringContaining('上次任务') }] })
})

it('stores only a local index once a task has an official Harness session', () => {
  const task = { ...fixture('indexed'), sessionId: 'session-indexed', projection: { ...createXiaoyinTaskProjection(), executionStarted: true }, entries: [
    userEntry('u1', '原始请求'),
    assistantEntry('turn:1', '完整执行结果'),
  ] }
  const stored = compactTaskForStorage(task)
  expect(stored.entries).toEqual([])
  expect(stored.messagePreview).toBe('完整执行结果')
  expect(stored.projection.steps).toEqual([])
  expect(stored.projection.artifacts).toEqual(task.projection.artifacts)
})

it('persists bounded capability notices separately from the official transcript and restores them by turn', async () => {
  const notice = { kind: 'notice' as const, id: 'notice:knowledge:scope', level: 'warning' as const, text: '本轮未使用知识库：范围无效' }
  const indexed = compactTaskForStorage({ ...fixture('notices'), sessionId: 'session-notices',
    status: 'COMPLETED', projection: { ...createXiaoyinTaskProjection(), executionStarted: true },
    entries: [userEntry('user-1', '原始请求'), assistantEntry('turn:1', [notice, { kind: 'text', id: '1:1', text: '部分结果' }])],
  })
  expect(indexed.entries).toEqual([])
  expect(indexed.capabilityNotices).toEqual([{ sessionId: 'session-notices', turnId: 'turn:1', segment: notice }])
  vi.mocked(invoke).mockReset()
    .mockResolvedValueOnce(indexed)
    .mockResolvedValueOnce({ sessionId: 'session-notices', status: 'completed', updatedAt: '2026-09-12T00:00:00.000Z', pendingTools: 0,
      projection: indexed.projection, transcript: [userEntry('user-1', '原始请求'), assistantEntry('turn:1', '完整结果'), assistantEntry('turn:2', '下轮结果')] })
  const restored = await loadTaskById('employee', 'notices')
  expect(restored?.entries[1]).toMatchObject({ segments: [notice, { text: '完整结果' }] })
  expect(restored?.entries[2]).toMatchObject({ segments: [{ text: '下轮结果' }] })
  expect(compactTaskForStorage(restored!).capabilityNotices).toEqual(indexed.capabilityNotices)
  const changedSession = compactTaskForStorage({ ...restored!, sessionId: 'session-replaced', entries: [] })
  expect(changedSession.capabilityNotices).toBeUndefined()
})

it('retains the initial prompt when a reserved Session has no execution event yet', () => {
  const task = { ...fixture('not-started'), sessionId: 'session-not-started', entries: [
    userEntry('u1', '检查订单并生成报告'),
    assistantEntry('turn:1', [], {}, 'streaming'),
  ] }
  expect(compactTaskForStorage(task).entries).toEqual(task.entries)
  expect(compactTaskForStorage({ ...task, status: 'FAILED' }).entries[0]).toMatchObject({ text: '检查订单并生成报告' })
  expect(compactTaskForStorage({ ...task, status: 'COMPLETED' }).entries).toEqual([])
})

it('compacts a pure chat turn after Harness emits visible response events', () => {
  const task = { ...fixture('chat-stream'), sessionId: 'session-chat-stream', entries: [
    userEntry('u1', '总结这段内容'),
    assistantEntry('turn:1', [{ kind: 'text', id: '1:1', text: '正在总结', streaming: true }], {}, 'streaming'),
  ], projection: {
    ...createXiaoyinTaskProjection(),
    timeline: [{ id: 'assistant:0:1', kind: 'assistant' as const, label: '说明', text: '正在总结', status: 'running' as const, occurredAt: '2026-09-13T01:00:00Z' }],
  } }
  const stored = compactTaskForStorage(task)
  expect(stored.entries).toEqual([])
  expect(stored.messagePreview).toBe('正在总结')
  expect(stored.projection.timeline).toEqual([])
})

function fixture(id: string): LocalTaskRun {
  return { id, source: 'DESKTOP', name: '任务', status: 'RUNNING', createdAt: '', updatedAt: '', projection: createXiaoyinTaskProjection(), entries: [assistantEntry('turn:1', [{ kind: 'text', id: '1:1', text: 'partial', streaming: true }], {}, 'streaming')] }
}

it('opens an archived task directly from storage and keeps its interrupted output', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ ...fixture('older-than-first-page'), archivedAt: '2026-09-01' })
  const task = await loadTaskById('employee', 'older-than-first-page')
  expect(invoke).toHaveBeenCalledWith('load_local_task', { employeeId: 'employee', id: 'older-than-first-page' })
  expect(task).toMatchObject({ status: 'FAILED', archivedAt: '2026-09-01' })
  expect(lastEntryText(task!.entries)).toContain('partial')
  expect(lastEntryText(task!.entries)).toContain('不要重复')
})

it('hydrates a stripped task from the official Harness session inspection', async () => {
  const indexed = { ...fixture('durable'), status: 'COMPLETED' as const, sessionId: 'session-durable', entries: [], messagePreview: '摘要' }
  vi.mocked(invoke).mockReset()
    .mockResolvedValueOnce(indexed)
    .mockResolvedValueOnce({ sessionId: 'session-durable', status: 'completed', updatedAt: '2026-09-12T00:00:00.000Z', pendingTools: 0,
      projection: { ...indexed.projection, status: 'completed', activity: '任务已完成', updatedAt: '2026-09-12T00:00:00.000Z' },
      transcript: [userEntry('user-1', '原始请求'), assistantEntry('turn:1', '完整结果')] })
  const task = await loadTaskById('employee', 'durable')
  expect(task?.entries.map((entry) => entry.role === 'user' ? entry.text : lastEntryText([entry]))).toEqual(['原始请求', '完整结果'])
  expect(task?.projection.activity).toBe('任务已完成')
  expect(invoke).toHaveBeenLastCalledWith('inspect_harness_session', { employeeId: 'employee', sessionId: 'session-durable' })
})

it('rejects a stripped task when its official Harness transcript cannot be read', async () => {
  const indexed = { ...fixture('unavailable'), status: 'COMPLETED' as const, sessionId: 'session-unavailable', entries: [], messagePreview: '仅用于列表检索的摘要' }
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

it('rejects invalid local records without overwriting their original payload', async () => {
  const oldRecord = { id: 'old', source: 'DESKTOP', name: '旧任务', entries: [] }
  vi.mocked(invoke).mockReset().mockResolvedValueOnce({ items: [oldRecord], total: 1, offset: 0, limit: 200 })
  await expect(loadTaskHistoryPage('employee')).rejects.toThrow('缺少运行投影或数据损坏')
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('load_local_tasks', expect.any(Object))
})

it('loads valid tasks while reporting unreadable native rows without writing over them', async () => {
  const valid = { ...fixture('valid'), status: 'COMPLETED' as const }
  vi.mocked(invoke).mockReset().mockResolvedValueOnce({ items: [valid], total: 1, invalidCount: 2, offset: 0, limit: 200 })
  await expect(loadTaskHistory('employee')).resolves.toEqual({ tasks: [valid], invalidCount: 2 })
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('load_local_tasks', { employeeId: 'employee', query: { query: '', offset: 0, limit: 200 } })
})

it('keeps recovered Harness content in memory but persists only its local index', async () => {
  const running = {
    ...fixture('interrupted'), sessionId: 'session-interrupted', updatedAt: '2026-09-13T01:00:00Z',
    entries: [userEntry('u1', '原始要求'), assistantEntry('turn:1', [{ kind: 'text', id: '1:1', text: '已完成前半部分', streaming: true }], {}, 'streaming')],
    projection: { ...createXiaoyinTaskProjection(), status: 'running' as const, executionStarted: true, steps: [{ id: 'tool-1', kind: 'tool' as const, label: '检查文件', status: 'running' as const, startedAt: '2026-09-13T01:00:00Z' }] },
  }
  vi.mocked(invoke).mockReset()
    .mockResolvedValueOnce({ items: [running], total: 1, invalidCount: 0, offset: 0, limit: 200 })
    .mockRejectedValueOnce(new Error('Harness unavailable'))
    .mockResolvedValueOnce(undefined)

  const { tasks } = await loadTaskHistory('employee')
  expect(lastEntryText(tasks[0]!.entries)).toContain('已完成前半部分')
  expect(tasks[0]?.projection.steps[0]?.label).toContain('结果待核对')
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['load_local_tasks', 'inspect_harness_session', 'save_local_task'])
  const saved = vi.mocked(invoke).mock.calls[2]![1] as { task: LocalTaskRun }
  expect(saved.task.status).toBe('FAILED')
  expect(saved.task.entries).toEqual([])
  expect(saved.task.messagePreview).toContain('已完成前半部分')
  expect(saved.task.projection.steps).toEqual([])
})

it('can reopen a pre-execution failure without an available Harness Session', async () => {
  const running = { ...fixture('pre-execution'), sessionId: 'session-reserved', updatedAt: '2026-09-13T01:00:00Z', entries: [
    userEntry('u1', '检查订单并生成报告'),
    assistantEntry('turn:1', [], {}, 'streaming'),
  ] }
  vi.mocked(invoke).mockReset()
    .mockResolvedValueOnce({ items: [running], total: 1, invalidCount: 0, offset: 0, limit: 200 })
    .mockRejectedValueOnce(new Error('Session not found'))
    .mockResolvedValueOnce(undefined)

  const result = await loadTaskHistory('employee')
  const stored = (vi.mocked(invoke).mock.calls[2]![1] as { task: LocalTaskRun }).task
  expect(result.tasks[0]?.status).toBe('FAILED')
  expect(stored.entries[0]).toMatchObject({ text: '检查订单并生成报告' })
  expect(lastEntryText(stored.entries)).toContain('不要重复已经完成的操作')

  vi.mocked(invoke).mockReset().mockResolvedValueOnce(stored).mockRejectedValueOnce(new Error('Session not found'))
  const reopened = await loadTaskById('employee', stored.id)
  expect(reopened?.entries[0]).toMatchObject({ text: '检查订单并生成报告' })
  expect(reopened?.status).toBe('FAILED')
})

it('uses native history when all stored rows are unreadable', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValueOnce({ items: [], total: 0, invalidCount: 2, offset: 0, limit: 200 })
  const storage = { getItem: vi.fn(() => { throw new Error('broken WebView storage') }), removeItem: vi.fn() }
  vi.stubGlobal('window', { localStorage: storage })
  try {
    await expect(loadTaskHistory('employee')).resolves.toEqual({ tasks: [], invalidCount: 2 })
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
  } finally { vi.unstubAllGlobals() }
})

it('queries unseen task IDs instead of advancing an unstable offset', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 200 })
  await loadTaskHistoryPage('employee', 'invoice', 0, ['already-visible'])
  expect(invoke).toHaveBeenCalledWith('load_local_tasks', { employeeId: 'employee', query: { query: 'invoice', offset: 0, limit: 200, excludeIds: ['already-visible'] } })
})
