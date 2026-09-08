import { describe, expect, it } from 'vitest'
import { expertKitChanges, expertKitSkillPrompt } from './expertKitDetails'
import { splitComposerPrompt } from './composerInput'
import type { ExpertKitView } from './expertKits'

const update: ExpertKitView = {
  id: 'operations', name: '运营专家', version: '1.1.0', summary: '运营工作', category: 'ecommerce-retail', minimumDesktopVersion: '0.1.8',
  commandIds: ['review'], skillIds: ['review', 'listing'], connectorRefs: ['erp-mcp'], requiredTools: ['order_get'],
  knowledgeBaseRefs: ['organization:operations'],
  serverWorkflows: [], sha256: 'a'.repeat(64), installState: 'update', readiness: 'ready', connectorIssues: [],
  knowledgeIssues: [], installedVersion: '1.0.0', localOnly: false,
  installed: {
    installPath: '/expert-kits/operations/1.0.0',
    source: 'catalog',
    manifest: {
      schemaVersion: '2', kind: 'expert-kit', id: 'operations', name: '运营专家', version: '1.0.0', summary: '运营工作', category: 'ecommerce-retail',
      minimumDesktopVersion: '0.1.7', commands: [{ id: 'review', path: 'commands/review.md' }],
      skills: [{ id: 'review', path: 'skills/review/SKILL.md' }], connectorRefs: ['erp-mcp'],
      requiredTools: ['order_get'], knowledgeBaseRefs: [],
      serverWorkflows: [],
    },
  },
}

describe('expert kit details', () => {
  it('keeps skill shortcuts on the supported kit route with the selected skill in the draft', () => {
    const prompt = expertKitSkillPrompt('fullstack-dev-expert', { id: 'api-design', name: 'API接口设计' })
    expect(prompt).toBe('/kit:fullstack-dev-expert 请使用套件中的「API接口设计」（api-design）技能。\n\n')
    expect(splitComposerPrompt(prompt).token).toBe('/kit:fullstack-dev-expert')
    expect(splitComposerPrompt(prompt).text.trim()).toBe('请使用套件中的「API接口设计」（api-design）技能。')
  })
  it('summarizes capability changes', () => {
    expect(expertKitChanges(update)).toEqual([
      '新增技能：listing',
      '新增知识库：organization:operations',
    ])
  })
})
