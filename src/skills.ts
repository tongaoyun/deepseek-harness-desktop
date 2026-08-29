import { desktopToolNames, normalizePermissions } from './expertKits'
import type {
  ConnectorCatalogEntry,
  InstalledExpertKit,
  KnowledgeBaseEntry,
  PermissionMode,
  SkillCatalogEntry,
} from './types'

export type SkillInstallState = 'available' | 'installed' | 'update'

export interface SkillView extends SkillCatalogEntry {
  installState: SkillInstallState
  installedVersion?: string
  installed?: InstalledExpertKit
  readiness: 'ready' | 'partial'
  connectorIssues: string[]
  knowledgeIssues: string[]
}

export function mergeSkills(
  catalog: SkillCatalogEntry[],
  installed: InstalledExpertKit[],
  connectors: ConnectorCatalogEntry[] = [],
  knowledgeBases: KnowledgeBaseEntry[] = [],
): SkillView[] {
  const localById = new Map<string, InstalledExpertKit>()
  for (const artifact of installed) {
    if (artifact.manifest.kind !== 'skill' || localById.has(artifact.manifest.id)) continue
    localById.set(artifact.manifest.id, artifact)
  }
  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeReferences = new Set(knowledgeBases.map((entry) => entry.reference))
  return catalog.map((skill) => {
    const connectorRefs = skill.connectorRefs ?? []
    const requiredTools = skill.requiredTools ?? []
    const knowledgeBaseRefs = skill.knowledgeBaseRefs ?? []
    const referenced = connectorRefs.flatMap((id) => connectorById.get(id) ? [connectorById.get(id)!] : [])
    const connectorIssues = connectorRefs.flatMap((id) => {
      const connector = connectorById.get(id)
      if (!connector) return [`${id} 未发布`]
      return connector.status === 'ready' ? [] : [`${connector.name} 未就绪`]
    })
    const tools = new Set(referenced.flatMap((connector) => connector.toolNames))
    for (const tool of requiredTools.filter((name) => !desktopToolNames.has(name))) {
      if (!tools.has(tool)) connectorIssues.push(`${tool} 无可用连接器`)
    }
    const knowledgeIssues = knowledgeBaseRefs.filter((reference) => !knowledgeReferences.has(reference))
      .map((reference) => `${reference} 不存在或无访问权限`)
    const local = localById.get(skill.id)
    return {
      ...skill,
      triggers: skill.triggers ?? [],
      minimumDesktopVersion: skill.minimumDesktopVersion || '0.1.0',
      connectorRefs,
      requiredTools,
      knowledgeBaseRefs,
      permissions: normalizePermissions(skill.permissions),
      readiness: connectorIssues.length || knowledgeIssues.length ? 'partial' : 'ready',
      connectorIssues,
      knowledgeIssues,
      installed: local,
      installedVersion: local?.manifest.version,
      installState: local?.manifest.version === skill.version ? 'installed' : local ? 'update' : 'available',
    }
  })
}

export function skillPermissionExpansion(skill: SkillView): boolean {
  if (skill.installState !== 'update' || !skill.installed) return false
  const rank: Record<PermissionMode, number> = { deny: 0, approval: 1, allow: 2 }
  const before = normalizePermissions(skill.installed.manifest.permissions)
  const after = normalizePermissions(skill.permissions)
  return (Object.keys(after) as Array<keyof typeof after>).some((key) => rank[after[key]] > rank[before[key]])
}
