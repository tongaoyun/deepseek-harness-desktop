// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearStagedTaskDraft, loadTaskDraftState, readTaskDraft, rememberWorkDirectory, saveTaskDraft, stageTaskDraft, type TaskDraft } from './taskDrafts'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))

const draft: TaskDraft = {
  prompt: '未发送的需求', attachments: [], directories: [], knowledgeRefs: [], connectorIds: [], model: 'model-a', updatedAt: 1,
}
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

it('recovers a synchronously staged draft after an authentication-driven workspace unmount', async () => {
  stageTaskDraft('employee', '', { ...draft, prompt: '最后输入的一段' })
  const emergencyKey = 'xiaoyin.pending-task-draft.employee'
  vi.mocked(invoke).mockResolvedValueOnce({ drafts: { 'new-task': draft }, recentDirectories: [] }).mockResolvedValue(undefined)
  await loadTaskDraftState('employee')
  expect(readTaskDraft('employee', '')?.prompt).toBe('最后输入的一段')
  expect(invoke).toHaveBeenCalledWith('save_local_workspace_state', { employeeId: 'employee', state: expect.objectContaining({ drafts: { 'new-task': expect.objectContaining({ prompt: '最后输入的一段' }) } }) })
  expect(localStorage.getItem(emergencyKey)).toBeNull()
})

it('retains the emergency draft when native recovery cannot persist it', async () => {
  stageTaskDraft('employee', '', { ...draft, prompt: '还不能丢' })
  vi.mocked(invoke).mockResolvedValueOnce({ drafts: {}, recentDirectories: [] }).mockRejectedValueOnce(new Error('disk full'))
  await expect(loadTaskDraftState('employee')).rejects.toThrow('disk full')
  expect(localStorage.getItem('xiaoyin.pending-task-draft.employee')).toContain('还不能丢')
})

it('does not clear a newer emergency revision when an older save finishes', () => {
  const older = stageTaskDraft('employee', '', draft)
  const newer = stageTaskDraft('employee', '', { ...draft, prompt: '更新的一版' })
  clearStagedTaskDraft('employee', '', older)
  expect(localStorage.getItem('xiaoyin.pending-task-draft.employee')).toContain('更新的一版')
  clearStagedTaskDraft('employee', '', newer)
  expect(localStorage.getItem('xiaoyin.pending-task-draft.employee')).toBeNull()
})

it('serializes edits, retains the last successful state and does not fall back to WebView writes', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ drafts: {}, recentDirectories: [] })
  await loadTaskDraftState('employee')
  vi.mocked(invoke).mockResolvedValue(undefined)
  const first = saveTaskDraft('employee', '', draft)
  const second = rememberWorkDirectory('employee', { id: 'root', name: '工作', path: '/work' })
  await Promise.all([first, second])
  const saves = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'save_local_workspace_state')
  expect(saves).toHaveLength(2)
  expect(saves[1]?.[1]).toMatchObject({ employeeId: 'employee', state: {
    drafts: { 'new-task': draft }, recentDirectories: [{ id: 'root', name: '工作', path: '/work' }],
  } })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('disk full'))
  await expect(saveTaskDraft('employee', '', { ...draft, prompt: '未保存' })).rejects.toThrow('disk full')
  expect(readTaskDraft('employee', '')).toEqual(draft)
})
