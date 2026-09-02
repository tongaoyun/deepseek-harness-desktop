import { resolveControlPlaneEndpoint } from './api'
import type { ConnectorCatalogEntry, ExpertKitManifest } from './types'

export type ExtensionKind = 'expert-kit' | 'skill' | 'connector'
export type SubmissionStatus = 'DRAFT' | 'SUBMITTED' | 'CHANGES_REQUESTED' | 'REJECTED' | 'PUBLISHED' | 'UNPUBLISHED'

export interface ExtensionSubmission {
  kind: ExtensionKind
  id: string
  name: string
  version: string
  summary: string
  status: SubmissionStatus
  reviewNote: string
  updatedAt: string
}

function headers(employeeId: string, accessToken: string, json = false): Record<string, string> {
  return { 'X-Xiaoyin-Employee-Id': employeeId, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) }
}

async function checked<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string; detail?: string }
    throw new Error(payload.message || payload.detail || `${label}（${response.status}）`)
  }
  return response.json() as Promise<T>
}

export async function loadMySubmissions(employeeId: string, accessToken: string): Promise<ExtensionSubmission[]> {
  return checked(await fetch(resolveControlPlaneEndpoint('/api/v1/extension-submissions'), { headers: headers(employeeId, accessToken) }), '加载我的创作失败')
}

export async function submitPackage(manifest: ExpertKitManifest, bytes: number[], employeeId: string, accessToken: string): Promise<ExtensionSubmission> {
  const file = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', file)
  const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  const prepared = await checked<{ uploadUrl: string }>(await fetch(resolveControlPlaneEndpoint('/api/v1/extension-submissions/releases'), {
    method: 'POST', headers: headers(employeeId, accessToken, true), body: JSON.stringify({
      kind: manifest.kind, id: manifest.id, name: manifest.name, version: manifest.version, summary: manifest.summary,
      triggers: manifest.triggers ?? [], minimumDesktopVersion: manifest.minimumDesktopVersion,
      commandIds: manifest.commands.map((item) => item.id), skillIds: manifest.skills.map((item) => item.id),
      connectorRefs: manifest.connectorRefs, requiredTools: manifest.requiredTools,
      knowledgeBaseRefs: manifest.knowledgeBaseRefs ?? [], permissions: manifest.permissions,
      serverWorkflows: manifest.serverWorkflows, sha256,
    }),
  }), '创建审核版本失败')
  const upload = await fetch(prepared.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/gzip' } })
  if (!upload.ok) throw new Error(`上传扩展制品失败（${upload.status}）`)
  return checked(await fetch(resolveControlPlaneEndpoint(`/api/v1/extension-submissions/${manifest.kind}/${encodeURIComponent(manifest.id)}/versions/${encodeURIComponent(manifest.version)}/submit`), {
    method: 'POST', headers: headers(employeeId, accessToken),
  }), '提交审核失败')
}

export async function submitConnector(connector: ConnectorCatalogEntry, employeeId: string, accessToken: string): Promise<ExtensionSubmission> {
  return checked(await fetch(resolveControlPlaneEndpoint('/api/v1/extension-submissions/connectors'), {
    method: 'POST', headers: headers(employeeId, accessToken, true), body: JSON.stringify(connector),
  }), '提交连接器审核失败')
}

const storageKey = (employeeId: string) => `xiaoyin.personal-connectors.${employeeId}`

export function loadPersonalConnectors(employeeId: string): ConnectorCatalogEntry[] {
  try { return JSON.parse(window.localStorage.getItem(storageKey(employeeId)) || '[]') as ConnectorCatalogEntry[] } catch { return [] }
}

export function savePersonalConnector(employeeId: string, connector: ConnectorCatalogEntry): ConnectorCatalogEntry[] {
  const values = [connector, ...loadPersonalConnectors(employeeId).filter((item) => item.id !== connector.id)]
  window.localStorage.setItem(storageKey(employeeId), JSON.stringify(values))
  return values
}
