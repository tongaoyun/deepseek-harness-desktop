import { expect, it } from 'vitest'
import { memoryContextForTask } from './memory-context.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const entries = [
  { kind: 'fact', text: '库存预警采用七天覆盖率', updatedAt: '2026-09-01' },
  { kind: 'fact', text: '营销推广每周一汇报', updatedAt: '2026-09-02' },
  { kind: 'preference', text: '使用中文回答', updatedAt: '2026-09-01' },
]
it('keeps work rules and selects related facts without injecting the whole archive', () => {
  const context = memoryContextForTask('分析库存风险', JSON.stringify({ enabled: true, collaborationStyle: '简洁', workManual: '交付前检查', entries }))
  expect(context).toContain('简洁')
  expect(context).toContain('交付前检查')
  expect(context).toContain('库存预警')
  expect(context).toContain('使用中文')
  expect(context).not.toContain('营销推广')
})
it('respects the master switch and caps entry count and total context', () => {
  expect(memoryContextForTask('库存', JSON.stringify({ enabled: false, entries }))).toBe('')
  const many = Array.from({ length: 100 }, () => ({ kind: 'preference', text: 'x'.repeat(800), updatedAt: '' }))
  expect(memoryContextForTask('test', JSON.stringify({ enabled: true, entries: many })).length).toBeLessThan(4200)
})
it('reads fresh memory each turn for long-lived desktop and IM processes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xiaoyin-memory-test-'))
  const file = join(directory, 'profile.json')
  try {
    const reference = JSON.stringify({ profilePath: file })
    expect(memoryContextForTask('库存', reference)).toBe('')
    writeFileSync(file, JSON.stringify({ enabled: true, entries }))
    expect(memoryContextForTask('库存', reference)).toContain('库存预警')
    writeFileSync(file, JSON.stringify({ enabled: false, entries }))
    expect(memoryContextForTask('库存', reference)).toBe('')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
