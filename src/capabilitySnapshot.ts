import type { AllowedExtensionArtifact, CapabilitySnapshot, ConnectorRuntimeDefinition } from './types'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'

export function createCapabilitySnapshot(
  expertKits: ExpertKitView[],
  skills: SkillView[],
  connectors: ConnectorRuntimeDefinition[],
  knowledgeBaseRefs: string[] = [],
  createdAt = new Date().toISOString(),
): CapabilitySnapshot {
  const extensions: AllowedExtensionArtifact[] = [
    ...expertKits.filter((item) => item.installState === 'installed' && item.sha256).map((item) => ({
      kind: 'expert-kit' as const, id: item.id, version: item.version, sha256: item.sha256,
    })),
    ...skills.filter((item) => item.installState === 'installed' && item.sha256).map((item) => ({
      kind: 'skill' as const, id: item.id, version: item.version, sha256: item.sha256,
    })),
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
  return {
    createdAt,
    extensions,
    connectors: connectors.filter((item) => item.status === 'ready' && item.enabled)
      .map((item) => ({ ...item, toolNames: [...item.toolNames] }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    knowledgeBaseRefs: [...new Set(knowledgeBaseRefs)].sort(),
  }
}

export function connectorsForSnapshot(
  snapshot: CapabilitySnapshot,
): ConnectorRuntimeDefinition[] {
  return snapshot.connectors.map((item) => ({ ...item, toolNames: [...item.toolNames] }))
}
