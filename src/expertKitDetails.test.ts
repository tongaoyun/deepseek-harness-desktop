import { describe, expect, it } from 'vitest'
import { expertKitChanges, expertKitHasPermissionExpansion, permissionModeLabel } from './expertKitDetails'
import type { ExpertKitView } from './expertKits'

const update: ExpertKitView = {
  id: 'operations', name: '运营专家', version: '1.1.0', summary: '运营工作', minimumDesktopVersion: '0.1.8',
  commandIds: ['review'], skillIds: ['review', 'listing'], connectorRefs: ['erp-mcp'], requiredTools: ['order_get'],
  knowledgeBaseRefs: ['organization:operations'],
  permissions: { localFiles: 'approval', shell: 'deny', computerUse: 'approval', connectorRead: 'allow', connectorWrite: 'approval' },
  serverWorkflows: [], sha256: 'a'.repeat(64), installState: 'update', readiness: 'ready', connectorIssues: [],
  knowledgeIssues: [], installedVersion: '1.0.0',
  installed: {
    installPath: '/expert-kits/operations/1.0.0',
    manifest: {
      schemaVersion: '1', id: 'operations', name: '运营专家', version: '1.0.0', summary: '运营工作',
      minimumDesktopVersion: '0.1.7', commands: [{ id: 'review', path: 'commands/review.md' }],
      skills: [{ id: 'review', path: 'skills/review/SKILL.md' }], connectorRefs: ['erp-mcp'],
      requiredTools: ['order_get'], knowledgeBaseRefs: [],
      permissions: { localFiles: 'deny', shell: 'deny', computerUse: 'deny', connectorRead: 'allow', connectorWrite: 'deny' },
      serverWorkflows: [],
    },
  },
}

describe('expert kit details', () => {
  it('summarizes capability and permission changes', () => {
    expect(expertKitChanges(update)).toEqual([
      '新增技能：listing',
      '新增知识库：organization:operations',
      '本地文件与 Office：不允许 → 每次确认',
      '屏幕与键鼠控制：不允许 → 每次确认',
      '企业数据写入：不允许 → 每次确认',
    ])
    expect(expertKitHasPermissionExpansion(update)).toBe(true)
  })

  it('uses explicit permission labels', () => {
    expect(permissionModeLabel('deny')).toBe('不允许')
    expect(permissionModeLabel('allow')).toBe('直接允许')
    expect(permissionModeLabel('approval')).toBe('每次确认')
  })
})
