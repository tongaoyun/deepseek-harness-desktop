import type { ExpertKitCatalogEntry, ExpertKitDownload, InstalledExpertKit } from './types'

interface SyncDependencies {
  download: (id: string) => Promise<ExpertKitDownload>
  install: (download: ExpertKitDownload) => Promise<InstalledExpertKit>
}

export interface ExpertKitSyncResult {
  installed: InstalledExpertKit[]
  issues: { key: string; label: string; message: string }[]
}

export async function synchronizePublishedExpertKits(
  catalog: ExpertKitCatalogEntry[],
  installed: InstalledExpertKit[],
  dependencies: SyncDependencies,
): Promise<ExpertKitSyncResult> {
  let current = installed
  const issues: ExpertKitSyncResult['issues'] = []

  for (const kit of catalog) {
    const local = current.find((item) => item.source === 'catalog'
      && item.manifest.kind === 'expert-kit'
      && item.manifest.id === kit.id)
    if (!local || (local.manifest.version === kit.version && local.packageSha256 === kit.sha256)) continue

    try {
      const download = await dependencies.download(kit.id)
      if (download.id !== kit.id || download.version !== kit.version || download.sha256 !== kit.sha256) {
        throw new Error('目录与下载制品不一致')
      }
      const latest = await dependencies.install(download)
      current = [latest, ...current.filter((item) => !(item.source === 'catalog'
        && item.manifest.kind === 'expert-kit'
        && item.manifest.id === kit.id))]
    } catch (error) {
      issues.push({
        key: `expert-kit-sync:${kit.id}`,
        label: kit.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { installed: current, issues }
}
