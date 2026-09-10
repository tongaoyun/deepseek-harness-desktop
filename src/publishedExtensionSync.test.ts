import { expect, it, vi } from 'vitest'
import { synchronizePublishedExtensions } from './publishedExtensionSync'
import type { ExpertKitCatalogEntry, ExpertKitDownload, InstalledExpertKit, SkillCatalogEntry } from './types'

const manifest = (kind: 'expert-kit' | 'skill', version: string) => ({
  schemaVersion: '2', kind, id: 'reports', name: '报告专家', version,
  summary: '生成报告', category: 'other' as const, minimumDesktopVersion: '0.1.30',
  commands: [], skills: [], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [],
})
const installed = (version: string, source: InstalledExpertKit['source'] = 'catalog', kind: 'expert-kit' | 'skill' = 'expert-kit'): InstalledExpertKit => ({
  source, enabled: true, installPath: `/extensions/reports/${version}`,
  packageSha256: version === '2.0.0' ? 'b'.repeat(64) : 'a'.repeat(64), manifest: manifest(kind, version),
})
const catalog: ExpertKitCatalogEntry = {
  id: 'reports', name: '报告专家', version: '2.0.0', summary: '生成报告', category: 'other',
  minimumDesktopVersion: '0.1.30', commandIds: [], skillIds: [], connectorRefs: [],
  requiredTools: [], knowledgeBaseRefs: [], sha256: 'b'.repeat(64),
}
const publishedSkill: SkillCatalogEntry = {
  id: 'reports', name: '报告技能', version: '2.0.0', summary: '生成报告', category: 'other',
  sourceKitId: '', triggers: [], minimumDesktopVersion: '0.1.30', connectorRefs: [],
  requiredTools: [], knowledgeBaseRefs: [], sha256: 'b'.repeat(64),
}

it('automatically replaces installed catalog content with the published version', async () => {
  const download = vi.fn(async (_kind: string, id: string): Promise<ExpertKitDownload> => ({
    id, version: '2.0.0', sha256: 'b'.repeat(64), url: 'https://download.test/reports', expiresAt: '',
  }))
  const install = vi.fn(async (kind: 'expert-kit' | 'skill') => installed('2.0.0', 'catalog', kind))
  const result = await synchronizePublishedExtensions(
    [catalog],
    [publishedSkill],
    { installed: [installed('1.0.0'), installed('1.0.0', 'catalog', 'skill')], issues: [] },
    { download, install },
  )

  expect(download.mock.calls).toEqual([['expert-kit', 'reports'], ['skill', 'reports']])
  expect(install).toHaveBeenCalledTimes(2)
  expect(result).toEqual([installed('2.0.0', 'catalog', 'skill'), installed('2.0.0')])
})

it('does not install unselected content or overwrite a developer copy', async () => {
  const download = vi.fn()
  const install = vi.fn()

  expect(await synchronizePublishedExtensions([catalog], [publishedSkill], { installed: [], issues: [] }, { download, install })).toEqual([])
  expect(await synchronizePublishedExtensions([catalog], [], { installed: [installed('1.0.0', 'developer')], issues: [] }, { download, install }))
    .toEqual([installed('1.0.0', 'developer')])
  expect(download).not.toHaveBeenCalled()
})

it('keeps the installed content when a refresh fails', async () => {
  const download = vi.fn(async (_kind: string, id: string): Promise<ExpertKitDownload> => ({
    id, version: '1.9.0', sha256: 'c'.repeat(64), url: 'https://download.test/reports', expiresAt: '',
  }))
  const install = vi.fn()
  const result = await synchronizePublishedExtensions([catalog], [], { installed: [installed('1.0.0')], issues: [] }, { download, install })

  expect(install).not.toHaveBeenCalled()
  expect(result).toEqual([installed('1.0.0')])
})

it('reinstalls catalog content that no longer loads on this machine', async () => {
  const download = vi.fn(async (_kind: string, id: string): Promise<ExpertKitDownload> => ({
    id, version: '2.0.0', sha256: 'b'.repeat(64), url: 'https://download.test/reports', expiresAt: '',
  }))
  const install = vi.fn(async () => installed('2.0.0'))
  const result = await synchronizePublishedExtensions([catalog], [], {
    installed: [],
    issues: [{ coordinate: 'expert-kit:reports@1.0.0', message: '专家套件清单无效' }],
  }, { download, install })

  expect(download).toHaveBeenCalledWith('expert-kit', 'reports')
  expect(result).toEqual([installed('2.0.0')])
})

it('does not install a kit an unrelated damaged extension happens to sit next to', async () => {
  const download = vi.fn()
  const install = vi.fn()
  const result = await synchronizePublishedExtensions([catalog], [], {
    installed: [],
    issues: [{ coordinate: 'skill:reports@1.0.0', message: '技能清单无效' }],
  }, { download, install })

  expect(download).not.toHaveBeenCalled()
  expect(result).toEqual([])
})
