import type { ExpertKitCatalogEntry, ExpertKitDownload, InstalledExpertKit, InstalledExtensionIssue, SkillCatalogEntry } from './types'

export type PublishedExtensionKind = 'expert-kit' | 'skill'

type PublishedEntry = Pick<ExpertKitCatalogEntry | SkillCatalogEntry, 'id' | 'version' | 'sha256'>

interface SyncDependencies {
  download: (kind: PublishedExtensionKind, id: string) => Promise<ExpertKitDownload>
  install: (kind: PublishedExtensionKind, download: ExpertKitDownload) => Promise<InstalledExpertKit>
  onFailure?: (kind: PublishedExtensionKind, id: string, error: unknown) => void
}

export async function synchronizePublishedExtensions(
  kits: ExpertKitCatalogEntry[],
  skills: SkillCatalogEntry[],
  inventory: { installed: InstalledExpertKit[]; issues: InstalledExtensionIssue[] },
  dependencies: SyncDependencies,
): Promise<InstalledExpertKit[]> {
  let current = inventory.installed
  const broken = brokenCoordinates(inventory.issues)
  const published: [PublishedExtensionKind, PublishedEntry[]][] = [['expert-kit', kits], ['skill', skills]]

  for (const [kind, entries] of published) {
    for (const entry of entries) {
      const matches = (item: InstalledExpertKit) => item.source === 'catalog'
        && item.manifest.kind === kind
        && item.manifest.id === entry.id
      const local = current.find(matches)
      // Content that fails to load is still content the employee chose, so reinstall it from the catalog.
      const damaged = !local && broken.has(`${kind}:${entry.id}`)
      // Otherwise only refresh what is already installed; a developer copy is never replaced.
      if (!damaged && (!local || (local.manifest.version === entry.version && local.packageSha256 === entry.sha256))) continue

      try {
        const download = await dependencies.download(kind, entry.id)
        if (download.id !== entry.id || download.version !== entry.version || download.sha256 !== entry.sha256) {
          throw new Error('目录与下载制品不一致')
        }
        const latest = await dependencies.install(kind, download)
        current = [latest, ...current.filter((item) => !matches(item))]
      } catch (error) {
        // One entry the desktop cannot refresh must not hold back the rest; the next cycle retries it.
        dependencies.onFailure?.(kind, entry.id, error)
      }
    }
  }

  return current
}

function brokenCoordinates(issues: InstalledExtensionIssue[]): Set<string> {
  return new Set(issues.flatMap((issue) => {
    const [kind, remainder] = splitOnce(issue.coordinate, ':')
    if (kind !== 'expert-kit' && kind !== 'skill') return []
    const id = remainder.includes('@') ? remainder.slice(0, remainder.lastIndexOf('@')) : remainder
    return id ? [`${kind}:${id}`] : []
  }))
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator)
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + separator.length)]
}
