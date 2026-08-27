import type {
  BootstrapResponse,
  ConnectorCatalogEntry,
  ExpertKitCatalogEntry,
  ExpertKitDownload,
  SkillCatalogEntry,
} from './types'

const DEFAULT_CONTROL_PLANE = 'http://127.0.0.1:8080'

export async function loadBootstrap(employeeId = 'local-development', accessToken = '', signal?: AbortSignal): Promise<BootstrapResponse> {
  const response = await fetch(controlPlaneUrl('/api/v1/bootstrap'), {
    headers: enterpriseHeaders(employeeId, accessToken),
    signal,
  })
  if (!response.ok) {
    throw new Error(`控制中心返回 ${response.status}`)
  }
  return response.json() as Promise<BootstrapResponse>
}

export async function loadExpertKits(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ExpertKitCatalogEntry[]> {
  const response = await fetch(controlPlaneUrl(endpoint), {
    headers: enterpriseHeaders(employeeId, accessToken),
    signal,
  })
  if (!response.ok) throw new Error(`专家套件目录返回 ${response.status}`)
  return response.json() as Promise<ExpertKitCatalogEntry[]>
}

export async function createExpertKitDownload(
  endpoint: string,
  kitId: string,
  employeeId: string,
  accessToken: string,
): Promise<ExpertKitDownload> {
  const base = endpoint.replace(/\/$/, '')
  const response = await fetch(controlPlaneUrl(`${base}/${encodeURIComponent(kitId)}/download`), {
    headers: enterpriseHeaders(employeeId, accessToken),
  })
  if (!response.ok) throw new Error(`专家套件下载授权返回 ${response.status}`)
  return response.json() as Promise<ExpertKitDownload>
}

export async function loadSkills(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<SkillCatalogEntry[]> {
  return loadCatalog(endpoint, employeeId, accessToken, '技能目录', signal)
}

export async function loadConnectors(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ConnectorCatalogEntry[]> {
  return loadCatalog(endpoint, employeeId, accessToken, '连接器目录', signal)
}

async function loadCatalog<T>(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  label: string,
  signal?: AbortSignal,
): Promise<T[]> {
  const response = await fetch(controlPlaneUrl(endpoint), {
    headers: enterpriseHeaders(employeeId, accessToken),
    signal,
  })
  if (!response.ok) throw new Error(`${label}返回 ${response.status}`)
  return response.json() as Promise<T[]>
}

function controlPlaneUrl(path: string): string {
  const baseUrl = import.meta.env.VITE_CONTROL_PLANE_BASE_URL ?? DEFAULT_CONTROL_PLANE
  return new URL(path, `${baseUrl.replace(/\/$/, '')}/`).toString()
}

function enterpriseHeaders(employeeId: string, accessToken: string): Record<string, string> {
  return {
    'X-Xiaoyin-Employee-Id': employeeId,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  }
}
