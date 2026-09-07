// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { useLocalSchedules } from './useLocalSchedules'
import { readLocalSchedules, tickLocalSchedules } from './localSchedules'
vi.mock('./localSchedules', () => ({ localScheduleEvent: 'schedule-change', readLocalSchedules: vi.fn(() => []), tickLocalSchedules: vi.fn(), mutateLocalSchedules: vi.fn(), nextLocalRun: vi.fn(), saveLocalSchedule: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('keeps a failed scheduler blocked until an explicit successful recovery, then resumes ticks', async () => {
  vi.useFakeTimers()
  vi.mocked(tickLocalSchedules).mockRejectedValueOnce(new Error('storage failure')).mockResolvedValue(undefined)
  const container = document.createElement('div'), root = createRoot(container)
  let controller: ReturnType<typeof useLocalSchedules>
  function Host({ ready }: { ready: boolean }) { controller = useLocalSchedules('owner', ready, vi.fn()); return null }
  try {
    await act(async () => root.render(<Host ready />))
    expect(controller!.error).toContain('本机调度已暂停')
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(tickLocalSchedules).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<Host ready={false} />))
    await act(async () => controller!.refresh())
    expect(controller!.error).toContain('仍已暂停')
    await act(async () => root.render(<Host ready />))
    await act(async () => controller!.refresh())
    expect(controller!.error).toBe('')
    expect(tickLocalSchedules).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(tickLocalSchedules).toHaveBeenCalledTimes(3)
  } finally { await act(async () => root.unmount()) }
})

it('does not erase an unreadable plan error when the runtime is not ready', async () => {
  vi.mocked(readLocalSchedules).mockImplementation(() => { throw new Error('broken plans') })
  const root = createRoot(document.createElement('div'))
  let controller: ReturnType<typeof useLocalSchedules>
  function Host() { controller = useLocalSchedules('owner', false, vi.fn()); return null }
  try {
    await act(async () => root.render(<Host />))
    await act(async () => controller!.refresh())
    expect(controller!.error).toContain('broken plans')
    expect(tickLocalSchedules).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); vi.mocked(readLocalSchedules).mockReturnValue([]) }
})
