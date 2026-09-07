import { describe, expect, it } from 'vitest'
import { capabilitySnapshotChanged, connectorsForSnapshot, createCapabilitySnapshot } from './capabilitySnapshot'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import type { ConnectorRuntimeDefinition } from './types'

const connector = (id: string, version = '1', status: ConnectorRuntimeDefinition['status'] = 'ready'): ConnectorRuntimeDefinition => ({
  id, version, status, name: id, transport: 'streamable-http', url: `http://${id}/mcp`, authMode: 'employee-bearer', toolNames: [],
  enabled: true,
})

describe('capability snapshot', () => {
  it('rebuilds sessions for configuration changes but not checkpoint timestamps', () => {
    const first = createCapabilitySnapshot([], [], [connector('erp')], [], 'first')
    expect(capabilitySnapshotChanged(first, { ...first, createdAt: 'second' })).toBe(false)
    expect(capabilitySnapshotChanged(first, createCapabilitySnapshot([], [], [connector('erp', '2')]))).toBe(true)
    expect(capabilitySnapshotChanged(first, createCapabilitySnapshot([], [], []))).toBe(true)
  })
  it('excludes disabled skills and expert kits from new tasks', () => {
    const common = { id: 'disabled', version: '1.0.0', sha256: 'a'.repeat(64), installState: 'installed', installed: { enabled: false } }
    expect(createCapabilitySnapshot([common as ExpertKitView], [common as SkillView], []).extensions).toEqual([])
  })
  it('freezes installed extensions and ready connector versions for a task', () => {
    const kit = { id: 'ops', version: '1.0.0', sha256: 'a'.repeat(64), installState: 'installed' } as ExpertKitView
    const skill = { id: 'document', version: '2.0.0', sha256: 'b'.repeat(64), installState: 'installed' } as SkillView
    const snapshot = createCapabilitySnapshot(
      [kit], [skill], [connector('erp'), connector('offline', '1', 'unavailable')],
      ['team:refund-sop'], '2026-09-02T00:00:00Z',
    )
    expect(snapshot.extensions.map((item) => `${item.kind}:${item.id}`)).toEqual(['expert-kit:ops', 'skill:document'])
    expect(snapshot.connectors).toEqual([connector('erp')])
    expect(snapshot.knowledgeBaseRefs).toEqual(['team:refund-sop'])
  })

  it('does not silently switch an existing task to a newer connector version', () => {
    const snapshot = createCapabilitySnapshot([], [], [connector('erp', '1')])
    expect(connectorsForSnapshot(snapshot)).toEqual([connector('erp', '1')])
  })

  it('revokes a connector from an old task snapshot when the employee disables it', () => {
    const snapshot = createCapabilitySnapshot([], [], [connector('erp-mcp')])
    expect(connectorsForSnapshot(snapshot, {}, [])).toEqual([])
    expect(connectorsForSnapshot(snapshot, {}, ['erp-mcp'])).toEqual([connector('erp-mcp')])
  })

  it('excludes connectors the employee has not enabled', () => {
    const disabled = { ...connector('erp'), enabled: false }
    expect(createCapabilitySnapshot([], [], [disabled]).connectors).toEqual([])
  })

  it('keeps the installed artifact executable until the employee chooses to update', () => {
    const kit = {
      id: 'ops', version: '2.0.0', sha256: 'b'.repeat(64), installState: 'update',
      installed: { manifest: { version: '1.0.0' }, packageSha256: 'a'.repeat(64) },
    } as ExpertKitView
    expect(createCapabilitySnapshot([kit], [], []).extensions).toEqual([{
      kind: 'expert-kit', id: 'ops', version: '1.0.0', sha256: 'a'.repeat(64),
    }])
  })

  it('stores only connector credential keys in task history and hydrates at execution time', () => {
    const configured = {
      ...connector('crm'),
      environment: { CRM_TOKEN: 'env-secret' },
      headers: { Authorization: 'header-secret' },
    }
    const snapshot = createCapabilitySnapshot([], [], [configured])
    expect(snapshot.connectors[0]).toMatchObject({
      environment: { CRM_TOKEN: '' }, headers: { Authorization: '' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('env-secret')
    expect(connectorsForSnapshot(snapshot, {
      crm: { environment: { CRM_TOKEN: 'local-env' }, headers: { Authorization: 'local-header' } },
    })[0]).toMatchObject({
      environment: { CRM_TOKEN: 'local-env' }, headers: { Authorization: 'local-header' },
    })
  })
})
