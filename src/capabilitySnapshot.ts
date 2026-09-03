import type { AllowedExtensionArtifact, CapabilitySnapshot, ConnectorRuntimeDefinition } from './types'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import type { ConnectorSecretStore } from './connectorSecrets'

export function createCapabilitySnapshot(
  expertKits: ExpertKitView[],
  skills: SkillView[],
  connectors: ConnectorRuntimeDefinition[],
  knowledgeBaseRefs: string[] = [],
  createdAt = new Date().toISOString(),
): CapabilitySnapshot {
  const extensions: AllowedExtensionArtifact[] = [
    ...expertKits.filter((item) => ['installed', 'update'].includes(item.installState)
      && (item.installState === 'update' ? item.installed?.packageSha256 : item.sha256)).map((item) => ({
      kind: 'expert-kit' as const,
      id: item.id,
      version: item.installState === 'update' ? item.installed!.manifest.version : item.version,
      sha256: item.installState === 'update' ? item.installed!.packageSha256! : item.sha256,
    })),
    ...skills.filter((item) => ['installed', 'update'].includes(item.installState)
      && (item.installState === 'update' ? item.installed?.packageSha256 : item.sha256)).map((item) => ({
      kind: 'skill' as const,
      id: item.id,
      version: item.installState === 'update' ? item.installed!.manifest.version : item.version,
      sha256: item.installState === 'update' ? item.installed!.packageSha256! : item.sha256,
    })),
  ].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
  return {
    createdAt,
    extensions,
    connectors: connectors.filter((item) => item.status === 'ready' && item.enabled)
      .map((item) => ({
        ...item,
        toolNames: [...item.toolNames],
        environment: emptyValues(item.environment),
        headers: emptyValues(item.headers),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    knowledgeBaseRefs: [...new Set(knowledgeBaseRefs)].sort(),
  }
}

export function connectorsForSnapshot(
  snapshot: CapabilitySnapshot,
  localSecrets: ConnectorSecretStore = {},
): ConnectorRuntimeDefinition[] {
  return snapshot.connectors.map((item) => ({
    ...item,
    toolNames: [...item.toolNames],
    environment: hydrateValues(item.environment, localSecrets[item.id]?.environment),
    headers: hydrateValues(item.headers, localSecrets[item.id]?.headers),
  }))
}

function emptyValues(values?: Record<string, string>): Record<string, string> | undefined {
  if (values === undefined) return undefined
  return Object.fromEntries(Object.keys(values).map((key) => [key, '']))
}

function hydrateValues(template?: Record<string, string>, local?: Record<string, string>): Record<string, string> | undefined {
  if (template === undefined) return undefined
  return Object.fromEntries(Object.keys(template).map((key) => [key, local?.[key] ?? '']))
}
