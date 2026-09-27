import type { ConversationEntry } from './conversation/types'

export interface BootstrapResponse {
  protocolVersion: string
  employeeId: string
  modelApiKey: string
  endpoints: {
    litellm: string
    erpMcp: string
    artifacts: string
    expertKits: string
    skills: string
    connectors: string
    knowledge: string
    deviceCapabilities?: string
    auditEvents?: string
    memoryProfile?: string
  }
  capabilities: string[]
  models: string[]
}

export type RuntimeStatus = 'connecting' | 'ready' | 'offline'

export interface ExpertKitSkillDetail {
  id: string
  name: string
  summary: string
  argumentHint: string
}

export interface ExpertKitCatalogEntry {
  id: string
  name: string
  author?: string
  version: string
  summary: string
  category: import('./extensionCategories').ExtensionCategory
  minimumDesktopVersion: string
  commandIds: string[]
  skillIds: string[]
  skillDetails?: ExpertKitSkillDetail[]
  connectorRefs: string[]
  requiredTools: string[]
  knowledgeBaseRefs: string[]
  sha256: string
}

export interface LocalTaskAttachment {
  id: string
  rootId: string
  rootName: string
  rootPath?: string
  path: string
  name: string
  kind: 'file' | 'image'
  mediaType?: 'image/png' | 'image/jpeg'
}

export interface TaskExecutionStep {
  id: string
  kind: 'analysis' | 'tool' | 'approval' | 'response'
  label: string
  status: 'running' | 'completed' | 'failed' | 'canceled'
  toolName?: string
  startedAt: string
  completedAt?: string
}

export interface SubagentActivity {
  id: string
  label: string
  status: 'running' | 'completed' | 'failed' | 'canceled'
  startedAt: string
  completedAt?: string
}

export interface TaskTimelineEntry {
  id: string
  kind: 'assistant' | 'command' | 'file' | 'connector' | 'browser' | 'subagent' | 'tool' | 'approval' | 'question' | 'error' | 'warning'
  label: string
  status: 'running' | 'completed' | 'failed' | 'canceled'
  text?: string
  toolName?: string
  detail?: string
  output?: string
  path?: string
  secondaryPath?: string
  connectorName?: string
  itemCount?: number
  approvalId?: string
  questionId?: string
  questions?: TaskQuestionItem[]
  occurredAt: string
  completedAt?: string
}

export interface TaskQuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string }
}

export interface TaskQuestionAnswer {
  id: string
  selected: string[]
  custom?: string
}

export type TaskArtifactKind = 'document' | 'spreadsheet' | 'presentation' | 'pdf' | 'text' | 'image' | 'file'

export interface TaskArtifact {
  id: string
  rootId: string
  rootName: string
  path: string
  name: string
  kind: TaskArtifactKind
  sourceTool: string
  action?: 'created' | 'updated' | 'copied' | 'moved' | 'published' | 'presented'
  backupPath?: string
  sizeBytes?: number
  createdAt: string
}

export interface TaskVisualArtifact {
  id: string
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  name: string
  width: number
  height: number
  sourceTool: string
  createdAt: string
}

export interface TaskFileChange {
  id: string
  rootId: string
  rootName: string
  path: string
  name: string
  sourceTool: string
  action: 'created' | 'updated' | 'copied' | 'moved' | 'deleted'
  previousPath?: string
  backupPath?: string
  afterHash?: string
  beforeHash?: string
  undoneAt?: string
  recoveryPath?: string
  addedLines?: number
  deletedLines?: number
  changedAt: string
}

/**
 * Xiaoyin product read model derived from the Harness Session Projection.
 * This is UI/query data only; execution facts live in the Harness Session Log.
 */
export interface XiaoyinTaskProjection {
  executionStarted?: boolean
  operationScope?: string
  interruption?: {
    checkpointAt: string
    cause: 'exit' | 'failure' | 'canceled'
    pendingOperations: Array<{ id: string; label: string; toolName?: string }>
  }
  status: 'idle' | 'running' | 'completed' | 'failed' | 'canceled'
  activity: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  steps: TaskExecutionStep[]
  timeline?: TaskTimelineEntry[]
  subagents?: SubagentActivity[]
  changes?: TaskFileChange[]
  artifacts: TaskArtifact[]
  visuals?: TaskVisualArtifact[]
  knowledgeSources?: KnowledgeSearchHit[]
  /** Official Harness token-meter projection, copied without recalculation. */
  tokenUsage?: {
    uncachedInputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  /** Official Harness context-pressure projection, copied without recalculation. */
  contextPressure?: {
    contextWindow?: number
    pressureTokens?: number
    projectedTokens?: number
  }
  outputRetention?: {
    prunedResults: number
    omittedTokens: number
  }
  compactions?: number
  failure?: {
    code: string
    category: string
    detail: string
    title?: string
    infrastructure?: boolean
    retryable?: boolean
  }
  retry?: {
    attempt: number
    code: string
    title: string
    detail: string
  }
}

export interface LocalTaskRun {
  id: string
  source: 'DESKTOP'
  name: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED'
  createdAt: string
  updatedAt: string
  /** Last time the user successfully opened this task from the history list. */
  lastOpenedAt?: string
  archivedAt?: string
  sessionId?: string
  /** Product scheduling references. Execution details remain in Harness events. */
  scheduleId?: string
  scheduleRunId?: string
  invocationTokens?: string[]
  model?: string
  reasoningEffort?: import('./modelReasoning').ReasoningEffort
  executionMode?: 'agent' | 'plan'
  localDirectories?: Array<{ id: string; name: string; path?: string }>
  capabilitySnapshot?: CapabilitySnapshot
  projection: XiaoyinTaskProjection
  entries: ConversationEntry[]
  /** Small local index hint; the full transcript lives in Harness Persistence. */
  messagePreview?: string
  /** Bounded product-owned notices, keyed to the official assistant turn. */
  capabilityNotices?: import('./conversation/capabilityNotices').StoredCapabilityNotice[]
  /** Desktop question and steering receipts absent from the Harness event log. */
  interactionSegments?: import('./conversation/interactionSegments').StoredInteractionSegment[]
  processedImEventIds?: string[]
}

export interface CapabilitySelection {
  mode: 'explicit'
  kind: 'expert-kit' | 'skill'
  extensionId: string
  extensionVersion: string
  skillId?: string
  commandId?: string
}

export interface CapabilitySnapshot {
  schemaVersion: 2
  createdAt: string
  selections: CapabilitySelection[]
  artifacts: AllowedExtensionArtifact[]
  implicitArtifacts: AllowedExtensionArtifact[]
  /** Official Harness/local bridge tools fixed for the lifetime of this session. */
  localTools: string[]
  requestedConnectorIds: string[]
  connectors: ConnectorRuntimeDefinition[]
  requestedKnowledgeBaseRefs: string[]
  knowledgeBaseRefs: string[]
}

export interface ArtifactDownload {
  objectKey: string
  url: string
  expiresAt: string
}

export interface KnowledgeBaseEntry {
  id: string
  referenceKey: string
  reference: string
  scope: 'PERSONAL' | 'TEAM' | 'ORGANIZATION'
  name: string
  description: string
  createdAt: string
  updatedAt: string
}

export type KnowledgeDocumentStatus = 'QUEUED' | 'PROCESSING' | 'READY' | 'FAILED'

export interface KnowledgeDocumentEntry {
  id: string
  knowledgeBaseId: string
  filename: string
  mediaType: string
  sizeBytes: number
  status: KnowledgeDocumentStatus
  chunkCount: number
  failureMessage?: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeSearchHit {
  sourceId?: string
  knowledgeBaseId: string
  knowledgeBaseName: string
  documentId: string
  filename: string
  locator: string
  content: string
  score: number
}

export interface SkillCatalogEntry {
  id: string
  name: string
  author?: string
  version: string
  summary: string
  category: import('./extensionCategories').ExtensionCategory
  sourceKitId: string
  triggers: string[]
  minimumDesktopVersion: string
  connectorRefs: string[]
  requiredTools: string[]
  knowledgeBaseRefs: string[]
  sha256: string
}

export type ConnectorStatus = 'ready' | 'needs-configuration' | 'unavailable' | 'disabled'
export type ConnectorTransport = 'streamable-http' | 'stdio'
export type ConnectorAuthMode = 'employee-bearer' | 'erp-cookie' | 'oauth' | 'none'

export interface ConnectorCatalogEntry {
  timeoutSeconds?: number
  id: string
  name: string
  summary: string
  category: import('./extensionCategories').ConnectorCategory
  kind: string
  scope: string
  status: ConnectorStatus
  managed: boolean
  version?: string
  transport?: ConnectorTransport
  url?: string
  authMode?: ConnectorAuthMode
  toolNames: string[]
  readOnlyTools?: string[]
  command?: string
  arguments?: string[]
  environment?: Record<string, string>
  headers?: Record<string, string>
}

export interface ConnectorRuntimeDefinition {
  timeoutSeconds?: number
  id: string
  name: string
  status: ConnectorStatus
  version: string
  transport: ConnectorTransport
  url: string
  authMode: ConnectorAuthMode
  toolNames: string[]
  readOnlyTools?: string[]
  command?: string
  arguments?: string[]
  environment?: Record<string, string>
  headers?: Record<string, string>
  enabled: boolean
}

export type ConnectorDiagnosticStatus = 'ready' | 'drift' | 'authentication-required' | 'access-denied' | 'unavailable'

export interface ConnectorDiagnosticResult {
  id: string
  status: ConnectorDiagnosticStatus
  latencyMs: number
  discoveredTools: string[]
  missingTools: string[]
  undeclaredTools: string[]
  error?: string
}

export interface ExpertKitDownload {
  id: string
  version: string
  sha256: string
  url: string
  expiresAt: string
}

export interface AllowedExtensionArtifact {
  kind: 'expert-kit' | 'skill'
  id: string
  version: string
  sha256: string
}

export interface ExpertKitManifest {
  schemaVersion: string
  kind: 'expert-kit' | 'skill'
  id: string
  name: string
  author?: string
  version: string
  summary: string
  category: import('./extensionCategories').ExtensionCategory
  triggers?: string[]
  allowImplicitInvocation?: boolean
  minimumDesktopVersion: string
  commands: Array<{ id: string; path: string; skillId?: string }>
  skills: Array<{ id: string; path: string; requiredTools?: string[]; connectorRefs?: string[]; knowledgeBaseRefs?: string[] }>
  requiredTools: string[]
  connectorRefs: string[]
  knowledgeBaseRefs?: string[]
}

export interface InstalledExpertKit {
  author?: string
  enabled?: boolean
  bundledConnectors?: unknown
  manifest: ExpertKitManifest
  installPath: string
  source: 'catalog' | 'developer'
  packageSha256?: string
}

export interface InstalledExtensionSnapshot {
  kind: 'expert-kit' | 'skill'
  id: string
  version: string
  source: 'catalog' | 'developer'
}

export interface InstalledExtensionIssue {
  coordinate: string
  message: string
}

export interface InstalledExtensionInventory {
  installed: InstalledExpertKit[]
  issues: InstalledExtensionIssue[]
}

export interface DeviceHeartbeatContext {
  deviceId: string
  desktopVersion: string
  platform: string
  architecture: string
  displayCount: number
  displayScalePercents: number[]
}

export type AuditEventSource = 'DESKTOP' | 'SERVER' | 'IM'
export type AuditEventCategory = 'AGENT' | 'TOOL' | 'APPROVAL' | 'SCHEDULE' | 'KNOWLEDGE' | 'EXTENSION'
export type AuditEventOutcome = 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'CANCELED'

export interface AuditEventEntry {
  id: string
  source: AuditEventSource
  category: AuditEventCategory
  action: string
  outcome: AuditEventOutcome
  resourceType: string
  resourceId: string
  summary: string
  occurredAt: string
  receivedAt: string
}

export interface SubmitAuditEvent {
  source: AuditEventSource
  category: AuditEventCategory
  action: string
  outcome: AuditEventOutcome
  resourceType?: string
  resourceId?: string
  summary?: string
  occurredAt?: string
}
