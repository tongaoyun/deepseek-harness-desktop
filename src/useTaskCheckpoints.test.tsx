// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useTaskCheckpoints } from './useTaskCheckpoints'
import { assistantEntry } from './conversation/testing'
import { persistTaskHistory } from './taskHistory'
import { createXiaoyinTaskProjection } from './harness'
import type { LocalTaskRun } from './types'

vi.mock('./taskHistory', () => ({ persistTaskHistory: vi.fn(async () => {}) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('checkpoints only changed running tasks and never saves a stale running snapshot after completion', async () => {
  vi.useFakeTimers()
  vi.mocked(persistTaskHistory).mockClear()
  const container = document.createElement('div'); const root = createRoot(container)
  const errors = vi.fn()
  const task: LocalTaskRun = { id: 'checkpoint', source: 'DESKTOP', name: '任务', status: 'RUNNING', createdAt: '', updatedAt: '', projection: createXiaoyinTaskProjection(), entries: [] }
  function Probe({ tasks, owner = 'employee' }: { tasks: LocalTaskRun[]; owner?: string }) { useTaskCheckpoints(owner, tasks, errors); return null }
  try {
    await act(async () => root.render(<Probe tasks={[task]} />))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(persistTaskHistory).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(4000))
    expect(persistTaskHistory).toHaveBeenCalledTimes(1)
    // A running turn producing visible output advances the entries transcript and its
    // bounded preview; the checkpoints key is derived from the preview (kept small on purpose).
    await act(async () => root.render(<Probe tasks={[{ ...task, entries: [assistantEntry('pending', '部分结果', {}, 'streaming')], messagePreview: '部分结果' }]} />))
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(persistTaskHistory).toHaveBeenCalledTimes(2)
    await act(async () => root.render(<Probe tasks={[{ ...task, status: 'COMPLETED' }]} />))
    await act(async () => { window.dispatchEvent(new Event('pagehide')); await vi.advanceTimersByTimeAsync(2000) })
    expect(persistTaskHistory).toHaveBeenCalledTimes(2)
    expect(errors).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); vi.useRealTimers() }
})
