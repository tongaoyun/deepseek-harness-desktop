import { describe, expect, it } from 'vitest'
import { applyMemoryContext } from './runtime.js'

describe('local cross-session memory', () => {
  it('adds employee guidance without replacing the current task', () => {
    expect(applyMemoryContext('分析库存', '先给结论')).toContain('先给结论')
    expect(applyMemoryContext('分析库存', '先给结论')).toContain('当前任务：\n分析库存')
    expect(applyMemoryContext('分析库存', '')).toBe('分析库存')
  })
})
