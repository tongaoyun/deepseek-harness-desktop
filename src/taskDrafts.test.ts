import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { draftRootPaths, readTaskDraft, recentWorkDirectories, rememberWorkDirectory, saveTaskDraft, type TaskDraft } from './taskDrafts'

beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }) })
afterEach(() => vi.unstubAllGlobals())
const draft: TaskDraft = { prompt: '分析资料', directories: [{ id: 'root', name: '工作', path: '/work' }], attachments: [{ id: 'file', name: 'a.png', path: 'a.png', rootId: 'root', rootPath: '/work', rootName: '工作', kind: 'image' }], knowledgeRefs: ['kb'], connectorIds: ['crm'], model: 'model-a', updatedAt: 1 }
it('isolates drafts by employee and task, with attachment locations and model preserved', () => {
  saveTaskDraft('a', '', draft); saveTaskDraft('a', 'task', { ...draft, prompt: '另一个任务' })
  expect(readTaskDraft('a', '')).toEqual(draft)
  expect(readTaskDraft('a', 'task')?.prompt).toBe('另一个任务')
  expect(readTaskDraft('b', '')).toBeUndefined()
  expect(draftRootPaths(draft)).toEqual(['/work'])
  saveTaskDraft('a', '')
  expect(readTaskDraft('a', '')).toBeUndefined()
  expect(readTaskDraft('a', 'task')).toBeDefined()
})
it('deduplicates recent directories and tolerates malformed persisted data', () => {
  for (let i = 0; i < 12; i++) rememberWorkDirectory('a', { id: String(i), path: `/work/${i}`, name: String(i) })
  rememberWorkDirectory('a', { id: '7', path: '/work/7', name: '7' })
  expect(recentWorkDirectories('a')).toHaveLength(8)
  expect(recentWorkDirectories('a')[0].path).toBe('/work/7')
  localStorage.setItem('xiaoyin.task-drafts.a', '{broken')
  expect(readTaskDraft('a', '')).toBeUndefined()
})
