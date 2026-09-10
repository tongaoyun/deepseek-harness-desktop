import { describe, expect, it } from 'vitest'
import { expertKitSkillPrompt, extensionCustomizationPrompt } from './expertKitDetails'
import { splitComposerPrompt } from './composerInput'

describe('expert kit details', () => {
  it('customizes the whole kit copy and keeps its resource context', () => {
    const prompt = extensionCustomizationPrompt('全栈开发专家', '/work/fullstack-custom', 'expert-kit')
    expect(prompt).toContain('请帮我定制「全栈开发专家」')
    expect(prompt).toContain('副本目录：/work/fullstack-custom')
    expect(prompt).toContain('保留其他技能和辅助资源')
    expect(prompt).toContain('专家套件页面')
    expect(extensionCustomizationPrompt('文档洞察', '/work/skill', 'skill')).toContain('技能页面')
  })
  it('addresses a bundled skill by token so the draft carries no instruction text', () => {
    const prompt = expertKitSkillPrompt('fullstack-dev-expert', { id: 'api-design' })
    expect(prompt).toBe('/kit:fullstack-dev-expert:skill:api-design ')
    expect(splitComposerPrompt(prompt).tokens).toEqual(['/kit:fullstack-dev-expert:skill:api-design'])
    expect(splitComposerPrompt(prompt).text).toBe('')
  })
})
