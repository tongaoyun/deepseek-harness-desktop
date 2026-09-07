// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useMemoryCommands } from './useMemoryCommands'
import { changeMemoryEntry, emptyMemoryProfile } from './memory'

vi.mock('./memory', async (original) => ({ ...await original<object>(),
  loadSyncedMemoryProfile: async () => ({ enabled: true, collaborationStyle: '', workManual: '', entries: [
    { id: 'one', kind: 'preference', text: '默认用美元', source: '用户', taskId: 'task-1', updatedAt: '2026-09-07T00:00:00Z' },
    { id: 'other', kind: 'preference', text: '另一个任务的规则', source: '用户', taskId: 'task-2', updatedAt: '2026-09-07T01:00:00Z' },
  ] }),
  changeMemoryEntry: vi.fn(async () => ({ enabled: true, collaborationStyle: '', workManual: '', entries: [] })),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('requires an explicit candidate choice before replacing a current-task memory', async () => {
  let actions: ReturnType<typeof useMemoryCommands>
  const Host = () => { actions = useMemoryCommands(vi.fn()); return actions.dialog }
  const box = document.body.appendChild(document.createElement('div')); const root = createRoot(box)
  try {
    await act(async () => root.render(<Host />))
    let result: Promise<string>
    await act(async () => { result = actions.run({ action: 'replace', text: '刚才那条', replacement: '默认用人民币' }, 'u', '/memory', '', 'task-1') })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('默认用美元')
    expect(dialog.textContent).toContain('默认用人民币')
    expect(dialog.textContent).not.toContain('另一个任务')
    expect(changeMemoryEntry).not.toHaveBeenCalled()
    expect(dialog.querySelector<HTMLButtonElement>('.primary')!.disabled).toBe(true)
    await act(async () => dialog.querySelector<HTMLInputElement>('input')!.click())
    await act(async () => dialog.querySelector<HTMLButtonElement>('.primary')!.click())
    expect(await result!).toContain('已更新记忆')
    expect(changeMemoryEntry).toHaveBeenCalledWith('u', '/memory', '', expect.objectContaining({ id: 'one' }), '默认用人民币')
    expect(emptyMemoryProfile.enabled).toBe(true)
  } finally { await act(async () => root.unmount()); box.remove(); vi.clearAllMocks() }
})
