// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalImHarnessContext } from './localIm'
import type { LocalTaskRun } from './types'
import { useLocalImSync } from './useLocalImSync'

const bridge = vi.hoisted(() => ({
  loadLocalImStatus: vi.fn(),
  persistTaskHistory: vi.fn(),
  startLocalIm: vi.fn(),
  syncLocalImTasks: vi.fn(),
}))

vi.mock('./localIm', () => ({
  loadLocalImStatus: bridge.loadLocalImStatus,
  startLocalIm: bridge.startLocalIm,
  syncLocalImTasks: bridge.syncLocalImTasks,
}))
vi.mock('./taskHistory', () => ({ persistTaskHistory: bridge.persistTaskHistory }))

const context: LocalImHarnessContext = {
  employeeId: 'employee-1', teamId: 'team-1', litellmBaseUrl: 'http://litellm',
  knowledgeEndpoint: 'http://knowledge', scheduleEndpoint: 'http://schedules',
  capabilitySnapshot: { schemaVersion: 1, createdAt: 'test', selections: [], artifacts: [], implicitArtifacts: [], requestedConnectorIds: [], connectors: [], requestedKnowledgeBaseRefs: [], knowledgeBaseRefs: [] },
  model: 'deepseek-v4-flash', modelApiKey: 'model-key',
  accessToken: 'employee-token',
}

function Harness({
  onSyncError, onTasksChanged = vi.fn(), tasks = [], employeeId = 'employee-1',
}: {
  onSyncError: (message: string) => void
  onTasksChanged?: (tasks: LocalTaskRun[]) => void
  tasks?: LocalTaskRun[]
  employeeId?: string
}) {
  useLocalImSync({
    context, currentTaskId: '', employeeId, enabled: true, onSyncError,
    onCurrentTaskChanged: vi.fn(), onTasksChanged, tasks,
  })
  return null
}

describe('local IM synchronization', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    vi.useFakeTimers()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    bridge.startLocalIm.mockReset().mockResolvedValue({ enabled: false })
    bridge.syncLocalImTasks.mockReset().mockRejectedValue(new Error('runtime unavailable'))
    bridge.loadLocalImStatus.mockReset()
    bridge.persistTaskHistory.mockReset().mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    container.remove()
  })

  it('reports repeated failures once instead of showing an error every poll', async () => {
    const onSyncError = vi.fn()
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness onSyncError={onSyncError} />)
      await Promise.resolve()
    })
    await act(async () => vi.advanceTimersByTimeAsync(40_000))

    expect(bridge.syncLocalImTasks).toHaveBeenCalledTimes(5)
    expect(onSyncError).toHaveBeenCalledTimes(1)
    expect(onSyncError).toHaveBeenCalledWith(expect.stringContaining('IM 同步连续失败'))
    await act(async () => root.unmount())
  })

  it('retries task persistence before publishing an IM update', async () => {
    const task: LocalTaskRun = {
      id: 'task-1', source: 'DESKTOP', name: '库存分析', status: 'RUNNING',
      createdAt: '2026-09-04T01:00:00Z', updatedAt: '2026-09-04T01:00:00Z', sessionId: 'session-1',
      monitor: { status: 'running', activity: '处理中', updatedAt: '2026-09-04T01:00:00Z', steps: [], artifacts: [] },
      messages: [],
    }
    bridge.syncLocalImTasks.mockResolvedValue(null)
    bridge.loadLocalImStatus.mockResolvedValue({
      enabled: true,
      conversations: [{
        boundTaskId: 'task-1', messages: [{ id: 'message-1', role: 'assistant', text: '完成', createdAt: '2026-09-04T01:01:00Z' }],
        taskEvents: [], status: 'COMPLETED', updatedAt: '2026-09-04T01:01:00Z', sessionId: 'session-1',
      }],
    })
    bridge.persistTaskHistory.mockRejectedValue(new Error('database busy'))
    const onSyncError = vi.fn()
    const onTasksChanged = vi.fn()
    const root = createRoot(container)
    await act(async () => {
      root.render(<Harness onSyncError={onSyncError} onTasksChanged={onTasksChanged} tasks={[task]} />)
      await Promise.resolve()
    })
    await act(async () => vi.advanceTimersByTimeAsync(20_000))

    expect(bridge.persistTaskHistory).toHaveBeenCalledTimes(3)
    expect(onTasksChanged).not.toHaveBeenCalled()
    expect(onSyncError).toHaveBeenCalledWith(expect.stringContaining('database busy'))
    await act(async () => root.unmount())
  })

  it('does not replace newly created local tasks while an IM checkpoint is saving', async () => {
    const task: LocalTaskRun = {
      id: 'task-1', source: 'DESKTOP', name: '日报', status: 'RUNNING',
      createdAt: '2026-09-04T01:00:00Z', updatedAt: '2026-09-04T01:00:00Z', sessionId: 'session-1',
      monitor: { status: 'running', activity: '处理中', updatedAt: '2026-09-04T01:00:00Z', steps: [], artifacts: [] }, messages: [],
    }
    bridge.syncLocalImTasks.mockResolvedValue(null)
    bridge.loadLocalImStatus.mockResolvedValue({ enabled: true, conversations: [{ boundTaskId: task.id, status: 'COMPLETED', updatedAt: '2026-09-04T01:01:00Z', sessionId: task.sessionId, messages: [], taskEvents: [] }] })
    let complete!: () => void
    bridge.persistTaskHistory.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve }))
    const onTasksChanged = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(<Harness onSyncError={vi.fn()} onTasksChanged={onTasksChanged} tasks={[task]} />))
    expect(bridge.persistTaskHistory).toHaveBeenCalledOnce()
    await act(async () => root.render(<Harness onSyncError={vi.fn()} onTasksChanged={onTasksChanged} tasks={[task, { ...task, id: 'new-task' }]} />))
    await act(async () => complete())
    expect(onTasksChanged).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(onTasksChanged.mock.calls[0]![0]).toHaveLength(2)
    expect(onTasksChanged.mock.calls[0]![0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'new-task' })]))
    await act(async () => root.unmount())
  })

  it('ignores late startup and polling errors after unmount', async () => {
    let rejectStart!: (error: Error) => void
    let rejectSync!: (error: Error) => void
    bridge.startLocalIm.mockReturnValue(new Promise((_resolve, reject) => { rejectStart = reject }))
    const onSyncError = vi.fn()
    const root = createRoot(container)
    await act(async () => root.render(<Harness onSyncError={onSyncError} />))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    bridge.syncLocalImTasks.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSync = reject }))
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    await act(async () => root.unmount())
    await act(async () => { rejectStart(new Error('old startup')); rejectSync(new Error('old polling')) })
    expect(onSyncError).not.toHaveBeenCalled()
  })
})
