// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localScheduleEvent, mutateLocalSchedules, readLocalSchedules, type LocalSchedule } from './localSchedules'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))

const fixture = (id: string): LocalSchedule => ({
  id, name: '日报', prompt: '生成日报', cronExpression: '0 9 * * *', timeZone: 'Asia/Shanghai',
  directories: [], active: true, createdAt: '2026-09-13T00:00:00Z', nextAt: '2026-09-14T01:00:00Z', runs: [],
})

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  })
  vi.mocked(invoke).mockReset()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => unknown) => callback() } })
})
afterEach(() => vi.unstubAllGlobals())

it('reads schedules from native storage', async () => {
  vi.mocked(invoke).mockResolvedValueOnce([fixture('native')])
  await expect(readLocalSchedules('employee-a')).resolves.toEqual([fixture('native')])
  expect(invoke).toHaveBeenCalledWith('load_local_schedules', { owner: 'employee-a' })
})

it('persists before broadcasting and never falls back to WebView storage', async () => {
  const updated = new Promise<void>((resolve) => window.addEventListener(localScheduleEvent, () => resolve(), { once: true }))
  vi.mocked(invoke).mockResolvedValueOnce([]).mockResolvedValueOnce(undefined)
  await mutateLocalSchedules('employee-b', () => [fixture('native')])
  await updated
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['load_local_schedules', { owner: 'employee-b' }],
    ['save_local_schedules', { owner: 'employee-b', schedules: [fixture('native')] }],
  ])

  let broadcasts = 0
  const listener = () => { broadcasts += 1 }
  window.addEventListener(localScheduleEvent, listener)
  vi.mocked(invoke).mockReset().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('disk full'))
  await expect(mutateLocalSchedules('employee-b', () => [fixture('failed')])).rejects.toThrow('disk full')
  window.removeEventListener(localScheduleEvent, listener)
  expect(broadcasts).toBe(0)
})
