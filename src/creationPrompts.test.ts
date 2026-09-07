import { describe, expect, it } from 'vitest'
import { creationPrompt } from './creationPrompts'

describe('creationPrompt', () => {
  it('provides focused chat starters for each AI creation entry', () => {
    expect(creationPrompt('schedule')).toBe('我要创建一个定时任务，每【时间间隔】执行【具体任务】')
    expect(creationPrompt('skill')).toContain('创建一个技能')
    expect(creationPrompt('expert-kit')).toContain('岗位或团队')
    expect(creationPrompt('expert-kit')).toContain('输出标准')
  })
})
