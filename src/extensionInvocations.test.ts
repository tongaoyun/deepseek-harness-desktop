import { describe, expect, it } from 'vitest'
import { extensionInvocations, selectedInvocations } from './extensionInvocations'
import { mergeExpertKits } from './expertKits'
import type { InstalledExpertKit } from './types'

const installed: InstalledExpertKit = {
  installPath: '/extensions/reports', source: 'developer',
  manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'reports', name: '分析专家', version: '1.0.0', summary: '生成分析报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [{ id: 'weekly', path: 'commands/weekly.md' }], skills: [{ id: 'report', path: 'skills/report/SKILL.md' }], connectorRefs: [], requiredTools: [] },
}

describe('extension invocations', () => {
  it('exposes installed kits and exact namespaced commands', () => {
    const options = extensionInvocations(mergeExpertKits([], [installed]), [])
    expect(options.map((item) => item.token)).toEqual(['/kit:reports', '/kit:reports:weekly'])
    expect(selectedInvocations('/kit:reports:weekly 本周数据', options)).toMatchObject([{ kind: 'expert-kit', id: 'reports' }])
    expect(selectedInvocations('解释 /kit:reports', options)).toEqual([])
    expect(selectedInvocations('/kit:reports:missing', options)).toEqual([])
  })
  it('never offers unavailable or retired kits, and uses installed commands during updates', () => {
    const kit = mergeExpertKits([], [installed])[0]!
    expect(extensionInvocations([{ ...kit, installState: 'retired' }, { ...kit, installState: 'available' }], [])).toEqual([])
    expect(extensionInvocations([{ ...kit, commandIds: ['not-installed'] }], []).map((item) => item.token)).not.toContain('/kit:reports:not-installed')
  })
  it('excludes disabled kits and their commands', () => {
    expect(extensionInvocations(mergeExpertKits([], [{ ...installed, enabled: false }]), [])).toEqual([])
  })
})
