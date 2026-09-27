export type RuntimeCapabilityStatus = 'enabled' | 'gated' | 'unconfigured'

export interface RuntimeDiagnosticsInput {
  runtime?: string
  version?: string
  capabilities: Record<string, RuntimeCapabilityStatus>
  generatedAt?: string
}

export interface RuntimeDiagnostics {
  schemaVersion: 1
  runtime: string
  version: string
  capabilities: Record<string, RuntimeCapabilityStatus>
  generatedAt: string
}

const RUNTIME_CAPABILITY_KEYS = new Set([
  'profile', 'modelProvider', 'agentLoop', 'sessionController', 'sessionPersistence', 'sessionCheckpoint',
  'sessionProjection', 'projectionCache', 'sandbox', 'approval', 'planMode', 'askUser', 'filesystem',
  'fileSearch', 'skills', 'commands', 'commandFeedback', 'subagent', 'todo', 'goal', 'ralph', 'workflow',
  'compaction', 'toolResultPruner', 'tokenMeter', 'jobs', 'workspaceChanges', 'workspaceDependencies',
  'officeSkills', 'libreOfficeKit', 'webSearch', 'webFetch',
  'settings', 'credentials', 'llmRetry', 'outputRetention', 'spillPolicy', 'timeoutPolicy', 'sessionQuery',
  'sessionQueryTools', 'sessionReference', 'mcpClient', 'persistentTerminal', 'lsp',
  'codexSubagent', 'claudeSubagent', 'acpSubagent', 'dshSubagent', 'officialAttachment',
  'officialFilesystem', 'present', 'shell', 'browser', 'codexHooks', 'claudeHooks',
])

/** Build the intentionally small, safe-to-share runtime diagnostic payload. */
export function buildRuntimeDiagnostics(input: RuntimeDiagnosticsInput, now = new Date()): RuntimeDiagnostics {
  return {
    schemaVersion: 1,
    runtime: input.runtime === 'deepseek-harness' ? input.runtime : 'unknown',
    version: diagnosticVersion(input.version),
    capabilities: Object.fromEntries(Object.entries(input.capabilities)
      .filter(([key, value]) => RUNTIME_CAPABILITY_KEYS.has(key) && ['enabled', 'gated', 'unconfigured'].includes(value))),
    generatedAt: input.generatedAt ?? now.toISOString(),
  }
}

function diagnosticVersion(value: string | undefined): string {
  return value && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u.test(value)
    ? value : 'unknown'
}

export function runtimeDiagnosticsFilename(now = new Date()): string {
  return `xiaoyin-runtime-diagnostics-${now.toISOString().replaceAll(':', '-')}.json`
}
