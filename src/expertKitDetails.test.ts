import { describe, expect, it } from 'vitest'
import { extensionCustomizationPrompt } from './expertKitDetails'

describe('expert kit details', () => {
  it('customizes the whole kit copy and keeps its resource context', () => {
    const prompt = extensionCustomizationPrompt('全栈开发专家', '/work/fullstack-custom', 'expert-kit')
    expect(prompt).toContain('请帮我定制「全栈开发专家」')
    expect(prompt).toContain('副本目录：/work/fullstack-custom')
    expect(prompt).toContain('保留其他技能和辅助资源')
    expect(prompt).toContain('专家套件页面')
    expect(extensionCustomizationPrompt('文档洞察', '/work/skill', 'skill')).toContain('技能页面')
  })
})
