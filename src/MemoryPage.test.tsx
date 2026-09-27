// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryPage } from './MemoryPage'
import { emptyMemoryProfile, saveSyncedMemoryProfile } from './memory'

vi.mock('./memory', async (original) => ({ ...await original<object>(),
  loadMemoryHistory: async () => [],
  loadSyncedMemoryProfile: async () => ({ enabled: true, automaticMemory: false, collaborationStyle: '', workManual: '', entries: [{ id: 'one', kind: 'fact', text: '库存规则', source: '用户主动记住', taskId: 'task-1', updatedAt: '2026-09-07T00:00:00Z' }] }),
  saveSyncedMemoryProfile: vi.fn(async (_owner, _endpoint, _token, profile) => ({ ...profile, syncPending: true })),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
it('manages entries, shows source tasks, and distinguishes local save from sync', async () => {
  const box = document.body.appendChild(document.createElement('div'))
  const root = createRoot(box)
  const open = vi.fn()
  const saved = vi.fn()
  const click = async (label: string) => act(async () => [...box.querySelectorAll('button')].find((button) => button.textContent === label)!.click())
  try {
    await act(async () => root.render(<MemoryPage employeeId="u" endpoint="/memory" sessionToken="" onSaved={saved} onOpenTask={open} />))
    expect(box.querySelectorAll('[role="switch"]')).toHaveLength(2)
    await click('来源任务')
    expect(open).toHaveBeenCalledWith('task-1')
    await click('简洁直接')
    await click('删除')
    expect(box.querySelector('[aria-label="记忆内容"]')).toBeNull()
    await click('保存设置')
    expect(saveSyncedMemoryProfile).toHaveBeenCalledWith('u', '/memory', '', expect.objectContaining({ entries: [], collaborationStyle: expect.stringContaining('先给结论') }))
    expect(box.querySelector('[role="status"]')?.textContent).toContain('云端同步未完成')
    expect(saved).toHaveBeenCalled()
    expect(emptyMemoryProfile.entries).toEqual([])
  } finally { await act(async () => root.unmount()); box.remove() }
})
it('retains an unfinished addition across page unmounts without saving it as a memory', async () => {
  const box = document.body.appendChild(document.createElement('div'))
  let root = createRoot(box)
  const page = <MemoryPage employeeId="draft-user" endpoint="/memory" sessionToken="" onSaved={() => {}} />
  try {
    await act(async () => root.render(page))
    await act(async () => [...box.querySelectorAll('button')].find((button) => button.textContent === '添加记忆')!.click())
    const area = box.querySelector<HTMLTextAreaElement>('[aria-label="新增记忆内容"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '默认用人民币'); area.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(JSON.parse(localStorage.getItem('xiaoyin.memory-draft.draft-user')!).newText).toBe('默认用人民币')
    await act(async () => root.unmount())
    root = createRoot(box)
    await act(async () => root.render(page))
    expect(box.querySelector<HTMLTextAreaElement>('[aria-label="新增记忆内容"]')?.value).toBe('默认用人民币')
    expect(saveSyncedMemoryProfile).not.toHaveBeenCalled()
    await act(async () => [...box.querySelectorAll('button')].find((button) => button.textContent === '加入草稿')!.click())
    expect(box.querySelectorAll('[aria-label="记忆内容"]')).toHaveLength(2)
  } finally { await act(async () => root.unmount()); box.remove() }
})
