import { describe, expect, it } from 'vitest'
import { installedExtensionSnapshot, mergeExpertKits } from './expertKits'
import type { ConnectorCatalogEntry, ExpertKitCatalogEntry, InstalledExpertKit, KnowledgeBaseEntry } from './types'

const installed: InstalledExpertKit = {
  installPath: '/app/expert-kits/store-kit/1.0.0',
  source: 'catalog',
  manifest: {
    schemaVersion: '2', kind: 'expert-kit', id: 'store-kit', name: '店铺专家', version: '1.0.0', summary: '店铺分析', category: 'ecommerce-retail',
    minimumDesktopVersion: '0.1.0', commands: [], skills: [{ id: 'diagnosis', path: 'skills/diagnosis/SKILL.md' }],
    connectorRefs: ['erp-mcp'],
    requiredTools: ['sales_summary'],
  },
}

const catalogEntry: ExpertKitCatalogEntry = {
  id: 'store-kit',
  name: '店铺专家',
  version: '1.0.0',
  summary: '店铺分析',
  category: 'ecommerce-retail',
  minimumDesktopVersion: '0.1.0',
  commandIds: [],
  skillIds: ['diagnosis'],
  connectorRefs: ['erp-mcp'],
  knowledgeBaseRefs: [],
  requiredTools: ['sales_summary'],
  sha256: 'a'.repeat(64),
}

const erpConnector: ConnectorCatalogEntry = {
  id: 'erp-mcp',
  name: 'ERP MCP',
  summary: 'ERP 查询能力',
  category: 'industry-data',
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
  it('treats an installed catalog kit as current while background sync replaces its content', () => {
    const matching = mergeExpertKits([catalogEntry], [installed], [erpConnector])
    expect(matching[0].installState).toBe('installed')
    expect(matching[0].readiness).toBe('ready')

    const update = mergeExpertKits([{ ...catalogEntry, version: '1.1.0', sha256: 'b'.repeat(64) }], [installed], [erpConnector])
    expect(update[0]).toMatchObject({ installState: 'installed', installed })
  })

  it('prefers the exact published version when the device retains a newer rollback candidate', () => {
    const newer = { ...installed, manifest: { ...installed.manifest, version: '1.1.0' } }

    expect(mergeExpertKits([catalogEntry], [newer, installed], [erpConnector])[0]).toMatchObject({
      installState: 'installed', installed,
    })
  })

  it('uses a same-id developer kit as the complete local source of truth', () => {
    const developer = {
      ...installed,
      source: 'developer' as const,
      packageSha256: 'd'.repeat(64),
      manifest: {
        ...installed.manifest,
        version: '9.0.0',
        name: '本地店铺专家',
        summary: '本地实现',
        commands: [{ id: 'local-check', path: 'commands/local.md' }],
        skills: [],
        connectorRefs: [],
        requiredTools: [],
      },
    }
    const [view] = mergeExpertKits([catalogEntry], [installed, developer])
    expect(view).toMatchObject({
      name: '本地店铺专家', version: '9.0.0', summary: '本地实现', commandIds: ['local-check'],
      skillIds: [], connectorRefs: [], requiredTools: [], localOnly: true,
    })
    expect(view.installed).toBe(developer)
  })

  it('keeps a compatible installed kit usable while its published update requires a newer desktop', () => {
    const future = { ...catalogEntry, version: '2.0.0', minimumDesktopVersion: '0.2.0' }
    expect(mergeExpertKits([future], [], [erpConnector])[0]).toMatchObject({ installState: 'incompatible' })
    expect(mergeExpertKits([future], [installed], [erpConnector])[0]).toMatchObject({
      installState: 'installed', installed, updateRequiresDesktopUpgrade: true,
    })
  })

  it('allows replacing an incompatible local kit with a compatible catalog version', () => {
    const incompatibleLocal = { ...installed, manifest: { ...installed.manifest, minimumDesktopVersion: '0.2.0' } }
    expect(mergeExpertKits([catalogEntry], [incompatibleLocal])[0]).toMatchObject({
      installState: 'available', installed: incompatibleLocal,
    })
  })

  it('selects the newest installed version when the published version is absent', () => {
    const newer = { ...installed, manifest: { ...installed.manifest, version: '1.2.0' } }
    expect(mergeExpertKits([{ ...catalogEntry, version: '1.1.0' }], [installed, newer])[0].installed).toBe(newer)
  })

  it('reports one active version per installed extension coordinate', () => {
    const older = { ...installed, manifest: { ...installed.manifest, version: '0.9.0' } }
    expect(installedExtensionSnapshot([installed, older, {
      ...installed,
      source: 'developer',
      manifest: { ...installed.manifest, kind: 'skill', id: 'code-review' },
    }], [{ kind: 'expert-kit', id: 'store-kit', version: '1.0.0' }])).toEqual([
      { kind: 'expert-kit', id: 'store-kit', version: '1.0.0', source: 'catalog' },
      { kind: 'skill', id: 'code-review', version: '1.0.0', source: 'developer' },
    ])
  })

  it('reports the catalog version that is active after a rollback', () => {
    const newer = { ...installed, manifest: { ...installed.manifest, version: '1.1.0' } }
    expect(installedExtensionSnapshot([newer, installed], [
      { kind: 'expert-kit', id: 'store-kit', version: '1.0.0' },
    ])).toEqual([
      { kind: 'expert-kit', id: 'store-kit', version: '1.0.0', source: 'catalog' },
    ])
  })

  it('keeps locally installed kits that are no longer in the catalog', () => {
    expect(mergeExpertKits([], [{ ...installed, source: 'developer' }], [erpConnector])[0]).toMatchObject({
      id: 'store-kit', installState: 'installed', localOnly: true,
    })
  })

  it('marks a catalog kit removed from the control plane as retired', () => {
    expect(mergeExpertKits([], [installed], [erpConnector])[0]).toMatchObject({
      id: 'store-kit', installState: 'retired', localOnly: false,
    })
  })

  it('never exposes the removed cross-border operations kit, including stale local installs', () => {
    const removedCatalog = { ...catalogEntry, id: 'crossborder-operations', name: '跨境电商运营专家' }
    const removedInstalled = { ...installed, manifest: { ...installed.manifest, id: 'crossborder-operations', name: '跨境电商运营专家' } }

    expect(mergeExpertKits([removedCatalog], [removedInstalled], [erpConnector])).toEqual([])
  })

  it('checks only MCP tools against referenced connectors and accepts official Harness tools', () => {
    const partial = mergeExpertKits([
      { ...catalogEntry, connectorRefs: ['erp-mcp'], requiredTools: ['sales_summary', 'load_workspace_dependencies', 'missing_erp_tool'] },
    ], [], [erpConnector])

    expect(partial[0].readiness).toBe('partial')
    expect(partial[0].connectorIssues).toEqual([
      'missing_erp_tool 无可用连接器',
    ])
  })

  it('does not require MCP connectors for built-in Shell and Computer Use tools', () => {
    const result = mergeExpertKits([{
      ...catalogEntry,
      connectorRefs: [],
      requiredTools: ['bash', 'computer_use_observe', 'computer_use_click'],
    }], [])
    expect(result[0]).toMatchObject({ readiness: 'ready', connectorIssues: [] })
  })

  it('reports knowledge bases that are missing or inaccessible', () => {
    const partial = mergeExpertKits([
      { ...catalogEntry, knowledgeBaseRefs: ['organization:operations', 'team:restricted'] },
    ], [], [erpConnector], [knowledgeBase])

    expect(partial[0].readiness).toBe('partial')
    expect(partial[0].knowledgeIssues).toEqual(['team:restricted 不存在或无访问权限'])
  })
})
