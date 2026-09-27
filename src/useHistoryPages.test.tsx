// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { loadTaskHistoryPage, type LocalTaskPage } from './taskHistory'
import { useHistoryPages } from './useHistoryPages'
import type { LocalTaskRun } from './types'
vi.mock('./taskHistory', async (original) => ({ ...await original<object>(), loadTaskHistoryPage: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
it('loads beyond the first 200 tasks and ignores a stale employee/search request', async () => {
  vi.useFakeTimers()
  let resolve!: (page: LocalTaskPage) => void
  vi.mocked(loadTaskHistoryPage).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    .mockResolvedValue({ items: [{ id: 'new' } as LocalTaskRun], total: 1, offset: 0, limit: 200 })
  const merge = vi.fn(), root = createRoot(document.createElement('div'))
  let controller: ReturnType<typeof useHistoryPages>
  function Host({ owner, query }: { owner: string; query: string }) { controller = useHistoryPages(owner, query, merge, ['loaded']); return null }
  try {
    await act(async () => root.render(<Host owner="a" query="" />))
    await act(async () => { void controller!.load() })
    expect(loadTaskHistoryPage).toHaveBeenCalledWith('a', '', 0, ['loaded'], expect.any(AbortSignal))
    const staleSignal = vi.mocked(loadTaskHistoryPage).mock.calls[0]![4]!
    expect(staleSignal.aborted).toBe(false)
    await act(async () => root.render(<Host owner="b" query="search" />))
    expect(staleSignal.aborted).toBe(true)
    await act(async () => resolve({ items: [{ id: 'old' } as LocalTaskRun], total: 201, offset: 200, limit: 200 }))
    expect(merge).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(loadTaskHistoryPage).toHaveBeenLastCalledWith('b', 'search', 0, [], expect.any(AbortSignal))
    expect(controller!.ids).toEqual(['new'])
    expect(controller!.more).toBe(false)
  } finally { await act(async () => root.unmount()) }
})

it('shows skipped history while keeping valid entries available', async () => {
  vi.mocked(loadTaskHistoryPage).mockResolvedValue({ items: [{ id: 'valid' } as LocalTaskRun], total: 1, offset: 0, limit: 200 })
  const merge = vi.fn(), root = createRoot(document.createElement('div'))
  let controller: ReturnType<typeof useHistoryPages>
  function Host() { controller = useHistoryPages('employee', '', merge); return null }
  try {
    await act(async () => root.render(<Host />))
    await act(async () => { await controller!.load() })
    expect(merge).toHaveBeenCalledWith([{ id: 'valid' }])
    expect(controller!.ids).toEqual(['valid'])
    expect(controller!.more).toBe(false)
    expect(controller!.error).toBe('')
  } finally { await act(async () => root.unmount()) }
})
