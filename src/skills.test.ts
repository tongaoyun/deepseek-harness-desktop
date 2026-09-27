import { describe, expect, it } from 'vitest'
import { mergeSkills } from './skills'
import type { InstalledExpertKit, SkillCatalogEntry } from './types'

const catalog: SkillCatalogEntry = {
  id: 'document-insight', name: '文档洞察', version: '1.1.0', summary: '分析文档', category: 'knowledge-research', sourceKitId: '',
  triggers: ['总结文档'], minimumDesktopVersion: '0.1.13', connectorRefs: [],
  requiredTools: ['load_workspace_dependencies'], knowledgeBaseRefs: [],
  sha256: 'a'.repeat(64),
}

const installed: InstalledExpertKit = {
  source: 'catalog', installPath: '/skills/document-insight/1.0.0',
  manifest: {
    schemaVersion: '1', kind: 'skill', id: 'document-insight', name: '文档洞察', version: '1.0.0',
    summary: '分析文档', category: 'knowledge-research', triggers: ['总结文档'], minimumDesktopVersion: '0.1.13', commands: [],
    skills: [{ id: 'document-insight', path: 'skills/document-insight/SKILL.md' }],
    requiredTools: ['load_workspace_dependencies'], connectorRefs: [], knowledgeBaseRefs: [],
  },
}

describe('standalone skill catalog', () => {
  it('keeps an installed skill installed while the published version is fetched in the background', () => {
    const [skill] = mergeSkills([catalog], [installed])
    expect(skill.installState).toBe('installed')
    expect(skill.installedVersion).toBe('1.0.0')
    expect(skill.readiness).toBe('ready')
  })

  it('does not treat an expert kit artifact as an installed standalone skill', () => {
    const expert = { ...installed, manifest: { ...installed.manifest, kind: 'expert-kit' as const } }
    expect(mergeSkills([catalog], [expert])[0].installState).toBe('available')
  })

  it('blocks an incompatible new skill but keeps a compatible installed version active', () => {
    const future = { ...catalog, version: '2.0.0', minimumDesktopVersion: '0.2.0' }
    expect(mergeSkills([future], [])[0].installState).toBe('incompatible')
    expect(mergeSkills([future], [installed])[0]).toMatchObject({
      installState: 'installed', installedVersion: '1.0.0', updateRequiresDesktopUpgrade: true,
    })
  })

  it('allows replacing an incompatible local skill with a compatible catalog version', () => {
    const incompatibleLocal = { ...installed, manifest: { ...installed.manifest, minimumDesktopVersion: '0.2.0' } }
    expect(mergeSkills([catalog], [incompatibleLocal])[0]).toMatchObject({
      installState: 'available', installed: incompatibleLocal,
    })
  })

  it('selects the newest installed skill version regardless of inventory order', () => {
    const newer = { ...installed, manifest: { ...installed.manifest, version: '1.2.0' } }
    expect(mergeSkills([catalog], [newer, installed])[0].installed).toBe(newer)
  })

  it('uses a same-id developer skill as the complete local source of truth', () => {
    const developer = {
      ...installed,
      source: 'developer' as const,
      packageSha256: 'd'.repeat(64),
      manifest: {
        ...installed.manifest,
        version: '9.0.0',
        name: '本地文档洞察',
        summary: '本地实现',
        triggers: ['分析表格'],
        requiredTools: [],
      },
    }
    const [view] = mergeSkills([catalog], [installed, developer])
    expect(view).toMatchObject({
      name: '本地文档洞察', version: '9.0.0', summary: '本地实现', triggers: ['分析表格'],
      requiredTools: [], localOnly: true,
    })
    expect(view.installed).toBe(developer)
  })

  it('keeps a removed catalog 技能 visible but marks it retired', () => {
    expect(mergeSkills([], [installed])[0]).toMatchObject({
      id: 'document-insight', installState: 'retired', installedVersion: '1.0.0',
    })
  })
})
