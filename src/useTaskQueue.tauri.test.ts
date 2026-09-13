// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readTaskQueues } from './useTaskQueue'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  vi.mocked(invoke).mockReset()
})
afterEach(() => vi.unstubAllGlobals())

it('imports a validated legacy queue paused and removes the old value after native load', async () => {
  const legacy = { task: { paused: false, items: [{ id: 'message', text: '继续分析' }] } }
  const migrated = { task: { ...legacy.task, paused: true } }
  localStorage.setItem('xiaoyin:task-queue:employee', JSON.stringify(legacy))
  vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce(migrated)
  await expect(readTaskQueues('employee')).resolves.toEqual(migrated)
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['load_local_task_queues', { employeeId: 'employee' }],
    ['load_local_task_queues', { employeeId: 'employee', legacy: migrated }],
  ])
  expect(localStorage.getItem('xiaoyin:task-queue:employee')).toBeNull()
})

it('does not call native storage or erase legacy data when validation fails', async () => {
  const key = 'xiaoyin:task-queue:employee'
  localStorage.setItem(key, JSON.stringify({ task: { paused: false, items: [{ id: 'message', text: '' }] } }))
  vi.mocked(invoke).mockResolvedValueOnce(null)
  await expect(readTaskQueues('employee')).rejects.toThrow('原始数据保留')
  expect(invoke).toHaveBeenCalledOnce()
  expect(localStorage.getItem(key)).not.toBeNull()
})

it('uses native queues when stale WebView data is corrupt', async () => {
  localStorage.setItem('xiaoyin:task-queue:employee', '{broken')
  vi.mocked(invoke).mockResolvedValueOnce({})
  await expect(readTaskQueues('employee')).resolves.toEqual({})
  expect(invoke).toHaveBeenCalledOnce()
})

it('initializes an empty native queue when no legacy data exists', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce({})
  await expect(readTaskQueues('employee')).resolves.toEqual({})
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['load_local_task_queues', { employeeId: 'employee' }],
    ['load_local_task_queues', { employeeId: 'employee', legacy: {} }],
  ])
})
