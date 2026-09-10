import { desktopToolNames } from './expertKits'
import type {
  ConnectorCatalogEntry,
  InstalledExpertKit,
  KnowledgeBaseEntry,
  SkillCatalogEntry,
} from './types'

export type SkillInstallState = 'available' | 'installed' | 'retired'

export interface SkillView extends SkillCatalogEntry {
  installState: SkillInstallState
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
  for (const artifact of installed) {
    if (artifact.manifest.kind !== 'skill' || localById.has(artifact.manifest.id)) continue
    localById.set(artifact.manifest.id, artifact)
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
    for (const tool of requiredTools.filter((name) => !desktopToolNames.has(name))) {
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
    const connectorRefs = skill.connectorRefs ?? []
    const requiredTools = skill.requiredTools ?? []
    const knowledgeBaseRefs = skill.knowledgeBaseRefs ?? []
    const local = localById.get(skill.id)
    return {
      ...skill,
      triggers: skill.triggers ?? [],
      minimumDesktopVersion: skill.minimumDesktopVersion || '0.1.0',
      connectorRefs,
      requiredTools,
      knowledgeBaseRefs,
      ...dependencyState(connectorRefs, requiredTools, knowledgeBaseRefs),
      installed: local,
      installedVersion: local?.manifest.version,
      installState: local ? 'installed' : 'available',
      localOnly: false,
    }
  })
  const catalogIds = new Set(catalog.map((skill) => skill.id))
  for (const local of localById.values()) {
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
      installState: local.source === 'developer' ? 'installed' : 'retired',
      localOnly: local.source === 'developer',
      ...dependencyState(connectorRefs, requiredTools, knowledgeBaseRefs),
    })
  }
  return views
}
