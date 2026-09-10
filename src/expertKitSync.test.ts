import { expect, it, vi } from 'vitest'
import { synchronizePublishedExpertKits } from './expertKitSync'
import type { ExpertKitCatalogEntry, ExpertKitDownload, InstalledExpertKit } from './types'

const manifest = (version: string) => ({
  schemaVersion: '2', kind: 'expert-kit' as const, id: 'reports', name: '报告专家', version,
  summary: '生成报告', category: 'other' as const, minimumDesktopVersion: '0.1.30',
  commands: [], skills: [], connectorRefs: [], requiredTools: [], knowledgeBaseRefs: [],
})
const installed = (version: string, source: InstalledExpertKit['source'] = 'catalog'): InstalledExpertKit => ({
  source, enabled: true, installPath: `/extensions/reports/${version}`,
  packageSha256: version === '2.0.0' ? 'b'.repeat(64) : 'a'.repeat(64), manifest: manifest(version),
})
const catalog: ExpertKitCatalogEntry = {
  id: 'reports', name: '报告专家', version: '2.0.0', summary: '生成报告', category: 'other',
  minimumDesktopVersion: '0.1.30', commandIds: [], skillIds: [], connectorRefs: [],
  requiredTools: [], knowledgeBaseRefs: [], sha256: 'b'.repeat(64),
}

it('automatically replaces an installed catalog kit with the published content', async () => {
  const download = vi.fn(async (): Promise<ExpertKitDownload> => ({
    id: 'reports', version: '2.0.0', sha256: 'b'.repeat(64), url: 'https://download.test/reports', expiresAt: '',
  }))
  const install = vi.fn(async () => installed('2.0.0'))
  const result = await synchronizePublishedExpertKits([catalog], [installed('1.0.0')], { download, install })

  expect(download).toHaveBeenCalledWith('reports')
  expect(install).toHaveBeenCalledOnce()
  expect(result.issues).toEqual([])
  expect(result.installed).toEqual([installed('2.0.0')])
})

it('does not install an unselected market kit or overwrite a developer copy', async () => {
  const download = vi.fn()
  const install = vi.fn()

  expect((await synchronizePublishedExpertKits([catalog], [], { download, install })).installed).toEqual([])
  expect((await synchronizePublishedExpertKits([catalog], [installed('1.0.0', 'developer')], { download, install })).installed)
    .toEqual([installed('1.0.0', 'developer')])
  expect(download).not.toHaveBeenCalled()
})
