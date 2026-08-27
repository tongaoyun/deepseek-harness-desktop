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
  sha256: string
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
  serverWorkflows: Array<{ name: string; workflowType: string; version: string }>
}

export interface InstalledExpertKit {
  manifest: ExpertKitManifest
  installPath: string
}
