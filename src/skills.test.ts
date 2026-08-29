import { describe, expect, it } from 'vitest'
import { mergeSkills } from './skills'
import type { InstalledExpertKit, SkillCatalogEntry } from './types'

const catalog: SkillCatalogEntry = {
  id: 'document-insight', name: '文档洞察', version: '1.1.0', summary: '分析文档', sourceKitId: '',
  triggers: ['总结文档'], minimumDesktopVersion: '0.1.13', connectorRefs: [],
  requiredTools: ['office.document.read'], knowledgeBaseRefs: [],
  permissions: { localFiles: 'approval', shell: 'deny', computerUse: 'deny', connectorRead: 'deny', connectorWrite: 'deny' },
  sha256: 'a'.repeat(64),
}

const installed: InstalledExpertKit = {
  source: 'catalog', installPath: '/skills/document-insight/1.0.0',
  manifest: {
    schemaVersion: '1', kind: 'skill', id: 'document-insight', name: '文档洞察', version: '1.0.0',
    summary: '分析文档', triggers: ['总结文档'], minimumDesktopVersion: '0.1.13', commands: [],
    skills: [{ id: 'document-insight', path: 'skills/document-insight/SKILL.md' }],
    requiredTools: ['office.document.read'], connectorRefs: [], knowledgeBaseRefs: [],
    permissions: { localFiles: 'approval', shell: 'deny', computerUse: 'deny', connectorRead: 'deny', connectorWrite: 'deny' },
    serverWorkflows: [],
  },
}

describe('standalone skill catalog', () => {
  it('detects an installed older version as update without requiring a connector for desktop tools', () => {
    const [skill] = mergeSkills([catalog], [installed])
    expect(skill.installState).toBe('update')
    expect(skill.installedVersion).toBe('1.0.0')
    expect(skill.readiness).toBe('ready')
  })

  it('does not treat an expert kit artifact as an installed standalone skill', () => {
    const expert = { ...installed, manifest: { ...installed.manifest, kind: 'expert-kit' as const } }
    expect(mergeSkills([catalog], [expert])[0].installState).toBe('available')
  })

  it('keeps a removed catalog Skill visible but marks it retired', () => {
    expect(mergeSkills([], [installed])[0]).toMatchObject({
      id: 'document-insight', installState: 'retired', installedVersion: '1.0.0',
    })
  })
})
