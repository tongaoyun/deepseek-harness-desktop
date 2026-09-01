import { describe, expect, it } from 'vitest'
import { memoryInstruction } from './memory'

describe('memoryInstruction', () => {
  it('extracts only explicit remember commands', () => {
    expect(memoryInstruction('记住：库存风险按 7 天覆盖率判断')).toBe('库存风险按 7 天覆盖率判断')
    expect(memoryInstruction('记住: 先给结论')).toBe('先给结论')
    expect(memoryInstruction('帮我分析库存风险')).toBe('')
  })
})
