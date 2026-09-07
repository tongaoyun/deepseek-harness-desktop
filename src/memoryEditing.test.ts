import { expect, it } from 'vitest'
import { findMemoryCandidates, normalizeMemory, relatedMemories } from './memoryEditing'
import { emptyMemoryProfile, parseMemoryCommand, upsertMemoryEntry } from './memory'

it('detects currency/language alternatives without treating arbitrary facts as contradictions', () => {
  const profile = upsertMemoryEntry(emptyMemoryProfile, '金额默认用美元', '用户', 'a')
  expect(relatedMemories(profile.entries!, '以后统一使用人民币')).toHaveLength(1)
  expect(relatedMemories(profile.entries!, '收入用美元，支出用人民币')).toHaveLength(0)
  expect(relatedMemories(profile.entries!, '库存按七天计算')).toHaveLength(0)
  expect(normalizeMemory('以后请用中文。')).toBe(normalizeMemory('用中文'))
})
it('limits pronoun candidates to the current task and matches partial queries', () => {
  const profile = upsertMemoryEntry(upsertMemoryEntry(emptyMemoryProfile, '金额默认用美元', '用户', 'a'), '使用中文回答', '用户', 'b')
  expect(findMemoryCandidates(profile, '刚才那条', 'a').map((entry) => entry.taskId)).toEqual(['a'])
  expect(findMemoryCandidates(profile, '刚才那条', 'missing')).toEqual([])
  expect(findMemoryCandidates(profile, '美元', 'a')).toHaveLength(1)
  expect(parseMemoryCommand('把刚才那条改成人民币')).toEqual({ action: 'replace', text: '刚才那条', replacement: '人民币' })
  expect(parseMemoryCommand('把报告改成表格')).toBeUndefined()
})
