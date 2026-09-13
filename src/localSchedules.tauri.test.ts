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

it('imports one employee legacy value once and removes it only after a valid native load', async () => {
  const legacy = [fixture('legacy')]
  localStorage.setItem('xiaoyin:local-schedules:v1:employee-a', JSON.stringify(legacy))
  vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce(legacy)

  await expect(readLocalSchedules('employee-a')).resolves.toEqual(legacy)
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['load_local_schedules', { owner: 'employee-a' }],
    ['load_local_schedules', { owner: 'employee-a', legacy }],
  ])
  expect(localStorage.getItem('xiaoyin:local-schedules:v1:employee-a')).toBeNull()
})

it('keeps corrupt or failed legacy data available for recovery', async () => {
  const key = 'xiaoyin:local-schedules:v1:employee-a'
  localStorage.setItem(key, '{broken')
  vi.mocked(invoke).mockResolvedValueOnce(null)
  await expect(readLocalSchedules('employee-a')).rejects.toThrow()
  expect(invoke).toHaveBeenCalledOnce()
  expect(localStorage.getItem(key)).toBe('{broken')

  localStorage.setItem(key, JSON.stringify([fixture('legacy')]))
  vi.mocked(invoke).mockRejectedValueOnce(new Error('database unavailable'))
  await expect(readLocalSchedules('employee-a')).rejects.toThrow('database unavailable')
  expect(localStorage.getItem(key)).not.toBeNull()
})

it('validates legacy records before native import and can read SQLite without WebView storage', async () => {
  const key = 'xiaoyin:local-schedules:v1:employee-a'
  localStorage.setItem(key, JSON.stringify([{ ...fixture('invalid'), nextAt: 'not-a-date' }]))
  vi.mocked(invoke).mockResolvedValueOnce(null)
  await expect(readLocalSchedules('employee-a')).rejects.toThrow('原始数据保留')
  expect(invoke).toHaveBeenCalledOnce()
  expect(localStorage.getItem(key)).not.toBeNull()

  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('disabled') } })
  vi.mocked(invoke).mockResolvedValueOnce([fixture('native')])
  await expect(readLocalSchedules('employee-a')).resolves.toEqual([fixture('native')])
  expect(invoke).toHaveBeenCalledWith('load_local_schedules', { owner: 'employee-a' })
})

it('ignores malformed stale schedules once native state exists', async () => {
  localStorage.setItem('xiaoyin:local-schedules:v1:employee-a', '{broken')
  vi.mocked(invoke).mockResolvedValueOnce([fixture('native')])
  await expect(readLocalSchedules('employee-a')).resolves.toEqual([fixture('native')])
  expect(invoke).toHaveBeenCalledOnce()
})

it('initializes empty native plans once when no WebView copy exists', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce([])
  await expect(readLocalSchedules('employee-a')).resolves.toEqual([])
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['load_local_schedules', { owner: 'employee-a' }],
    ['load_local_schedules', { owner: 'employee-a', legacy: [] }],
  ])
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
  expect(localStorage.getItem('xiaoyin:local-schedules:v1:employee-b')).toBeNull()

  let broadcasts = 0
  const listener = () => { broadcasts += 1 }
  window.addEventListener(localScheduleEvent, listener)
  vi.mocked(invoke).mockReset().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('disk full'))
  await expect(mutateLocalSchedules('employee-b', () => [fixture('failed')])).rejects.toThrow('disk full')
  window.removeEventListener(localScheduleEvent, listener)
  expect(broadcasts).toBe(0)
})
