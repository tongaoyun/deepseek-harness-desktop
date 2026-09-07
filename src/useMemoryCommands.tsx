import { useMemoryChoice } from './MemoryChoiceDialog'
import { findMemoryCandidates, relatedMemories } from './memoryEditing'
import { changeMemoryEntry, loadSyncedMemoryProfile, memorySaveMessage, rememberInstruction, type parseMemoryCommand } from './memory'

export function useMemoryCommands(confirm: (options: { title: string; message: string; confirmLabel: string }) => Promise<boolean>) {
  const { choose, dialog } = useMemoryChoice()
  const run = async (command: NonNullable<ReturnType<typeof parseMemoryCommand>>, employeeId: string, endpoint: string, token: string, taskId: string) => {
    const profile = await loadSyncedMemoryProfile(employeeId, endpoint, token)
    const candidates = command.action === 'remember' ? relatedMemories(profile.entries ?? [], command.text)
      : findMemoryCandidates(profile, command.text, taskId)
    if (command.action !== 'remember' && !candidates.length) return '未找到对应记忆，没有更改内容。请描述具体规则，或到设置 → 记忆中选择条目。'
    let selected: string | undefined
    if (candidates.length) {
      selected = await choose(command.action === 'remember' ? '已有相似记忆，如何处理？' : command.action === 'forget' ? '选择要删除的记忆' : '选择要修改的记忆',
        command.action === 'forget' ? '确认后仅删除选中的这一条。' : `新内容：${command.replacement ?? command.text}`,
        [...candidates.map((entry) => ({ id: entry.id, label: `${command.action === 'forget' ? '删除' : '替换'}：${entry.text}` })), ...(command.action === 'remember' ? [{ id: '__new__', label: '保留原条目，作为独立记忆新增' }] : [])])
      if (!selected) return '未更改长期记忆。'
    } else if (!await confirm({ title: '保存为长期记忆？', message: command.text, confirmLabel: '保存' })) return '未更改长期记忆。'
    const target = candidates.find((entry) => entry.id === selected)
    const saved = target ? await changeMemoryEntry(employeeId, endpoint, token, target, command.action === 'forget' ? undefined : command.replacement ?? command.text)
      : await rememberInstruction(employeeId, endpoint, token, command.text, taskId)
    const content = command.action === 'forget' ? target!.text : command.replacement ?? command.text
    return `${command.action === 'forget' ? '已删除记忆' : target ? '已更新记忆' : '已记住'}：${content}\n\n${memorySaveMessage(saved)}${!saved.enabled ? ' 当前记忆已关闭，可在设置中启用。' : ''}`
  }
  return { run, dialog }
}
