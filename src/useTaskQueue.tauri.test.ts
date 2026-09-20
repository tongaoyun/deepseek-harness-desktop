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

it('reads an empty native queue', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({})
  await expect(readTaskQueues('employee')).resolves.toEqual({})
  expect(invoke).toHaveBeenCalledWith('load_local_task_queues', { employeeId: 'employee' })
})
