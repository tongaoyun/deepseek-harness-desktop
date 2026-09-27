import { resolveServerEndpoint } from './api'
import { readServerData } from './serverResponse'
import type { ConnectorCatalogEntry, ExpertKitManifest } from './types'
import { connectorSecretTemplate } from './connectorSecrets'

export type ExtensionKind = 'expert-kit' | 'skill' | 'connector'
export type SubmissionStatus = 'DRAFT' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'REJECTED' | 'PUBLISHED' | 'UNPUBLISHED'

export interface ExtensionSubmission {
  kind: ExtensionKind
  id: string
  name: string
  version: string
  summary: string
  category: string
  status: SubmissionStatus
  reviewNote: string
  updatedAt: string
  validationReport?: ExtensionValidationReport
}

export interface ExtensionValidationReport {
  type: 'HARNESS' | 'CONNECTOR_DIAGNOSTIC'
  status: 'PASSED' | 'FAILED' | 'CANCELED'
  prompt: string
  model: string
  latencyMs?: number
  discoveredTools: string[]
  steps: Array<{ kind: string; label: string; status: string; toolName: string }>
  artifacts: Array<{ name: string; kind: string; sourceTool: string }>
  finalResponse: string
  completedAt: string
}

function headers(employeeId: string, accessToken: string, json = false): Record<string, string> {
  return {
    'X-Xiaoyin-Employee-Id': employeeId,
    'X-Requested-With': 'XMLHttpRequest',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function checked<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { errMessage?: string }
    throw new Error(payload.errMessage || `${label}（${response.status}）`)
  }
  return readServerData<T>(response)
}

export async function loadMySubmissions(employeeId: string, accessToken: string): Promise<ExtensionSubmission[]> {
  return checked(await fetch(resolveServerEndpoint('/api/v1/extension-submissions'), { headers: headers(employeeId, accessToken), signal: submissionSignal() }), '加载我的创作失败')
}

export async function submitPackage(manifest: ExpertKitManifest, bytes: number[], employeeId: string, accessToken: string, validationReport?: ExtensionValidationReport): Promise<ExtensionSubmission> {
  const file = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', file)
  const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  const prepared = await checked<{ uploadUrl: string }>(await fetch(resolveServerEndpoint('/api/v1/extension-submissions/releases'), {
    method: 'POST', headers: headers(employeeId, accessToken, true), body: JSON.stringify({
      kind: manifest.kind, id: manifest.id, name: manifest.name, version: manifest.version, summary: manifest.summary, category: manifest.category,
      triggers: manifest.triggers ?? [], minimumDesktopVersion: manifest.minimumDesktopVersion,
      commandIds: manifest.commands.map((item) => item.id), skillIds: manifest.skills.map((item) => item.id),
      connectorRefs: manifest.connectorRefs, requiredTools: manifest.requiredTools,
      knowledgeBaseRefs: manifest.knowledgeBaseRefs ?? [],
      author: manifest.author, sha256,
    }),
    signal: submissionSignal(),
  }), '创建审核版本失败')
  const upload = await fetch(prepared.uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': 'application/gzip' },
    redirect: 'error',
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!upload.ok) throw new Error(`上传扩展制品失败（${upload.status}）`)
  const submission = await checked<ExtensionSubmission>(await fetch(resolveServerEndpoint(`/api/v1/extension-submissions/${manifest.kind}/${encodeURIComponent(manifest.id)}/versions/${encodeURIComponent(manifest.version)}/submissions`), {
    method: 'POST', headers: headers(employeeId, accessToken), signal: submissionSignal(),
  }), '提交审核失败')
  if (validationReport) await saveValidationReport(manifest.kind, manifest.id, manifest.version, validationReport, employeeId, accessToken).catch(() => undefined)
  return { ...submission, ...(validationReport ? { validationReport } : {}) }
}

export async function submitConnector(connector: ConnectorCatalogEntry, employeeId: string, accessToken: string, validationReport?: ExtensionValidationReport): Promise<ExtensionSubmission> {
  const template = connectorSecretTemplate(connector)
  const submission = await checked<ExtensionSubmission>(await fetch(resolveServerEndpoint('/api/v1/extension-submissions/connectors'), {
    method: 'POST', headers: headers(employeeId, accessToken, true), body: JSON.stringify(template), signal: submissionSignal(),
  }), '提交连接器审核失败')
  if (validationReport) await saveValidationReport('connector', connector.id, connector.version ?? '1.0.0', validationReport, employeeId, accessToken).catch(() => undefined)
  return { ...submission, validationReport }
}

export async function saveValidationReport(kind: ExtensionKind, id: string, version: string, report: ExtensionValidationReport, employeeId: string, accessToken: string): Promise<ExtensionValidationReport> {
  return checked(await fetch(resolveServerEndpoint(`/api/v1/extension-submissions/${kind}/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/validation-reports`), {
    method: 'POST', headers: headers(employeeId, accessToken, true), body: JSON.stringify(report), signal: submissionSignal(),
  }), '保存发布前验证结果失败')
}

function submissionSignal(timeoutMs = 30_000): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

const storageKey = (employeeId: string) => `xiaoyin.personal-connectors.${employeeId}`

export function isPersonalConnector(connector: ConnectorCatalogEntry): boolean {
  return connector.kind === 'personal-mcp' || ['personal', 'employee'].includes(connector.scope.toLowerCase())
}

export function loadPersonalConnectors(employeeId: string): ConnectorCatalogEntry[] {
  try {
    const values = JSON.parse(window.localStorage.getItem(storageKey(employeeId)) || '[]') as Array<ConnectorCatalogEntry & { category?: ConnectorCatalogEntry['category'] }>
    return values.map((item) => {
      const normalized = { ...item, scope: 'PERSONAL', managed: false, category: item.category ?? 'other' } as ConnectorCatalogEntry
      return connectorSecretTemplate(normalized)
    })
  } catch { return [] }
}

export function savePersonalConnector(employeeId: string, connector: ConnectorCatalogEntry): ConnectorCatalogEntry[] {
  const template = connectorSecretTemplate(connector)
  const values = [template, ...loadPersonalConnectors(employeeId).filter((item) => item.id !== connector.id)]
  window.localStorage.setItem(storageKey(employeeId), JSON.stringify(values))
  return values
}

export function deletePersonalConnector(employeeId: string, id: string): ConnectorCatalogEntry[] {
  const values = loadPersonalConnectors(employeeId).filter((item) => item.id !== id)
  window.localStorage.setItem(storageKey(employeeId), JSON.stringify(values))
  return values
}
