import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { persistTaskHistory, removeTaskHistory, loadTaskById, loadTaskHistoryPage } from './taskHistory'
import { createTaskMonitor } from './harness'
import type { LocalTaskRun } from './types'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))

it('serializes snapshots, final state and deletion, and captures immutable save inputs', async () => {
  let finish: () => void = () => {}
  vi.mocked(invoke).mockReset().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve })).mockResolvedValue(undefined)
  const task = fixture('ordered')
  const first = persistTaskHistory('employee', task)
  task.messages[0].text = 'mutated after saving'
  const final = persistTaskHistory('employee', { ...task, status: 'COMPLETED' })
  const deletion = removeTaskHistory('employee', task.id)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
  expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ task: { messages: [{ text: 'partial' }] } })
  finish()
  await Promise.all([first, final, deletion])
  expect(vi.mocked(invoke).mock.calls.map(([method]) => method)).toEqual(['save_local_task', 'save_local_task', 'delete_local_task'])
  expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({ task: { status: 'COMPLETED' } })
})

it('does not permanently block saving after a failed write', async () => {
  vi.mocked(invoke).mockReset().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  const task = fixture('recover-save')
  await expect(persistTaskHistory('employee', task)).rejects.toThrow('disk full')
  await expect(persistTaskHistory('employee', { ...task, status: 'COMPLETED' })).resolves.toBeUndefined()
  expect(invoke).toHaveBeenCalledTimes(2)
})

function fixture(id: string): LocalTaskRun {
  return { id, source: 'DESKTOP', name: '任务', status: 'RUNNING', createdAt: '', updatedAt: '', monitor: createTaskMonitor(), messages: [{ role: 'assistant', text: 'partial', pending: true }] }
}

it('opens an archived task directly from storage and keeps its interrupted output', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ ...fixture('older-than-first-page'), archivedAt: '2026-09-01' })
  const task = await loadTaskById('employee', 'older-than-first-page')
  expect(invoke).toHaveBeenCalledWith('load_local_task', { employeeId: 'employee', id: 'older-than-first-page' })
  expect(task).toMatchObject({ status: 'FAILED', archivedAt: '2026-09-01' })
  expect(task?.messages.at(-1)?.text).toContain('partial')
  expect(task?.messages.at(-1)?.text).toContain('不要重复')
})

it('distinguishes missing tasks from unreadable stored tasks', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'broken' })
  expect(await loadTaskById('employee', 'deleted')).toBeUndefined()
  await expect(loadTaskById('employee', 'broken')).rejects.toThrow('原始数据已保留')
})

it('queries unseen task IDs instead of advancing an unstable offset', async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue({ items: [], total: 0, offset: 0, limit: 200 })
  await loadTaskHistoryPage('employee', 'invoice', 0, ['already-visible'])
  expect(invoke).toHaveBeenCalledWith('load_local_tasks', { employeeId: 'employee', query: { query: 'invoice', offset: 0, limit: 200, excludeIds: ['already-visible'] } })
})
