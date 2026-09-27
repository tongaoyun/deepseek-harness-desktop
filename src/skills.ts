import { isDesktopToolName } from './expertKits'
import type {
  ConnectorCatalogEntry,
  InstalledExpertKit,
  KnowledgeBaseEntry,
  SkillCatalogEntry,
} from './types'
import { compareDesktopVersions, isDesktopVersionCompatible } from './extensionVersion'

export type SkillInstallState = 'available' | 'installed' | 'retired' | 'incompatible'

export interface SkillView extends SkillCatalogEntry {
  installState: SkillInstallState
  updateRequiresDesktopUpgrade?: boolean
  installedVersion?: string
  installed?: InstalledExpertKit
  readiness: 'ready' | 'partial'
  connectorIssues: string[]
  knowledgeIssues: string[]
  localOnly?: boolean
}

export function mergeSkills(
  catalog: SkillCatalogEntry[],
  installed: InstalledExpertKit[],
  connectors: ConnectorCatalogEntry[] = [],
  knowledgeBases: KnowledgeBaseEntry[] = [],
  enabledConnectorIds?: Iterable<string>,
): SkillView[] {
  const localById = new Map<string, InstalledExpertKit>()
  const developerById = new Map<string, InstalledExpertKit>()
  for (const artifact of installed) {
    if (artifact.manifest.kind !== 'skill') continue
    const previous = localById.get(artifact.manifest.id)
    if (!previous || (compareDesktopVersions(artifact.manifest.version, previous.manifest.version) ?? -1) > 0) localById.set(artifact.manifest.id, artifact)
    if (artifact.source === 'developer') {
      const previousDeveloper = developerById.get(artifact.manifest.id)
      if (!previousDeveloper || (compareDesktopVersions(artifact.manifest.version, previousDeveloper.manifest.version) ?? -1) > 0) developerById.set(artifact.manifest.id, artifact)
    }
  }
  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeReferences = new Set(knowledgeBases.map((entry) => entry.reference))
  const enabled = enabledConnectorIds === undefined ? undefined : new Set(enabledConnectorIds)
  const dependencyState = (connectorRefs: string[], requiredTools: string[], knowledgeBaseRefs: string[]) => {
    const referenced = connectorRefs.flatMap((id) => connectorById.get(id) ? [connectorById.get(id)!] : [])
    const connectorIssues = connectorRefs.flatMap((id) => {
      const connector = connectorById.get(id)
      if (!connector) return [`${id} 未发布`]
      if (connector.status === 'ready' && enabled?.has(id) === false) return [`${connector.name} 当前员工未启用`]
      return connector.status === 'ready' ? [] : [`${connector.name} 未就绪`]
    })
    const tools = new Set(referenced.flatMap((connector) => connector.toolNames))
    for (const tool of requiredTools.filter((name) => !isDesktopToolName(name))) {
      if (!tools.has(tool)) connectorIssues.push(`${tool} 无可用连接器`)
    }
    const knowledgeIssues = knowledgeBaseRefs.filter((reference) => !knowledgeReferences.has(reference))
      .map((reference) => `${reference} 不存在或无访问权限`)
    return {
      readiness: connectorIssues.length || knowledgeIssues.length ? 'partial' as const : 'ready' as const,
      connectorIssues,
      knowledgeIssues,
    }
  }
  const views = catalog.map((skill): SkillView => {
    const local = developerById.get(skill.id) ?? localById.get(skill.id)
    const developer = local?.source === 'developer' ? local.manifest : undefined
    const metadata: SkillCatalogEntry = developer ? {
      ...skill,
      id: developer.id,
      name: developer.name,
      author: developer.author,
      version: developer.version,
      summary: developer.summary,
      category: developer.category,
      sourceKitId: '',
      triggers: developer.triggers ?? [],
      minimumDesktopVersion: developer.minimumDesktopVersion,
      connectorRefs: developer.connectorRefs,
      requiredTools: developer.requiredTools,
      knowledgeBaseRefs: developer.knowledgeBaseRefs ?? [],
      sha256: local?.packageSha256 ?? '',
    } : skill
    const catalogCompatible = isDesktopVersionCompatible(metadata.minimumDesktopVersion || '0.1.0')
    const localCompatible = local ? isDesktopVersionCompatible(local.manifest.minimumDesktopVersion) : false
    const connectorRefs = metadata.connectorRefs ?? []
    const requiredTools = metadata.requiredTools ?? []
    const knowledgeBaseRefs = metadata.knowledgeBaseRefs ?? []
    return {
      ...metadata,
      triggers: metadata.triggers ?? [],
      minimumDesktopVersion: metadata.minimumDesktopVersion || '0.1.0',
      connectorRefs,
      requiredTools,
      knowledgeBaseRefs,
      ...dependencyState(metadata.connectorRefs ?? [], metadata.requiredTools ?? [], metadata.knowledgeBaseRefs ?? []),
      installed: local,
      installedVersion: local?.manifest.version,
      updateRequiresDesktopUpgrade: !developer && !!local && localCompatible && !catalogCompatible,
      installState: local && localCompatible ? 'installed' : catalogCompatible ? 'available' : 'incompatible',
      localOnly: !!developer,
    }
  })
  const catalogIds = new Set(catalog.map((skill) => skill.id))
  const localViews = new Map(localById)
  for (const [id, local] of developerById) localViews.set(id, local)
  for (const local of localViews.values()) {
    if (catalogIds.has(local.manifest.id)) continue
    const manifest = local.manifest
    const connectorRefs = manifest.connectorRefs ?? []
    const requiredTools = manifest.requiredTools ?? []
    const knowledgeBaseRefs = manifest.knowledgeBaseRefs ?? []
    views.push({
      id: manifest.id,
      name: manifest.name,
      author: manifest.author,
      version: manifest.version,
      summary: manifest.summary,
      category: manifest.category,
      sourceKitId: '',
      triggers: manifest.triggers ?? [],
      minimumDesktopVersion: manifest.minimumDesktopVersion,
      connectorRefs,
      requiredTools,
      knowledgeBaseRefs,
      sha256: local.packageSha256 ?? '',
      installed: local,
      installedVersion: manifest.version,
      installState: local.source === 'developer'
        ? isDesktopVersionCompatible(local.manifest.minimumDesktopVersion) ? 'installed' : 'incompatible'
        : 'retired',
      localOnly: local.source === 'developer',
      ...dependencyState(connectorRefs, requiredTools, knowledgeBaseRefs),
    })
  }
  return views
}
