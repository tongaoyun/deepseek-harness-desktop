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
    ...expertKits.filter((item) => item.installed?.enabled !== false && item.installState === 'installed'
      && item.installed?.packageSha256).map((item) => ({
      kind: 'expert-kit' as const,
      id: item.id,
      version: item.installed!.manifest.version,
      sha256: item.installed!.packageSha256!,
    })),
    ...skills.filter((item) => item.installed?.enabled !== false && ['installed', 'update'].includes(item.installState)
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
  enabledConnectorIds?: Iterable<string>,
): ConnectorRuntimeDefinition[] {
  const enabled = enabledConnectorIds === undefined ? undefined : new Set(enabledConnectorIds)
  return snapshot.connectors.filter((item) => enabled?.has(item.id) !== false).map((item) => ({
    ...item,
    toolNames: [...item.toolNames],
    environment: hydrateValues(item.environment, localSecrets[item.id]?.environment),
    headers: hydrateValues(item.headers, localSecrets[item.id]?.headers),
  }))
}

/** Timestamps are bookkeeping, not a reason to discard the execution session. */
export function capabilitySnapshotChanged(previous: CapabilitySnapshot | undefined, next: CapabilitySnapshot): boolean {
  return !previous || snapshotContent(previous) !== snapshotContent(next)
}

function snapshotContent({ extensions, connectors, knowledgeBaseRefs }: CapabilitySnapshot): string {
  // Rust's JSON maps sort keys, including nested connector settings, when persisting tasks.
  return JSON.stringify({ extensions, connectors, knowledgeBaseRefs }, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value)
}

function emptyValues(values?: Record<string, string>): Record<string, string> | undefined {
  if (values === undefined) return undefined
  return Object.fromEntries(Object.keys(values).map((key) => [key, '']))
}

function hydrateValues(template?: Record<string, string>, local?: Record<string, string>): Record<string, string> | undefined {
  if (template === undefined) return undefined
  return Object.fromEntries(Object.keys(template).map((key) => [key, local?.[key] ?? '']))
}
