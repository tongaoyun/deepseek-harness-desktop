import { describe, expect, it } from 'vitest'
import { connectorsForSnapshot, createCapabilitySnapshot } from './capabilitySnapshot'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import type { ConnectorRuntimeDefinition } from './types'

const connector = (id: string, version = '1', status: ConnectorRuntimeDefinition['status'] = 'ready'): ConnectorRuntimeDefinition => ({
  id, version, status, name: id, transport: 'streamable-http', url: `http://${id}/mcp`, authMode: 'employee-bearer', toolNames: [],
  enabled: true,
})

describe('capability snapshot', () => {
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

  it('excludes connectors the employee has not enabled', () => {
    const disabled = { ...connector('erp'), enabled: false }
    expect(createCapabilitySnapshot([], [], [disabled]).connectors).toEqual([])
  })
})
