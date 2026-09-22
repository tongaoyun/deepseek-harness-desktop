import { describe, expect, it } from 'vitest'
import { extensionCommandLabel, extensionCommandSlashLabel, extensionInvocations, selectedInvocations } from './extensionInvocations'
import { mergeExpertKits } from './expertKits'
import type { InstalledExpertKit } from './types'

const installed: InstalledExpertKit = {
  installPath: '/extensions/reports', source: 'developer',
  manifest: { schemaVersion: '3', kind: 'expert-kit', id: 'reports', name: '分析专家', version: '1.0.0', summary: '生成分析报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [{ id: 'weekly', path: 'commands/weekly.md', skillId: 'report' }], skills: [{ id: 'report', path: 'skills/report/SKILL.md', requiredTools: [], connectorRefs: [], knowledgeBaseRefs: [] }], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [] },
}

describe('extension invocations', () => {
  it('keeps internal command ids out of the user-facing picker', () => {
    expect(extensionCommandLabel('order-intake-check')).toBe('订单排查')
    expect(extensionCommandLabel('unknown-command', 2)).toBe('快捷命令 3')
    expect(extensionCommandSlashLabel('order-intake-check')).toBe('订单排查')
    expect(extensionCommandSlashLabel('unknown-command', 2)).toBe('unknown-command')
  })

  it('exposes installed kits and their declared commands', () => {
    const options = extensionInvocations(mergeExpertKits([], [installed]), [])
    expect(options.map((item) => item.token)).toEqual(['/kit:reports', '/kit:reports:weekly'])
    expect(selectedInvocations('/kit:reports:weekly 本周数据', options)).toMatchObject([{ kind: 'expert-kit', id: 'reports', selection: {
      mode: 'explicit', kind: 'expert-kit', extensionId: 'reports', extensionVersion: '1.0.0', commandId: 'weekly', skillId: 'report',
    } }])
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
  it('uses the command token when a command and Skill share an id', () => {
    const collision = {
      ...installed,
      manifest: {
        ...installed.manifest,
        commands: [{ id: 'review', path: 'commands/review.md' }],
        skills: [{ id: 'review', path: 'skills/review/SKILL.md' }],
      },
    }
    expect(extensionInvocations(mergeExpertKits([], [collision]), []).map((item) => item.token)).toEqual(['/kit:reports', '/kit:reports:review'])
  })
})
