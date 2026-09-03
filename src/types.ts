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
    schedules: string
    taskRuns: string
    knowledge: string
    deviceCapabilities?: string
    auditEvents?: string
    memoryProfile?: string
  }
  capabilities: string[]
  models: string[]
}

export type RuntimeStatus = 'connecting' | 'ready' | 'offline'

export interface ExpertKitCatalogEntry {
  id: string
  name: string
  version: string
  summary: string
  category: import('./extensionCategories').ExtensionCategory
  minimumDesktopVersion: string
  commandIds: string[]
  skillIds: string[]
  connectorRefs: string[]
  requiredTools: string[]
  knowledgeBaseRefs: string[]
  permissions: ExpertKitPermissions
  serverWorkflows: ServerWorkflowDefinition[]
  sha256: string
}

export interface ServerWorkflowDefinition {
  id: string
  name: string
  workflowType: string
  version: string
  inputs: ServerWorkflowInput[]
  steps: Array<{ id: string; connectorId: string; tool: string; arguments: Record<string, unknown> }>
}

export interface ServerWorkflowInput {
  name: string
  label: string
  type: 'string' | 'date' | 'integer' | 'boolean'
  required: boolean
  description?: string
}

export interface ScheduledTask {
  id: string
  name: string
  expertKitId: string
  expertKitVersion: string
  workflowId: string
  workflowType: string
  workflowVersion: string
  cronExpression: string
  timeZone: string
  inputs: Record<string, unknown>
  status: 'ACTIVE' | 'PAUSED'
  createdAt: string
  updatedAt: string
}

export interface ScheduledTaskExecution {
  scheduledAt: string
  startedAt: string
  workflowId: string
  runId: string
  status: string
  closedAt?: string
  artifactObjectKey?: string
}

export interface CloudTaskRun {
  id: string
  source: 'SCHEDULE'
  employeeId?: string
  name: string
  expertKitId: string
  workflowId: string
  scheduleId: string
  temporalWorkflowId: string
  runId: string
  status: string
  scheduledAt: string
  startedAt: string
  closedAt?: string
  artifactObjectKey?: string
}

export interface TaskMessage {
  role: 'assistant' | 'user'
  text: string
  attachments?: LocalTaskAttachment[]
  pending?: boolean
  monitor?: TaskMonitorState
  id?: string
  source?: 'desktop' | 'dingtalk'
}

export interface LocalTaskAttachment {
  id: string
  rootId: string
  rootName: string
  path: string
  name: string
  kind: 'file' | 'image'
  mediaType?: 'image/png' | 'image/jpeg'
}

export interface TaskExecutionStep {
  id: string
  kind: 'analysis' | 'tool' | 'approval' | 'response'
  label: string
  status: 'running' | 'completed' | 'failed'
  toolName?: string
  startedAt: string
  completedAt?: string
}

export interface TaskTimelineEntry {
  id: string
  kind: 'assistant' | 'command' | 'file' | 'connector' | 'browser' | 'tool' | 'approval' | 'error' | 'warning'
  label: string
  status: 'running' | 'completed' | 'failed'
  text?: string
  toolName?: string
  detail?: string
  output?: string
  path?: string
  secondaryPath?: string
  connectorName?: string
  itemCount?: number
  occurredAt: string
  completedAt?: string
}

export type TaskArtifactKind = 'document' | 'spreadsheet' | 'pdf' | 'text' | 'file'

export interface TaskArtifact {
  id: string
  rootId: string
  rootName: string
  path: string
  name: string
  kind: TaskArtifactKind
  sourceTool: string
  sizeBytes?: number
  createdAt: string
}

export interface TaskMonitorState {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'canceled'
  activity: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  steps: TaskExecutionStep[]
  timeline?: TaskTimelineEntry[]
  artifacts: TaskArtifact[]
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
  model?: string
  localDirectories?: Array<{ id: string; name: string; path?: string }>
  capabilitySnapshot?: CapabilitySnapshot
  monitor: TaskMonitorState
  messages: TaskMessage[]
  processedImEventIds?: string[]
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
  temporalWorkflowId?: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeSearchHit {
  knowledgeBaseId: string
  knowledgeBaseName: string
  documentId: string
  filename: string
  locator: string
  content: string
  score: number
}

export interface CreateScheduledTaskRequest {
  name: string
  expertKitId: string
  workflowId: string
  cronExpression: string
  timeZone: string
  inputs: Record<string, unknown>
}

export interface SkillCatalogEntry {
  id: string
  name: string
  version: string
  summary: string
  category: import('./extensionCategories').ExtensionCategory
  sourceKitId: string
  triggers: string[]
  minimumDesktopVersion: string
  connectorRefs: string[]
  requiredTools: string[]
  knowledgeBaseRefs: string[]
  permissions: ExpertKitPermissions
  sha256: string
}

export type ConnectorStatus = 'ready' | 'needs-configuration' | 'unavailable' | 'disabled'
export type ConnectorTransport = 'streamable-http' | 'sse' | 'stdio' | 'desktop'
export type ConnectorAuthMode = 'employee-bearer' | 'none'

export interface ConnectorCatalogEntry {
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

export type ConnectorDiagnosticStatus = 'ready' | 'drift' | 'unavailable'

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

export type PermissionMode = 'deny' | 'allow' | 'approval'

export interface ExpertKitPermissions {
  localFiles: PermissionMode
  shell: PermissionMode
  computerUse: PermissionMode
  connectorRead: PermissionMode
  connectorWrite: PermissionMode
}

export interface ExpertKitManifest {
  schemaVersion: string
  kind: 'expert-kit' | 'skill'
  id: string
  name: string
  version: string
  summary: string
  category: import('./extensionCategories').ExtensionCategory
  triggers?: string[]
  minimumDesktopVersion: string
  commands: Array<{ id: string; path: string }>
  skills: Array<{ id: string; path: string }>
  requiredTools: string[]
  connectorRefs: string[]
  knowledgeBaseRefs?: string[]
  permissions: {
    localFiles: PermissionMode
    shell: PermissionMode
    computerUse?: PermissionMode
    connectorRead?: PermissionMode
    connectorWrite?: PermissionMode
  }
  serverWorkflows: ServerWorkflowDefinition[]
}

export interface InstalledExpertKit {
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
export type AuditEventOutcome = 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'DENIED'

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
