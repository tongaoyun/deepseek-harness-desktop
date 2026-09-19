// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { listenHarnessNotifications, type HarnessNotification } from './harness'
import { useHarnessNotifications, type StreamingTaskState } from './useHarnessNotifications'
import { assistantEntry, lastEntryText, toolSegment, userEntry } from './conversation/testing'

vi.mock('./harness', async (original) => ({ ...await original<object>(), listenHarnessNotifications: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('ignores late events after stopping without affecting other tasks', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const state = (): StreamingTaskState => {
    return { sessionId: 'session', projection: { status: 'running', activity: '', updatedAt: '', steps: [], artifacts: [] }, entries: [assistantEntry('turn:1', [{ kind: 'text', id: '1:1', text: '已收到的部分', streaming: true }], {}, 'streaming')], cancellationRequested: false }
  }
  const first = state(); const other = state()
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first], ['two', other]]) }
  const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    first.cancellationRequested = true
    const event = (taskId: string): HarnessNotification => ({ taskId, requestId: 1, event: { event: { method: 'session.status', params: { sessionId: 's', status: 'idle' } } } })
    await act(async () => listener(event('one')))
    expect(onCurrentUpdate).not.toHaveBeenCalled()
    expect(onTaskUpdate).not.toHaveBeenCalled()
    expect(lastEntryText(first.entries)).toBe('已收到的部分')
    await act(async () => listener(event('two')))
    expect(onTaskUpdate).not.toHaveBeenCalled()
    expect(onCurrentUpdate).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('routes native approval notifications to the current running turn without a turn number', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const streaming: StreamingTaskState = {
    sessionId: 'session', projection: { status: 'running', activity: '正在调用', updatedAt: '', steps: [], artifacts: [] },
    entries: [assistantEntry('turn:1', [], {}, 'streaming')], cancellationRequested: false,
  }
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', streaming]]) }; const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    await act(async () => listener({ taskId: 'one', requestId: 1, event: { event: { method: 'session.event', params: {
      event: { type: 'approval/request', data: { approvalId: 'bridge-1', name: 'mcp_erp-mcp_store_sales_summary', reason: '需要确认' } },
    } } } }))
    expect(streaming.entries[0]).toMatchObject({ segments: [{ kind: 'approval', approvalId: 'bridge-1', status: 'running' }] })
    expect(onCurrentUpdate).toHaveBeenCalledOnce()
    expect(onTaskUpdate).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('merges official token and context projections without replacing the Xiaoyin task view', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const first: StreamingTaskState = {
    sessionId: 'session', projection: { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [] },
    projectionSeq: -1, projectionSeqByKey: {}, entries: [], cancellationRequested: false,
  }
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first]]) }
  const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    const projection = (key: string, value: unknown, seq: number): HarnessNotification => ({ taskId: 'one', requestId: 1, event: {
      method: 'session.projection', params: { sessionId: 'session', key, value, seq },
    } })
    await act(async () => listener(projection('tokenUsage', { uncachedInputTokens: 120, outputTokens: 30, cacheReadTokens: 4, cacheWriteTokens: 2 }, 3)))
    await act(async () => listener(projection('contextPressure', { contextWindow: 1000, pressureTokens: 120, projectedTokens: 180 }, 4)))
    expect(first.projection.tokenUsage).toMatchObject({ uncachedInputTokens: 120, outputTokens: 30 })
    expect(first.projection.contextPressure).toEqual({ contextWindow: 1000, pressureTokens: 120, projectedTokens: 180 })
    expect(first.projection.activity).toBe('正在处理')
    expect(onTaskUpdate).toHaveBeenCalledTimes(2)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('rejects negative official metric projections without advancing their sequence', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const first: StreamingTaskState = {
    sessionId: 'session', projection: { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [] },
    projectionSeq: -1, projectionSeqByKey: {}, entries: [], cancellationRequested: false,
  }
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first]]) }; const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    const event = (key: string, value: unknown, seq: number): HarnessNotification => ({ taskId: 'one', requestId: 1, event: { method: 'session.projection', params: { sessionId: 'session', key, value, seq } } })
    await act(async () => listener(event('tokenUsage', { uncachedInputTokens: -1, outputTokens: 2 }, 3)))
    await act(async () => listener(event('tokenUsage', { uncachedInputTokens: 10, outputTokens: 2 }, 2)))
    expect(first.projection.tokenUsage).toEqual({ uncachedInputTokens: 10, outputTokens: 2 })
    expect(first.projectionSeqByKey?.tokenUsage).toBe(2)
    expect(onTaskUpdate).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('isolates projections by session and ignores late or duplicate sequences', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const first: StreamingTaskState = {
    sessionId: 'session-current', projection: { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [] },
    projectionSeq: -1, projectionSeqByKey: {}, entries: [], cancellationRequested: false,
  }
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first]]) }
  const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    const projection = (sessionId: string, key: string, value: unknown, seq: number): HarnessNotification => ({ taskId: 'one', requestId: 1, event: {
      method: 'session.projection', params: { sessionId, key, value, seq },
    } })
    const view = { status: 'completed', activity: '完成', updatedAt: '2026-09-12T00:00:00Z', steps: [], artifacts: [] }
    await act(async () => listener(projection('old-session', 'xiaoyin.task', view, 9)))
    expect(first.projection.status).toBe('running')
    await act(async () => listener(projection('session-current', 'xiaoyin.task', view, 3)))
    await act(async () => listener(projection('session-current', 'xiaoyin.task', { ...view, activity: '过期结果' }, 2)))
    await act(async () => listener(projection('session-current', 'xiaoyin.task', { ...view, activity: '重复结果' }, 3)))
    expect(first.projection.activity).toBe('完成')
    expect(first.projectionSeq).toBe(3)
    expect(onTaskUpdate).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('keeps stopping status while accepting a late receipt for an already-started tool', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const first: StreamingTaskState = {
    sessionId: 'session', projection: {
      status: 'running', activity: '正在停止', updatedAt: '2026-09-12T00:00:00Z', steps: [{ id: 'tool:write', kind: 'tool', label: '写入文件', toolName: 'local_files_write_text', status: 'running', startedAt: '2026-09-12T00:00:00Z' }], artifacts: [],
    }, projectionSeq: 1, projectionSeqByKey: {}, entries: [], cancellationRequested: true,
  }
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first]]) }; const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    await act(async () => listener({ taskId: 'one', requestId: 1, event: { method: 'session.projection', params: {
      sessionId: 'session', key: 'xiaoyin.task', seq: 2, value: {
        status: 'completed', activity: '任务已完成', updatedAt: '2026-09-12T00:00:01Z', steps: [{ id: 'tool:write', kind: 'tool', label: '写入文件', toolName: 'local_files_write_text', status: 'completed', startedAt: '2026-09-12T00:00:00Z', completedAt: '2026-09-12T00:00:01Z' }], artifacts: [{ id: 'repo:file.txt', rootId: 'repo', rootName: '工作目录', path: 'file.txt', name: 'file.txt', kind: 'file', sourceTool: 'local_files_write_text', action: 'updated', createdAt: '2026-09-12T00:00:01Z' }],
      },
    } } }))
    expect(first.projection.status).toBe('running')
    expect(first.projection.activity).toBe('正在停止')
    expect(first.projection.steps[0]?.status).toBe('completed')
    expect(first.projection.artifacts).toHaveLength(1)
    expect(onCurrentUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running', activity: '正在停止' }))
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('merges the settled transcript projection into the open turn', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const first: StreamingTaskState = {
    sessionId: 'session', projection: { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [] },
    projectionSeq: -1, projectionSeqByKey: {}, entries: [], cancellationRequested: false,
  }
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first]]) }; const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    const turn = assistantEntry('turn:1', [
      { kind: 'text', id: '1:1', text: '第一段。' },
      toolSegment('call-1', 'bash', { label: '运行命令' }),
    ], { startedAt: '2026-09-12T00:00:00Z', completedAt: '2026-09-12T00:00:02Z' })
    const projection = (value: unknown, seq: number): HarnessNotification => ({ taskId: 'one', requestId: 1, event: {
      method: 'session.projection', params: { sessionId: 'session', key: 'xiaoyin.transcript', value, seq },
    } })
    await act(async () => listener(projection({ turn }, 1)))
    expect(first.entries).toHaveLength(1)
    expect(lastEntryText(first.entries)).toBe('第一段。')
    expect(first.projectionSeqByKey?.['xiaoyin.transcript']).toBe(1)
    // Stale and duplicate sequences never regress the visible transcript.
    await act(async () => listener(projection({ turn: assistantEntry('turn:1', '过期内容') }, 1)))
    expect(lastEntryText(first.entries)).toBe('第一段。')
    expect(onTaskUpdate).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('streams text across tool calls without clearing what was already written', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const first: StreamingTaskState = {
    sessionId: 'session', projection: { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [] },
    projectionSeq: -1, projectionSeqByKey: {}, entries: [userEntry('u1', '任务'), assistantEntry('pending', [], {}, 'streaming')], cancellationRequested: false,
  }
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first]]) }; const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    const event = (type: string, data: Record<string, unknown>): HarnessNotification => ({ taskId: 'one', requestId: 1, event: {
      event: { method: 'session.event', params: { sessionId: 'session', event: { type, data } } }, rootSessionId: 'session',
    } })
    await act(async () => listener(event('turn/start', { turn: 1 })))
    await act(async () => listener(event('text-chunks', { turn: 1, step: 1, texts: ['我先检查文件。'] })))
    expect(lastEntryText(first.entries)).toBe('我先检查文件。')
    await act(async () => listener(event('tool/call', { turn: 1, step: 2, callId: 'call-1', name: 'local_files_list' })))
    await act(async () => listener(event('text-chunks', { turn: 1, step: 3, texts: ['检查完成。'] })))
    // The earlier segment survives the tool call, and the new one appends after it.
    const turn = first.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text)).toEqual(['我先检查文件。', '检查完成。'])
    await act(async () => listener(event('turn/end', { turn: 1, reason: { kind: 'completed' } })))
    expect(turn.status).toBe('streaming')
    expect(first.entries.at(-1)).toMatchObject({ status: 'completed' })
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows a capability the runtime could not provide on the turn', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const first: StreamingTaskState = {
    sessionId: 'session', projection: { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [] },
    projectionSeq: -1, projectionSeqByKey: {}, entries: [userEntry('u1', '查订单'), assistantEntry('pending', [], {}, 'streaming')], cancellationRequested: false,
  }
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn(); const onCapabilityNotice = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first]]) }; const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate, onCapabilityNotice }); return null }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    await act(async () => listener({ taskId: 'one', requestId: 1, event: { method: 'session.projection', params: {
      sessionId: 'session', key: 'xiaoyin.capabilityNotice', seq: 1,
      value: { kind: 'connector', id: 'erp-mcp', name: 'erp-mcp', reason: '连接失败' },
    } } }))
    const turn = first.entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments).toEqual([{ kind: 'notice', id: 'notice:connector:erp-mcp', level: 'warning', text: '本轮未使用连接器「erp-mcp」：连接失败' }])
    expect(onCapabilityNotice).toHaveBeenCalledOnce()
    expect(onCapabilityNotice).toHaveBeenCalledWith('one', { sessionId: 'session', turnId: 'pending',
      segment: turn.segments[0] })
    // The same gap is never reported twice.
    await act(async () => listener({ taskId: 'one', requestId: 1, event: { method: 'session.projection', params: {
      sessionId: 'session', key: 'xiaoyin.capabilityNotice', seq: 2,
      value: { kind: 'connector', id: 'erp-mcp', name: 'erp-mcp', reason: '连接失败' },
    } } }))
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(first.entries.at(-1)?.role === 'assistant' && (first.entries.at(-1) as { segments: unknown[] }).segments).toHaveLength(1)
    expect(onCapabilityNotice).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); container.remove() }
})
