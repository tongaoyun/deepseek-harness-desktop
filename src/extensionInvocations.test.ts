import { describe, expect, it } from 'vitest'
import { extensionInvocations, selectedInvocations } from './extensionInvocations'
import { mergeExpertKits } from './expertKits'
import type { InstalledExpertKit } from './types'

const installed: InstalledExpertKit = {
  installPath: '/extensions/reports', source: 'developer',
  manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'reports', name: '分析专家', version: '1.0.0', summary: '生成分析报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [{ id: 'weekly', path: 'commands/weekly.md', skillId: 'report' }], skills: [{ id: 'report', path: 'skills/report/SKILL.md' }], connectorRefs: [], requiredTools: [] },
}

describe('extension invocations', () => {
  it('exposes installed kits, their commands and their bundled skills', () => {
    const options = extensionInvocations(mergeExpertKits([], [installed]), [])
    expect(options.map((item) => item.token)).toEqual(['/kit:reports', '/kit:reports:weekly', '/kit:reports:skill:report'])
    // A bundled skill reads like a standalone one instead of borrowing the kit's name, but it is
    // reachable only through its kit, so the top-level menus keep listing the kit alone.
    const bundled = options.find((item) => item.token === '/kit:reports:skill:report')!
    expect(bundled.name).toBe('report')
    expect(bundled.bundledSkill).toBe(true)
    expect(options.filter((item) => !item.bundledSkill).map((item) => item.token)).toEqual(['/kit:reports', '/kit:reports:weekly'])
    expect(selectedInvocations('/kit:reports:weekly 本周数据', options)).toMatchObject([{ kind: 'expert-kit', id: 'reports', selection: {
      mode: 'explicit', kind: 'expert-kit', extensionId: 'reports', extensionVersion: '1.0.0', commandId: 'weekly', skillId: 'report',
    } }])
    expect(bundled.selection).toEqual({ mode: 'explicit', kind: 'expert-kit', extensionId: 'reports', extensionVersion: '1.0.0', skillId: 'report' })
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
  it('uses distinct tokens for a command and bundled skill with the same id', () => {
    const collision = {
      ...installed,
      manifest: {
        ...installed.manifest,
        commands: [{ id: 'review', path: 'commands/review.md' }],
        skills: [{ id: 'review', path: 'skills/review/SKILL.md' }],
      },
    }
    expect(extensionInvocations(mergeExpertKits([], [collision]), []).map((item) => item.token)).toEqual([
      '/kit:reports', '/kit:reports:review', '/kit:reports:skill:review',
    ])
  })
})
