import { describe, expect, it } from 'vitest'
import { mergeExpertKits } from './expertKits'
import type { ConnectorCatalogEntry, ExpertKitCatalogEntry, InstalledExpertKit, KnowledgeBaseEntry } from './types'

const installed: InstalledExpertKit = {
  installPath: '/app/expert-kits/store-kit/1.0.0',
  manifest: {
    schemaVersion: '1', id: 'store-kit', name: '店铺专家', version: '1.0.0', summary: '店铺分析',
    minimumDesktopVersion: '0.1.0', commands: [], skills: [{ id: 'diagnosis', path: 'skills/diagnosis/SKILL.md' }],
    connectorRefs: ['erp-mcp'],
    requiredTools: ['sales_summary'],
    permissions: { localFiles: 'approval', shell: 'deny', erpRead: 'allow', erpWrite: 'approval' },
    serverWorkflows: [],
  },
}

const catalogEntry: ExpertKitCatalogEntry = {
  id: 'store-kit',
  name: '店铺专家',
  version: '1.0.0',
  summary: '店铺分析',
  minimumDesktopVersion: '0.1.0',
  commandIds: [],
  skillIds: ['diagnosis'],
  connectorRefs: ['erp-mcp'],
  knowledgeBaseRefs: [],
  requiredTools: ['sales_summary'],
  permissions: { localFiles: 'approval', shell: 'deny', connectorRead: 'allow', connectorWrite: 'approval' },
  serverWorkflows: [],
  sha256: 'a'.repeat(64),
}

const erpConnector: ConnectorCatalogEntry = {
  id: 'erp-mcp',
  name: 'ERP MCP',
  summary: 'ERP 查询能力',
  kind: 'managed-mcp',
  scope: 'organization',
  status: 'ready',
  managed: true,
  toolNames: ['sales_summary'],
}

const knowledgeBase: KnowledgeBaseEntry = {
  id: 'kb-1', referenceKey: 'operations', reference: 'organization:operations', scope: 'ORGANIZATION',
  name: '运营手册', description: '公司运营知识', createdAt: '2026-08-29T00:00:00Z', updatedAt: '2026-08-29T00:00:00Z',
}

describe('mergeExpertKits', () => {
  it('marks matching and newer catalog versions correctly', () => {
    const matching = mergeExpertKits([catalogEntry], [installed], [erpConnector])
    expect(matching[0].installState).toBe('installed')
    expect(matching[0].readiness).toBe('ready')

    const update = mergeExpertKits([{ ...catalogEntry, version: '1.1.0', sha256: 'b'.repeat(64) }], [installed], [erpConnector])
    expect(update[0]).toMatchObject({ installState: 'update', installedVersion: '1.0.0' })
  })

  it('keeps locally installed kits that are no longer in the catalog', () => {
    expect(mergeExpertKits([], [installed], [erpConnector])[0]).toMatchObject({ id: 'store-kit', installState: 'installed' })
  })

  it('reports unavailable connectors and tools missing from referenced connectors', () => {
    const partial = mergeExpertKits([
      { ...catalogEntry, connectorRefs: ['erp-mcp', 'desktop-office'], requiredTools: ['sales_summary', 'office.xlsx.create'] },
    ], [], [erpConnector, {
      id: 'desktop-office',
      name: '本地 Office',
      summary: '桌面 Office 能力',
      kind: 'desktop-builtin',
      scope: 'device',
      status: 'unavailable',
      managed: true,
      toolNames: [],
    }])

    expect(partial[0].readiness).toBe('partial')
    expect(partial[0].connectorIssues).toEqual([
      '本地 Office：当前不可用',
      'office.xlsx.create 无可用连接器',
    ])
  })

  it('reports knowledge bases that are missing or inaccessible', () => {
    const partial = mergeExpertKits([
      { ...catalogEntry, knowledgeBaseRefs: ['organization:operations', 'team:restricted'] },
    ], [], [erpConnector], [knowledgeBase])

    expect(partial[0].readiness).toBe('partial')
    expect(partial[0].knowledgeIssues).toEqual(['team:restricted 不存在或无访问权限'])
  })
})
