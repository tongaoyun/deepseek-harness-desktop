import type {
  BootstrapResponse,
  ArtifactDownload,
  CloudTaskRun,
  ConnectorCatalogEntry,
  CreateScheduledTaskRequest,
  ExpertKitCatalogEntry,
  ExpertKitDownload,
  SkillCatalogEntry,
  ScheduledTask,
  ScheduledTaskExecution,
  KnowledgeBaseEntry,
  KnowledgeDocumentEntry,
  KnowledgeSearchHit,
  DeviceCapabilityReport,
  SubmitDeviceCapabilityReport,
} from './types'

const DEFAULT_CONTROL_PLANE = 'http://192.168.2.67:30081'

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

export async function loadScheduledTasks(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ScheduledTask[]> {
  return loadCatalog(endpoint, employeeId, accessToken, '定时任务', signal)
}

export async function createScheduledTask(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  request: CreateScheduledTaskRequest,
): Promise<ScheduledTask> {
  return scheduleRequest(endpoint, employeeId, accessToken, '', 'POST', request)
}

export async function changeScheduledTask(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  id: string,
  action: 'pause' | 'resume' | 'run',
): Promise<ScheduledTask> {
  return scheduleRequest(endpoint, employeeId, accessToken,
    `/${encodeURIComponent(id)}/${action}`, 'POST')
}

export async function deleteScheduledTask(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  id: string,
): Promise<void> {
  const response = await fetch(controlPlaneUrl(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: enterpriseHeaders(employeeId, accessToken),
  })
  if (!response.ok) throw new Error(`删除定时任务返回 ${response.status}`)
}

export async function loadScheduledTaskExecutions(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  id: string,
): Promise<ScheduledTaskExecution[]> {
  return loadCatalog(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(id)}/executions`,
    employeeId, accessToken, '执行记录')
}

export async function loadCloudTaskRuns(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<CloudTaskRun[]> {
  return loadCatalog(endpoint, employeeId, accessToken, '任务记录', signal)
}

export async function createTaskRunArtifactDownload(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  runId: string,
): Promise<ArtifactDownload> {
  const response = await fetch(controlPlaneUrl(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(runId)}/artifact`), {
    headers: enterpriseHeaders(employeeId, accessToken),
  })
  if (!response.ok) throw new Error(`任务产物下载授权返回 ${response.status}`)
  return response.json() as Promise<ArtifactDownload>
}

export async function loadDeviceCapabilityReports(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<DeviceCapabilityReport[]> {
  return loadCatalog(endpoint, employeeId, accessToken, '设备能力记录', signal)
}

export async function submitDeviceCapabilityReport(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  request: SubmitDeviceCapabilityReport,
): Promise<DeviceCapabilityReport> {
  const response = await fetch(controlPlaneUrl(endpoint), {
    method: 'POST',
    headers: { ...enterpriseHeaders(employeeId, accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`设备能力上报返回 ${response.status}`)
  return response.json() as Promise<DeviceCapabilityReport>
}

export async function loadKnowledgeBases(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<KnowledgeBaseEntry[]> {
  const response = await fetch(controlPlaneUrl(endpoint), {
    headers: knowledgeHeaders(employeeId, teamId, accessToken), signal,
  })
  if (!response.ok) throw new Error(`知识库返回 ${response.status}`)
  return response.json() as Promise<KnowledgeBaseEntry[]>
}

export async function createKnowledgeBase(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  request: { name: string; description: string; referenceKey: string; scope: KnowledgeBaseEntry['scope'] },
): Promise<KnowledgeBaseEntry> {
  return knowledgeRequest(endpoint, employeeId, teamId, accessToken, '', 'POST', request)
}

export async function deleteKnowledgeBase(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  knowledgeBaseId: string,
): Promise<void> {
  await knowledgeVoidRequest(endpoint, employeeId, teamId, accessToken, `/${encodeURIComponent(knowledgeBaseId)}`, 'DELETE')
}

export async function loadKnowledgeDocuments(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  knowledgeBaseId: string,
  signal?: AbortSignal,
): Promise<KnowledgeDocumentEntry[]> {
  const response = await fetch(controlPlaneUrl(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(knowledgeBaseId)}/documents`), {
    headers: knowledgeHeaders(employeeId, teamId, accessToken), signal,
  })
  if (!response.ok) throw new Error(`知识库文档返回 ${response.status}`)
  return response.json() as Promise<KnowledgeDocumentEntry[]>
}

export async function uploadKnowledgeDocument(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  knowledgeBaseId: string,
  file: File,
): Promise<KnowledgeDocumentEntry> {
  const form = new FormData()
  form.append('file', file, file.name)
  const response = await fetch(controlPlaneUrl(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(knowledgeBaseId)}/documents`), {
    method: 'POST', headers: knowledgeHeaders(employeeId, teamId, accessToken), body: form,
  })
  if (!response.ok) throw new Error(`知识库文档上传返回 ${response.status}`)
  return response.json() as Promise<KnowledgeDocumentEntry>
}

export async function reindexKnowledgeDocument(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  knowledgeBaseId: string,
  documentId: string,
): Promise<KnowledgeDocumentEntry> {
  return knowledgeRequest(endpoint, employeeId, teamId, accessToken,
    `/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/reindex`, 'POST')
}

export async function deleteKnowledgeDocument(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  knowledgeBaseId: string,
  documentId: string,
): Promise<void> {
  await knowledgeVoidRequest(endpoint, employeeId, teamId, accessToken,
    `/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`, 'DELETE')
}

export async function searchKnowledge(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  query: string,
  knowledgeBaseIds: string[],
  knowledgeBaseRefs: string[] = [],
): Promise<KnowledgeSearchHit[]> {
  return knowledgeRequest(endpoint, employeeId, teamId, accessToken, '/search', 'POST', {
    query, knowledgeBaseIds, knowledgeBaseRefs, restrictToKnowledgeBaseRefs: false, limit: 8,
  })
}

async function knowledgeRequest<T>(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  suffix: string,
  method: 'POST',
  request?: object,
): Promise<T> {
  const response = await fetch(controlPlaneUrl(`${endpoint.replace(/\/$/, '')}${suffix}`), {
    method,
    headers: { ...knowledgeHeaders(employeeId, teamId, accessToken), ...(request ? { 'Content-Type': 'application/json' } : {}) },
    ...(request ? { body: JSON.stringify(request) } : {}),
  })
  if (!response.ok) throw new Error(`知识库操作返回 ${response.status}`)
  return response.json() as Promise<T>
}

async function knowledgeVoidRequest(
  endpoint: string,
  employeeId: string,
  teamId: string,
  accessToken: string,
  suffix: string,
  method: 'DELETE',
): Promise<void> {
  const response = await fetch(controlPlaneUrl(`${endpoint.replace(/\/$/, '')}${suffix}`), {
    method, headers: knowledgeHeaders(employeeId, teamId, accessToken),
  })
  if (!response.ok) throw new Error(`知识库删除操作返回 ${response.status}`)
}

async function scheduleRequest(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  suffix: string,
  method: 'POST',
  request?: CreateScheduledTaskRequest,
): Promise<ScheduledTask> {
  const response = await fetch(controlPlaneUrl(`${endpoint.replace(/\/$/, '')}${suffix}`), {
    method,
    headers: { ...enterpriseHeaders(employeeId, accessToken), ...(request ? { 'Content-Type': 'application/json' } : {}) },
    ...(request ? { body: JSON.stringify(request) } : {}),
  })
  if (!response.ok) throw new Error(`定时任务操作返回 ${response.status}`)
  return response.json() as Promise<ScheduledTask>
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

export function resolveControlPlaneEndpoint(path: string): string {
  return controlPlaneUrl(path)
}

function enterpriseHeaders(employeeId: string, accessToken: string): Record<string, string> {
  return {
    'X-Xiaoyin-Employee-Id': employeeId,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  }
}

function knowledgeHeaders(employeeId: string, teamId: string, accessToken: string): Record<string, string> {
  return {
    ...enterpriseHeaders(employeeId, accessToken),
    ...(teamId.trim() ? { 'X-Xiaoyin-Team-Id': teamId.trim() } : {}),
  }
}
