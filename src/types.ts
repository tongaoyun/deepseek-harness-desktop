export interface BootstrapResponse {
  protocolVersion: string
  employeeId: string
  endpoints: {
    litellm: string
    erpMcp: string
    artifacts: string
    expertKits: string
    skills: string
    connectors: string
    schedules: string
    taskRuns: string
    imChannels: string
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
  minimumDesktopVersion: string
  commandIds: string[]
  skillIds: string[]
  connectorRefs: string[]
  requiredTools: string[]
  serverWorkflows: ServerWorkflowDefinition[]
  sha256: string
}

export interface ServerWorkflowDefinition {
  id: string
  name: string
  workflowType: string
  version: string
  inputs: ServerWorkflowInput[]
  steps: Array<{ id: string; tool: string; arguments: Record<string, unknown> }>
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
  pending?: boolean
}

export interface LocalTaskRun {
  id: string
  source: 'DESKTOP'
  name: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED'
  createdAt: string
  updatedAt: string
  sessionId?: string
  expertKitId?: string
  messages: TaskMessage[]
}

export interface ArtifactDownload {
  objectKey: string
  url: string
  expiresAt: string
}

export interface ImChannel {
  id: string
  name: string
  provider: 'DINGTALK' | string
  botId: string
  status: 'READY' | 'WAITING_CLIENT' | 'DEGRADED' | 'DISABLED' | 'UNAVAILABLE'
  connected: boolean
  onlineClients: number
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
  sourceKitId: string
  triggers: string[]
}

export type ConnectorStatus = 'ready' | 'needs-configuration' | 'unavailable' | 'disabled'

export interface ConnectorCatalogEntry {
  id: string
  name: string
  summary: string
  kind: string
  scope: string
  status: ConnectorStatus
  managed: boolean
  toolNames: string[]
}

export interface ExpertKitDownload {
  id: string
  version: string
  sha256: string
  url: string
  expiresAt: string
}

export type PermissionMode = 'deny' | 'allow' | 'approval'

export interface ExpertKitManifest {
  schemaVersion: string
  id: string
  name: string
  version: string
  summary: string
  minimumDesktopVersion: string
  commands: Array<{ id: string; path: string }>
  skills: Array<{ id: string; path: string }>
  requiredTools: string[]
  connectorRefs: string[]
  permissions: {
    localFiles: PermissionMode
    shell: PermissionMode
    erpRead: PermissionMode
    erpWrite: PermissionMode
  }
  serverWorkflows: ServerWorkflowDefinition[]
}

export interface InstalledExpertKit {
  manifest: ExpertKitManifest
  installPath: string
}
