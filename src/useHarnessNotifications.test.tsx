// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { listenHarnessNotifications, type HarnessNotification } from './harness'
import { useHarnessNotifications, type StreamingTaskState } from './useHarnessNotifications'

vi.mock('./harness', async (original) => ({ ...await original<object>(), listenHarnessNotifications: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('ignores late events after stopping without affecting other tasks', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const state = (): StreamingTaskState => {
    return { sessionId: 'session', projection: { status: 'running', activity: '', updatedAt: '', steps: [], artifacts: [] }, messages: [{ role: 'assistant', text: '已收到的部分', pending: true }], responseKey: '', cancellationRequested: false }
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
    expect(first.messages[0].text).toBe('已收到的部分')
    await act(async () => listener(event('two')))
    expect(onTaskUpdate).not.toHaveBeenCalled()
    expect(onCurrentUpdate).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('merges official token and context projections without replacing the Xiaoyin task view', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const first: StreamingTaskState = {
    sessionId: 'session', projection: { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [] },
    projectionSeq: -1, projectionSeqByKey: {}, messages: [], responseKey: '', cancellationRequested: false,
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
    projectionSeq: -1, projectionSeqByKey: {}, messages: [], responseKey: '', cancellationRequested: false,
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
    projectionSeq: -1, projectionSeqByKey: {}, messages: [], responseKey: '', cancellationRequested: false,
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
    }, projectionSeq: 1, projectionSeqByKey: {}, messages: [], responseKey: '', cancellationRequested: true,
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
