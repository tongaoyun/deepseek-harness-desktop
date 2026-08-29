import { describe, expect, it } from 'vitest'
import { buildInvocationOptions, filterInvocationOptions } from './invocations'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'

const kit = {
  id: 'ops', name: '运营专家', version: '1.0.0', summary: '运营', minimumDesktopVersion: '0.1.0',
  commandIds: ['daily-report'], skillIds: ['inventory'], connectorRefs: [], knowledgeBaseRefs: [], requiredTools: [],
  permissions: { localFiles: 'deny', shell: 'deny', computerUse: 'deny', connectorRead: 'deny', connectorWrite: 'deny' },
  serverWorkflows: [], sha256: 'x', installState: 'installed', readiness: 'ready', connectorIssues: [], knowledgeIssues: [], localOnly: false,
} as ExpertKitView

describe('slash invocation options', () => {
  it('includes installed kit commands and skills and filters by id', () => {
    const options = buildInvocationOptions([kit], [])
    expect(options.map((item) => item.label)).toEqual(['/daily-report', '/inventory'])
    expect(filterInvocationOptions(options, '/inv')).toHaveLength(1)
    expect(filterInvocationOptions(options, '/inventory ')).toEqual([])
  })

  it('exposes an installed standalone Skill without selecting an expert kit', () => {
    const standalone = {
      id: 'document-insight', name: '文档洞察', version: '1.0.0', summary: '总结文档', sourceKitId: '',
      triggers: ['总结文档'], minimumDesktopVersion: '0.1.13', connectorRefs: [], requiredTools: [],
      knowledgeBaseRefs: [], permissions: { localFiles: 'approval', shell: 'deny', computerUse: 'deny', connectorRead: 'deny', connectorWrite: 'deny' },
      sha256: 'a'.repeat(64), installState: 'installed', readiness: 'ready', connectorIssues: [], knowledgeIssues: [],
    } as SkillView
    const options = buildInvocationOptions([], [standalone])
    expect(options[0]).toMatchObject({ profileKind: 'skill', profileId: 'document-insight', label: '/document-insight' })
  })
})
