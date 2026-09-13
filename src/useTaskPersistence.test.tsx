// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useTaskPersistence } from './useTaskPersistence'
import { persistTaskHistory } from './taskHistory'
import { createXiaoyinTaskProjection } from './harness'
import type { LocalTaskRun } from './types'

vi.mock('./taskHistory', () => ({ persistTaskHistory: vi.fn(async () => {}) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => vi.mocked(persistTaskHistory).mockReset())
const task: LocalTaskRun = { id: 'save', source: 'DESKTOP', name: '任务', status: 'COMPLETED', createdAt: '', updatedAt: '', projection: createXiaoyinTaskProjection(), messages: [] }
async function fixture(run: (get: () => ReturnType<typeof useTaskPersistence>, render: (tasks: LocalTaskRun[], owner?: string) => Promise<void>) => Promise<void>) {
  const root = createRoot(document.createElement('div'))
  let state!: ReturnType<typeof useTaskPersistence>
  function Probe({ tasks, owner }: { tasks: LocalTaskRun[]; owner: string }) { state = useTaskPersistence(owner, tasks); return null }
  const render = async (tasks: LocalTaskRun[], owner = 'employee') => { await act(async () => root.render(<Probe tasks={tasks} owner={owner} />)) }
  try { await render([task]); await run(() => state, render) } finally { await act(async () => root.unmount()) }
}
it('keeps failures across task changes and retries the latest task, clearing only on success', async () => {
  await fixture(async (get, render) => {
    vi.mocked(persistTaskHistory).mockRejectedValueOnce(new Error('磁盘已满'))
    await act(async () => { await get().save(task).catch(() => {}) })
    expect(get().failures[0].detail).toBe('磁盘已满')
    const latest = { ...task, messages: [{ role: 'assistant' as const, text: '最新内容' }] }
    await render([latest])
    await act(async () => get().save({ ...task, id: 'another' }))
    expect(get().failures).toHaveLength(1)
    let finish!: () => void
    vi.mocked(persistTaskHistory).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let pending!: Promise<void>
    await act(async () => { pending = get().retry() })
    expect(get().failures[0].retrying).toBe(true)
    expect(persistTaskHistory).toHaveBeenLastCalledWith('employee', latest)
    await act(async () => { finish(); await pending })
    expect(get().failures).toHaveLength(0)
  })
})
it('does not let a stale success clear a newer failed save', async () => {
  await fixture(async (get) => {
    let finish!: () => void
    vi.mocked(persistTaskHistory).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let first!: Promise<void>
    await act(async () => { first = get().save(task) })
    vi.mocked(persistTaskHistory).mockRejectedValueOnce(new Error('最新保存失败'))
    await act(async () => { await get().save(task).catch(() => {}) })
    await act(async () => { finish(); await first })
    expect(get().failures[0].detail).toBe('最新保存失败')
  })
})
it('ignores late failures after account change or explicit deletion', async () => {
  await fixture(async (get, render) => {
    let fail!: (error: Error) => void
    vi.mocked(persistTaskHistory).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    let pending!: Promise<void>
    await act(async () => { pending = get().save(task).catch(() => {}) })
    const oldSave = get().save
    await render([], 'other')
    await act(async () => { fail(new Error('旧账号')); await pending })
    expect(get().failures).toHaveLength(0)
    await expect(oldSave(task)).rejects.toThrow('账号已变化')
    expect(persistTaskHistory).toHaveBeenCalledTimes(1)
    vi.mocked(persistTaskHistory).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    await act(async () => { pending = get().save(task).catch(() => {}) })
    await act(async () => get().forget(task.id))
    await act(async () => { fail(new Error('已删除')); await pending })
    expect(get().failures).toHaveLength(0)
  })
})
