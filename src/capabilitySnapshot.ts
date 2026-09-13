import { desktopToolNames } from './expertKits'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import type { AllowedExtensionArtifact, CapabilitySelection, CapabilitySnapshot, ConnectorRuntimeDefinition } from './types'
import type { ConnectorSecretStore } from './connectorSecrets'

interface CapabilitySource {
  version: string
  artifact?: AllowedExtensionArtifact
  implicit: boolean
  connectorRefs: string[]
  requiredTools: string[]
  knowledgeBaseRefs: string[]
}

export interface ResolveCapabilitySnapshotInput {
  expertKits: ExpertKitView[]
  skills: SkillView[]
  selections: CapabilitySelection[]
  connectors: ConnectorRuntimeDefinition[]
  selectedConnectorIds?: Iterable<string>
  knowledgeBaseRefs?: string[]
  availableKnowledgeBaseRefs?: Iterable<string>
  createdAt?: string
}

export class CapabilityResolutionError extends Error {
  constructor(message: string, readonly issues: string[]) {
    super(message)
    this.name = 'CapabilityResolutionError'
  }
}

/** Compiles Xiaoyin product choices into the only capability contract accepted by the runtime. */
export function resolveCapabilitySnapshot(input: ResolveCapabilitySnapshotInput): CapabilitySnapshot {
  if (input.selections.length > 8) throw resolutionError(['每个任务最多选择 8 项技能或专家套件'])
  const sources = new Map<string, CapabilitySource>()
  for (const kit of input.expertKits) sources.set(coordinate('expert-kit', kit.id), sourceFor('expert-kit', kit))
  for (const skill of input.skills) sources.set(coordinate('skill', skill.id), sourceFor('skill', skill))

  const issues: string[] = []
  const selectedCoordinates = new Set<string>()
  const artifacts: AllowedExtensionArtifact[] = []
  const dependencies = { connectors: new Set<string>(), tools: new Set<string>(), knowledge: new Set<string>() }
  for (const selection of input.selections) {
    const key = coordinate(selection.kind, selection.extensionId)
    if (selectedCoordinates.has(key)) {
      issues.push(`不能重复选择同一能力：${key}`)
      continue
    }
    selectedCoordinates.add(key)
    const source = sources.get(key)
    if (!source?.artifact) {
      issues.push(`能力未安装、已停用或缺少可信制品：${key}@${selection.extensionVersion}`)
      continue
    }
    if (source.version !== selection.extensionVersion || source.artifact.version !== selection.extensionVersion) {
      issues.push(`能力版本已变化，请重新选择：${key}@${selection.extensionVersion}`)
      continue
    }
    artifacts.push(source.artifact)
    source.connectorRefs.forEach((id) => dependencies.connectors.add(id))
    source.requiredTools.filter((name) => !desktopToolNames.has(name)).forEach((name) => dependencies.tools.add(name))
    source.knowledgeBaseRefs.forEach((reference) => dependencies.knowledge.add(reference))
  }

  const requestedConnectors = new Set(input.selectedConnectorIds ?? [])
  dependencies.connectors.forEach((id) => requestedConnectors.add(id))
  const connectorById = new Map(input.connectors.map((connector) => [connector.id, connector]))
  const connectors = [...requestedConnectors].flatMap((id) => {
    const connector = connectorById.get(id)
    if (!connector || !connector.enabled || connector.status !== 'ready') {
      issues.push(`所选能力依赖的连接器尚未就绪：${id}`)
      return []
    }
    return [sanitizeConnector(connector)]
  })
  const providedTools = new Set(connectors.flatMap((connector) => connector.toolNames))
  for (const tool of dependencies.tools) {
    if (!providedTools.has(tool)) issues.push(`所选能力需要工具 ${tool}，但当前连接器没有提供`)
  }

  const knowledgeBaseRefs = [...new Set([...(input.knowledgeBaseRefs ?? []), ...dependencies.knowledge])].sort()
  if (input.availableKnowledgeBaseRefs !== undefined) {
    const available = new Set(input.availableKnowledgeBaseRefs)
    for (const reference of dependencies.knowledge) {
      if (!available.has(reference)) issues.push(`所选能力依赖的知识库不存在或无访问权限：${reference}`)
    }
  }
  if (knowledgeBaseRefs.length > 32) issues.push('每个任务最多使用 32 个知识库')
  if (issues.length) throw resolutionError(issues)
  const implicitArtifacts = [...sources.entries()]
    .filter(([key, source]) => source.implicit && source.artifact && !selectedCoordinates.has(key))
    .map(([, source]) => source.artifact!)
    .sort(compareArtifacts)

  return {
    schemaVersion: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    selections: input.selections.map((selection) => ({ ...selection })),
    artifacts: artifacts.sort(compareArtifacts),
    implicitArtifacts,
    requestedConnectorIds: [...new Set(input.selectedConnectorIds ?? [])].sort(),
    connectors: connectors.sort((left, right) => left.id.localeCompare(right.id)),
    requestedKnowledgeBaseRefs: [...new Set(input.knowledgeBaseRefs ?? [])].sort(),
    knowledgeBaseRefs,
  }
}

export function capabilitySnapshotForExecution(
  snapshot: CapabilitySnapshot,
  runtimeConnectors: ConnectorRuntimeDefinition[] = [],
  localSecrets: ConnectorSecretStore = {},
  enabledConnectorIds?: Iterable<string>,
): CapabilitySnapshot {
  const enabled = enabledConnectorIds === undefined ? undefined : new Set(enabledConnectorIds)
  const runtimeById = new Map(runtimeConnectors.map((connector) => [connector.id, connector]))
  return {
    ...snapshot,
    connectors: snapshot.connectors.filter((item) => enabled?.has(item.id) !== false).map((item) => ({
      ...item,
      toolNames: [...item.toolNames],
      readOnlyTools: [...(item.readOnlyTools ?? [])],
      environment: hydrateValues(item.environment, runtimeById.get(item.id)?.environment, localSecrets[item.id]?.environment),
      headers: hydrateValues(item.headers, runtimeById.get(item.id)?.headers, localSecrets[item.id]?.headers),
    })),
  }
}

/** Timestamps are bookkeeping, not a reason to discard the execution session. */
export function capabilitySnapshotChanged(previous: CapabilitySnapshot | undefined, next: CapabilitySnapshot): boolean {
  return !previous || canonicalSnapshot(previous) !== canonicalSnapshot(next)
}

function sourceFor(kind: 'expert-kit' | 'skill', value: ExpertKitView | SkillView): CapabilitySource {
  const installed = value.installed
  const executable = value.installState === 'installed' && installed?.enabled !== false && Boolean(installed?.packageSha256)
  return {
    version: installed?.manifest.version ?? value.version,
    artifact: executable ? { kind, id: value.id, version: installed!.manifest.version, sha256: installed!.packageSha256! } : undefined,
    implicit: installed?.manifest.allowImplicitInvocation !== false,
    connectorRefs: value.connectorRefs ?? [],
    requiredTools: value.requiredTools ?? [],
    knowledgeBaseRefs: value.knowledgeBaseRefs ?? [],
  }
}

function sanitizeConnector(connector: ConnectorRuntimeDefinition): ConnectorRuntimeDefinition {
  return { ...connector, toolNames: [...connector.toolNames], readOnlyTools: [...(connector.readOnlyTools ?? [])], environment: emptyValues(connector.environment), headers: emptyValues(connector.headers) }
}
function canonicalSnapshot({ createdAt: _createdAt, ...snapshot }: CapabilitySnapshot): string {
  return JSON.stringify(snapshot, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value)
}
function coordinate(kind: string, id: string): string { return `${kind}:${id}` }
function compareArtifacts(left: AllowedExtensionArtifact, right: AllowedExtensionArtifact): number {
  return coordinate(left.kind, left.id).localeCompare(coordinate(right.kind, right.id))
}
function resolutionError(issues: string[]): CapabilityResolutionError { return new CapabilityResolutionError(issues.join('；'), issues) }
function emptyValues(values?: Record<string, string>): Record<string, string> | undefined {
  return values === undefined ? undefined : Object.fromEntries(Object.keys(values).map((key) => [key, '']))
}
function hydrateValues(template?: Record<string, string>, runtime?: Record<string, string>, local?: Record<string, string>): Record<string, string> | undefined {
  return template === undefined ? undefined : Object.fromEntries(Object.keys(template).map((key) => [key, local?.[key] ?? runtime?.[key] ?? '']))
}
