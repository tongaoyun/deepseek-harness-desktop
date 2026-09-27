import { describe, expect, it } from 'vitest'
import {
  CapabilityResolutionError,
  assertKnowledgeBaseRefsAvailable,
  capabilitySnapshotChanged,
  capabilitySnapshotForExecution,
  reconcileConnectorSnapshot,
  resolveCapabilitySnapshot,
} from './capabilitySnapshot'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import type { CapabilitySelection, ConnectorRuntimeDefinition } from './types'

const connector = (id: string, tools: string[] = [], status: ConnectorRuntimeDefinition['status'] = 'ready'): ConnectorRuntimeDefinition => ({
  id, version: '1', status, name: id, transport: 'streamable-http', url: `http://${id}/mcp`, authMode: 'employee-bearer',
  toolNames: tools, enabled: true,
})
const kit = (id: string, options: { connectors?: string[]; tools?: string[]; knowledge?: string[]; version?: string; enabled?: boolean; implicit?: boolean } = {}) => ({
  id, version: options.version ?? '1.0.0', installState: 'installed', connectorRefs: options.connectors ?? [],
  requiredTools: options.tools ?? [], knowledgeBaseRefs: options.knowledge ?? [],
  installed: {
    enabled: options.enabled ?? true,
    manifest: { version: options.version ?? '1.0.0', allowImplicitInvocation: options.implicit ?? true },
    packageSha256: id.padEnd(64, 'a').slice(0, 64),
  },
}) as ExpertKitView
const skill = (id: string, version = '1.0.0') => ({
  ...kit(id, { version }), sourceKitId: '', triggers: [], installedVersion: version,
}) as unknown as SkillView
const selection = (kind: CapabilitySelection['kind'], id: string, version = '1.0.0'): CapabilitySelection => ({
  mode: 'explicit', kind, extensionId: id, extensionVersion: version,
  ...(kind === 'skill' ? { skillId: id } : {}),
})

describe('capability resolver', () => {
  it('compiles multiple kits and a standalone skill into one immutable task snapshot', () => {
    const snapshot = resolveCapabilitySnapshot({
      expertKits: [kit('operations', { connectors: ['erp'], tools: ['orders.search'], knowledge: ['team:sop'] }), kit('analytics')],
      skills: [skill('spreadsheets')],
      selections: [selection('expert-kit', 'operations'), selection('expert-kit', 'analytics'), selection('skill', 'spreadsheets')],
      connectors: [connector('erp', ['orders.search'])],
      availableKnowledgeBaseRefs: ['team:sop'],
      createdAt: '2026-09-11T00:00:00Z',
    })
    expect(snapshot.schemaVersion).toBe(2)
    expect(snapshot.selections.map((item) => `${item.kind}:${item.extensionId}`)).toEqual([
      'expert-kit:operations', 'expert-kit:analytics', 'skill:spreadsheets',
    ])
    expect(snapshot.artifacts).toHaveLength(3)
    expect(snapshot.connectors.map((item) => item.id)).toEqual(['erp'])
    expect(snapshot.knowledgeBaseRefs).toEqual(['team:sop'])
  })

  it('automatically includes declared dependencies but not unrelated enabled connectors', () => {
    const snapshot = resolveCapabilitySnapshot({
      expertKits: [kit('operations', { connectors: ['erp'] })], skills: [],
      selections: [selection('expert-kit', 'operations')],
      connectors: [connector('erp'), connector('crm')],
    })
    expect(snapshot.connectors.map((item) => item.id)).toEqual(['erp'])
  })

  it('records auto-discoverable skills separately without granting their dependencies', () => {
    const snapshot = resolveCapabilitySnapshot({
      expertKits: [kit('selected'), kit('discoverable', { connectors: ['private-erp'] }), kit('manual', { implicit: false })],
      skills: [], selections: [selection('expert-kit', 'selected')], connectors: [],
    })
    expect(snapshot.artifacts.map((item) => item.id)).toEqual(['selected'])
    expect(snapshot.implicitArtifacts.map((item) => item.id)).toEqual(['discoverable'])
    expect(snapshot.connectors).toEqual([])
  })

  it('blocks unresolved connector, tool and knowledge dependencies before starting Harness', () => {
    expect(() => resolveCapabilitySnapshot({
      expertKits: [kit('operations', { connectors: ['erp'], tools: ['orders.search'], knowledge: ['team:sop'] })],
      skills: [], selections: [selection('expert-kit', 'operations')], connectors: [connector('erp')],
      availableKnowledgeBaseRefs: [],
    })).toThrow(CapabilityResolutionError)
    try {
      resolveCapabilitySnapshot({
        expertKits: [kit('operations', { connectors: ['erp'], tools: ['orders.search'], knowledge: ['team:sop'] })],
        skills: [], selections: [selection('expert-kit', 'operations')], connectors: [connector('erp')],
        availableKnowledgeBaseRefs: [],
      })
    } catch (error) {
      expect((error as CapabilityResolutionError).issues).toEqual(expect.arrayContaining([
        expect.stringContaining('orders.search'), expect.stringContaining('team:sop'),
      ]))
    }
  })

  it('rejects stale explicit knowledge choices, including in a retained task snapshot', () => {
    const input = { expertKits: [], skills: [], selections: [], connectors: [], knowledgeBaseRefs: ['team:removed'] }
    expect(() => resolveCapabilitySnapshot({ ...input, availableKnowledgeBaseRefs: [] })).toThrow('team:removed')
    const retained = resolveCapabilitySnapshot({ ...input, availableKnowledgeBaseRefs: ['team:removed'] })
    expect(() => assertKnowledgeBaseRefsAvailable(retained, [])).toThrow('team:removed')
  })

  it('rejects duplicate coordinates and version drift', () => {
    expect(() => resolveCapabilitySnapshot({
      expertKits: [kit('operations')], skills: [],
      selections: [selection('expert-kit', 'operations'), selection('expert-kit', 'operations')], connectors: [],
    })).toThrow(/重复选择/u)
    expect(() => resolveCapabilitySnapshot({
      expertKits: [kit('operations', { version: '2.0.0' })], skills: [],
      selections: [selection('expert-kit', 'operations', '1.0.0')], connectors: [],
    })).toThrow(/版本已变化/u)
  })

  it('stores no credentials and hydrates only when creating the execution request', () => {
    const snapshot = resolveCapabilitySnapshot({
      expertKits: [], skills: [], selections: [], selectedConnectorIds: ['crm'],
      connectors: [{ ...connector('crm'), environment: { CRM_TOKEN: 'secret' }, headers: { Authorization: 'secret' } }],
    })
    expect(snapshot.connectors[0]).toMatchObject({ environment: { CRM_TOKEN: '' }, headers: { Authorization: '' } })
    const executable = capabilitySnapshotForExecution(snapshot, [], {
      crm: { environment: { CRM_TOKEN: 'local-env' }, headers: { Authorization: 'local-header' } },
    })
    expect(executable.connectors[0]).toMatchObject({ environment: { CRM_TOKEN: 'local-env' }, headers: { Authorization: 'local-header' } })
  })

  it('rebinds a retained task to the latest ready connector definition without copying secrets', () => {
    const first = resolveCapabilitySnapshot({
      expertKits: [], skills: [], selections: [], selectedConnectorIds: ['crm'],
      connectors: [{ ...connector('crm'), version: '1', url: 'https://old.example/mcp', toolNames: ['read'], environment: { TOKEN: 'old-secret' } }],
    })
    const next = reconcileConnectorSnapshot(first, [{
      ...connector('crm', ['read', 'search']), version: '2', url: 'https://new.example/mcp', environment: { TOKEN: 'new-secret' }, enabled: true,
    }], ['crm'])
    expect(next.connectors[0]).toMatchObject({ version: '2', url: 'https://new.example/mcp', toolNames: ['read', 'search'], environment: { TOKEN: '' } })
  })

  it('uses the current catalog read-only tools derived from MCP annotations', () => {
    const snapshot = resolveCapabilitySnapshot({
      expertKits: [], skills: [], selections: [], selectedConnectorIds: ['erp'],
      connectors: [{ ...connector('erp', ['sales.read', 'order.cancel']), readOnlyTools: ['sales.read'] }],
    })
    const executable = capabilitySnapshotForExecution(snapshot, [{
      ...connector('erp', ['sales.read', 'order.cancel']), readOnlyTools: ['sales.read'],
    }])
    expect(executable.connectors[0]?.readOnlyTools).toEqual(['sales.read'])
  })

  it.each([
    ['removed', [] as ConnectorRuntimeDefinition[], ['crm']],
    ['disabled', [{ ...connector('crm'), status: 'disabled' as const, enabled: true }], ['crm']],
    ['revoked locally', [{ ...connector('crm'), enabled: false }], []],
  ])('blocks a retained task when a connector is %s', (_reason, current, enabled) => {
    const snapshot = resolveCapabilitySnapshot({ expertKits: [], skills: [], selections: [], selectedConnectorIds: ['crm'], connectors: [connector('crm')] })
    expect(() => reconcileConnectorSnapshot(snapshot, current, enabled)).toThrow(CapabilityResolutionError)
  })

  it('ignores bookkeeping timestamps when deciding whether a session must restart', () => {
    const first = resolveCapabilitySnapshot({ expertKits: [], skills: [], selections: [], connectors: [], createdAt: 'first' })
    expect(capabilitySnapshotChanged(first, { ...first, createdAt: 'second' })).toBe(false)
    expect(capabilitySnapshotChanged(first, { ...first, selections: [selection('skill', 'new')] })).toBe(true)
  })
})
