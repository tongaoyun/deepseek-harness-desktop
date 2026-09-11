export interface BootstrapResponse {
  protocolVersion: string
  employeeId: string
  modelApiKey: string
  endpoints: {
    litellm: string
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

export interface TaskMessage {
  role: 'assistant' | 'user'
  text: string
  attachments?: LocalTaskAttachment[]
  pending?: boolean
  monitor?: TaskMonitorState
  executionTurnId?: string
  id?: string
  source?: 'desktop' | 'dingtalk'
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
  kind: 'assistant' | 'command' | 'file' | 'connector' | 'browser' | 'subagent' | 'tool' | 'approval' | 'error' | 'warning'
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
  occurredAt: string
  completedAt?: string
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
  action?: 'created' | 'updated' | 'copied' | 'moved' | 'published'
  backupPath?: string
  sizeBytes?: number
  createdAt: string
}

export interface TaskVisualArtifact {
  id: string
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg'
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

export interface TaskMonitorProjection {
  executionStarted?: boolean
  operationScope?: string
  interruption?: {
    checkpointAt: string
    cause: 'exit' | 'failure' | 'canceled'
    pendingOperations: Array<{ id: string; label: string; toolName?: string }>
  }
  outcome?: import('./taskOutcome').TaskOutcome
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
  failure?: {
    code: string
    category: string
    detail: string
  }
}

/** @deprecated Runtime code must write ExecutionEvent and derive this projection. */
export type TaskMonitorState = TaskMonitorProjection

export type ExecutionEventType =
  | 'turn.started'
  | 'turn.retry.started'
  | 'turn.interrupt.requested'
  | 'turn.interrupt.failed'
  | 'turn.progress.updated'
  | 'item.started'
  | 'item.updated'
  | 'item.completed'
  | 'item.failed'
  | 'approval.requested'
  | 'approval.decided'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.interrupted'
  | 'verification.recorded'
  | 'file.changes.updated'

export interface ExecutionProjectionDelta {
  executionStarted?: boolean
  operationScope?: string
  status?: TaskMonitorProjection['status']
  activity?: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  steps?: TaskExecutionStep[]
  timeline?: TaskTimelineEntry[]
  subagents?: SubagentActivity[]
  changes?: TaskFileChange[]
  artifacts?: TaskArtifact[]
  visuals?: TaskVisualArtifact[]
  knowledgeSources?: KnowledgeSearchHit[]
  interruption?: TaskMonitorProjection['interruption']
  outcome?: TaskMonitorProjection['outcome']
  failure?: TaskMonitorProjection['failure']
  replaceCollections?: Array<'steps' | 'timeline' | 'subagents' | 'changes' | 'artifacts' | 'visuals' | 'knowledgeSources'>
}

export interface ExecutionEvent {
  id: string
  sequence: number
  turnId: string
  type: ExecutionEventType
  occurredAt: string
  itemId?: string
  item?: ExecutionItem
  correlationId?: string
  sourceCursor?: { streamId: string; requestId: number; sequence: number }
  verification?: {
    status: 'claimed' | 'verified' | 'partial' | 'blocked' | 'uncertain'
    summary: string
    evidenceCount: number
  }
  projection: ExecutionProjectionDelta
}

export interface ExecutionItem {
  id: string
  kind: 'analysis' | 'assistant' | 'tool-call' | 'approval' | 'subagent' | 'warning' | 'error' | 'verification' | 'provider-turn'
  status: 'running' | 'completed' | 'failed' | 'canceled'
  label: string
  startedAt: string
  completedAt?: string
  correlationId?: string
  toolName?: string
}

export interface ExecutionTurn {
  id: string
  sessionId: string
  status: 'running' | 'completed' | 'failed' | 'canceled'
  startedAt: string
  completedAt?: string
  nextSequence: number
  sourceCursors: Record<string, number>
  items: ExecutionItem[]
  events: ExecutionEvent[]
}

export interface ExecutionThread {
  protocolVersion: 1
  id: string
  activeTurnId?: string
  turns: ExecutionTurn[]
}

export interface LocalTaskRun {
  id: string
  source: 'DESKTOP'
  name: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED'
  createdAt: string
  updatedAt: string
  archivedAt?: string
  sessionId?: string
  expertKitId?: string
  skillId?: string
  invocationTokens?: string[]
  invocationSpecs?: InvocationSpec[]
  composerConnectorIds?: string[]
  model?: string
  localDirectories?: Array<{ id: string; name: string; path?: string }>
  capabilitySnapshot?: CapabilitySnapshot
  execution?: ExecutionThread
  monitor: TaskMonitorState
  messages: TaskMessage[]
  processedImEventIds?: string[]
}

export interface InvocationSpec {
  mode: 'explicit'
  kind: 'expert-kit' | 'skill'
  extensionId: string
  extensionVersion: string
  skillId?: string
  commandId?: string
}

export interface CapabilitySnapshot {
  createdAt: string
  extensions: AllowedExtensionArtifact[]
  connectors: ConnectorRuntimeDefinition[]
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
  indexRunId?: string
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
export type ConnectorTransport = 'streamable-http' | 'sse' | 'stdio' | 'desktop'
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
  skills: Array<{ id: string; path: string }>
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
