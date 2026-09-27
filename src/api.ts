import { readServerData, readServerPage } from './serverResponse'
import type {
  BootstrapResponse,
  ConnectorCatalogEntry,
  ExpertKitCatalogEntry,
  ExpertKitDownload,
  SkillCatalogEntry,
  KnowledgeBaseEntry,
  KnowledgeDocumentEntry,
  KnowledgeSearchHit,
  DeviceHeartbeatContext,
  InstalledExtensionSnapshot,
  AuditEventEntry,
  SubmitAuditEvent,
} from './types'

const DEFAULT_XIAOYIN_SERVER = 'http://192.168.2.67:30081'

export async function loadBootstrap(employeeId = 'local-development', sessionToken = '', signal?: AbortSignal): Promise<BootstrapResponse> {
  const response = await fetch(serverUrl('/api/v1/bootstrap'), {
    headers: enterpriseHeaders(employeeId, sessionToken),
    signal: boundedSignal(signal),
  })
  if (!response.ok) {
    throw new Error(`控制中心返回 ${response.status}`)
  }
  return readServerData<BootstrapResponse>(response)
}

export async function loadExpertKits(
  endpoint: string,
  employeeId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<ExpertKitCatalogEntry[]> {
  return loadAllServerPages(endpoint, enterpriseHeaders(employeeId, sessionToken), '专家套件目录', signal)
}

/** The catalog listing stays light, so a kit's own guide is fetched when its details are opened. */
export async function loadExpertKitReadme(
  endpoint: string,
  kitId: string,
  employeeId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = endpoint.replace(/\/$/, '')
  const response = await fetch(serverUrl(`${base}/${encodeURIComponent(kitId)}/readme`), {
    headers: enterpriseHeaders(employeeId, sessionToken),
    signal: boundedSignal(signal),
  })
  if (!response.ok) throw new Error(`套件说明返回 ${response.status}`)
  return readServerData<{ readme?: string }>(response).then((value) => value.readme ?? '')
}

export async function createExpertKitDownload(
  endpoint: string,
  kitId: string,
  employeeId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<ExpertKitDownload> {
  const base = endpoint.replace(/\/$/, '')
  const response = await fetch(serverUrl(`${base}/${encodeURIComponent(kitId)}/artifacts`), {
    headers: enterpriseHeaders(employeeId, sessionToken),
    signal: boundedSignal(signal, 30_000),
  })
  if (!response.ok) throw new Error(`专家套件下载授权返回 ${response.status}`)
  return readServerData<ExpertKitDownload>(response)
}

export async function loadSkills(
  endpoint: string,
  employeeId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<SkillCatalogEntry[]> {
  return loadCatalog(endpoint, employeeId, sessionToken, '技能目录', signal)
}

export async function createSkillDownload(
  endpoint: string,
  skillId: string,
  employeeId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<ExpertKitDownload> {
  const base = endpoint.replace(/\/$/, '')
  const response = await fetch(serverUrl(`${base}/${encodeURIComponent(skillId)}/artifacts`), {
    headers: enterpriseHeaders(employeeId, sessionToken),
    signal: boundedSignal(signal, 30_000),
  })
  if (!response.ok) throw new Error(`技能下载授权返回 ${response.status}`)
  return readServerData<ExpertKitDownload>(response)
}

export async function loadConnectors(
  endpoint: string,
  employeeId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<ConnectorCatalogEntry[]> {
  return loadCatalog(endpoint, employeeId, sessionToken, '连接器目录', signal)
}

export async function submitDeviceHeartbeat(
  endpoint: string,
  employeeId: string,
  sessionToken: string,
  request: DeviceHeartbeatContext & { installedExtensions: InstalledExtensionSnapshot[] },
): Promise<void> {
  const response = await fetch(serverUrl(`${endpoint.replace(/\/$/, '')}/presence`), {
    method: 'POST',
    headers: { ...enterpriseHeaders(employeeId, sessionToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: boundedSignal(),
  })
  if (!response.ok) throw new Error(`设备心跳上报返回 ${response.status}`)
}

export async function submitDeviceCapabilityReport(
  endpoint: string,
  employeeId: string,
  sessionToken: string,
  request: DeviceHeartbeatContext & {
    capabilities: Array<{ key: string; status: 'READY' | 'DEGRADED' | 'UNSUPPORTED'; detail: string }>
  },
): Promise<void> {
  const response = await fetch(serverUrl(endpoint.replace(/\/$/, '')), {
    method: 'POST',
    headers: { ...enterpriseHeaders(employeeId, sessionToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: boundedSignal(),
  })
  if (!response.ok) throw new Error(`设备能力上报返回 ${response.status}`)
}

export async function submitAuditEvent(
  endpoint: string,
  employeeId: string,
  sessionToken: string,
  event: SubmitAuditEvent,
): Promise<AuditEventEntry> {
  const response = await fetch(serverUrl(endpoint), {
    method: 'POST',
    headers: { ...enterpriseHeaders(employeeId, sessionToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    signal: boundedSignal(),
  })
  if (!response.ok) throw new Error(`审计事件上报返回 ${response.status}`)
  return readServerData<AuditEventEntry>(response)
}

export async function submitFeedback(
  employeeId: string,
  sessionToken: string,
  message: string,
  context: { category: 'BUG' | 'SUGGESTION' | 'QUESTION' | 'OTHER'; desktopVersion?: string; deviceId?: string; taskId?: string },
  images: File[] = [],
): Promise<void> {
  const body = new FormData()
  body.append('feedback', new Blob([JSON.stringify({ message, ...context })], { type: 'application/json' }))
  images.forEach((file) => body.append('images', file))
  const response = await fetch(serverUrl('/api/v1/feedback'), {
    method: 'POST',
    headers: enterpriseHeaders(employeeId, sessionToken),
    body,
    signal: AbortSignal.timeout(45_000),
  }).catch((reason) => {
    if (reason instanceof Error && /Timeout|Abort/.test(reason.name)) throw new Error('提交超时，暂未确认是否收到，请先在控制中心核实后再重试')
    throw new Error('无法连接反馈服务，请检查网络后重试')
  })
  if (response.status === 401 || response.status === 403) throw new Error('登录已失效或没有提交权限，请重新登录')
  if (response.status === 413) throw new Error('图片超过服务端上传限制，请减少图片后重试')
  if (!response.ok) throw new Error(`反馈提交返回 ${response.status}`)
  const result = await readServerData<{ id?: string }>(response)
  if (!result.id) throw new Error('未收到反馈编号，请检查服务连接')
}

export async function loadKnowledgeBases(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<KnowledgeBaseEntry[]> {
  return loadAllServerPages(endpoint, knowledgeHeaders(employeeId, teamId, sessionToken), '知识库', signal)
}

export async function createKnowledgeBase(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  request: { name: string; description: string; referenceKey: string; scope: KnowledgeBaseEntry['scope'] },
  idempotencyKey: string = crypto.randomUUID(),
): Promise<KnowledgeBaseEntry> {
  return knowledgeRequest(endpoint, employeeId, teamId, sessionToken, '', 'POST', request, idempotencyKey)
}

export async function deleteKnowledgeBase(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  knowledgeBaseId: string,
): Promise<void> {
  await knowledgeVoidRequest(endpoint, employeeId, teamId, sessionToken, `/${encodeURIComponent(knowledgeBaseId)}`, 'DELETE')
}

export async function loadKnowledgeDocuments(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  knowledgeBaseId: string,
  signal?: AbortSignal,
): Promise<KnowledgeDocumentEntry[]> {
  return loadAllServerPages(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(knowledgeBaseId)}/documents`,
    knowledgeHeaders(employeeId, teamId, sessionToken), '知识库文档', signal)
}

export async function uploadKnowledgeDocument(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  knowledgeBaseId: string,
  file: File,
  signal?: AbortSignal,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<KnowledgeDocumentEntry> {
  const form = new FormData()
  form.append('file', file, file.name)
  const response = await fetch(serverUrl(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(knowledgeBaseId)}/documents`), {
    method: 'POST', headers: { ...knowledgeHeaders(employeeId, teamId, sessionToken), 'Idempotency-Key': idempotencyKey }, body: form,
    signal: boundedSignal(signal, 120_000),
  })
  if (!response.ok) throw new Error(`知识库文档上传返回 ${response.status}`)
  return readServerData<KnowledgeDocumentEntry>(response)
}

export async function reindexKnowledgeDocument(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  knowledgeBaseId: string,
  documentId: string,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<KnowledgeDocumentEntry> {
  return knowledgeRequest(endpoint, employeeId, teamId, sessionToken,
    `/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}/index-jobs`, 'POST', undefined, idempotencyKey)
}

export async function deleteKnowledgeDocument(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  knowledgeBaseId: string,
  documentId: string,
): Promise<void> {
  await knowledgeVoidRequest(endpoint, employeeId, teamId, sessionToken,
    `/${encodeURIComponent(knowledgeBaseId)}/documents/${encodeURIComponent(documentId)}`, 'DELETE')
}

export async function searchKnowledge(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  query: string,
  knowledgeBaseIds: string[],
  knowledgeBaseRefs: string[] = [],
): Promise<KnowledgeSearchHit[]> {
  return knowledgeRequest('/api/v1/knowledge-searches', employeeId, teamId, sessionToken, '', 'POST', {
    query, knowledgeBaseIds, knowledgeBaseRefs, restrictToKnowledgeBaseRefs: false, limit: 8,
  })
}

export interface KnowledgeSourceContext { endpoint: string; employeeId: string; teamId: string; sessionToken: string }

export async function loadKnowledgeSource(context: KnowledgeSourceContext, sourceId: string, signal?: AbortSignal): Promise<KnowledgeSearchHit> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId)) throw new Error('原文引用无效，请重新检索')
  const response = await fetch(serverUrl(`${context.endpoint.replace(/\/$/, '')}/sources/${sourceId}`), {
    headers: knowledgeHeaders(context.employeeId, context.teamId, context.sessionToken), signal: boundedSignal(signal),
  })
  if (response.status === 404) throw new Error('原文已删除、正在重建或已更新，请重新检索。历史摘录不能作为当前依据。')
  if (!response.ok) throw new Error(`原文暂时无法读取（${response.status}），请重试。`)
  return readServerData<KnowledgeSearchHit>(response)
}

async function knowledgeRequest<T>(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  suffix: string,
  method: 'POST',
  request?: object,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(serverUrl(`${endpoint.replace(/\/$/, '')}${suffix}`), {
    method,
    signal: boundedSignal(),
    headers: { ...knowledgeHeaders(employeeId, teamId, sessionToken), ...(request ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    ...(request ? { body: JSON.stringify(request) } : {}),
  })
  if (!response.ok) throw new Error(`知识库操作返回 ${response.status}`)
  return readServerData<T>(response)
}

async function knowledgeVoidRequest(
  endpoint: string,
  employeeId: string,
  teamId: string,
  sessionToken: string,
  suffix: string,
  method: 'DELETE',
): Promise<void> {
  const response = await fetch(serverUrl(`${endpoint.replace(/\/$/, '')}${suffix}`), {
    method, headers: knowledgeHeaders(employeeId, teamId, sessionToken), signal: boundedSignal(),
  })
  if (!response.ok) throw new Error(`知识库删除操作返回 ${response.status}`)
}

async function loadCatalog<T>(
  endpoint: string,
  employeeId: string,
  sessionToken: string,
  label: string,
  signal?: AbortSignal,
): Promise<T[]> {
  return loadAllServerPages(endpoint, enterpriseHeaders(employeeId, sessionToken), label, signal)
}

async function loadAllServerPages<T>(endpoint: string, headers: Record<string, string>, label: string,
  signal?: AbortSignal): Promise<T[]> {
  const items: T[] = []
  let page = 1
  let totalPages = 1
  do {
    const url = new URL(serverUrl(endpoint), typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
    url.searchParams.set('page', String(page))
    url.searchParams.set('size', '100')
    const response = await fetch(url.toString(), { headers, signal: boundedSignal(signal) })
    if (!response.ok) throw new Error(`${label}返回 ${response.status}`)
    const result = await readServerPage<T>(response)
    items.push(...result.items)
    totalPages = Math.max(0, result.totalPages)
    page += 1
  } while (page <= totalPages)
  return items
}

function serverUrl(path: string, browserRequest = true): string {
  const baseUrl = import.meta.env.VITE_XIAOYIN_SERVER_URL ?? DEFAULT_XIAOYIN_SERVER
  const url = new URL(path, `${baseUrl.replace(/\/$/, '')}/`)
  if (browserRequest && import.meta.env.DEV && import.meta.env.VITE_XIAOYIN_DEV_PROXY === 'true'
    && url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/api/')) {
    return new URL(`${url.pathname}${url.search}`, window.location.origin).toString()
  }
  return url.toString()
}

function boundedSignal(signal?: AbortSignal, timeoutMs = 12_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export function resolveServerEndpoint(path: string): string {
  return serverUrl(path, false)
}

function enterpriseHeaders(employeeId: string, sessionToken: string): Record<string, string> {
  return {
    'X-Xiaoyin-Employee-Id': employeeId,
    'X-Requested-With': 'XMLHttpRequest',
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  }
}

function knowledgeHeaders(employeeId: string, teamId: string, sessionToken: string): Record<string, string> {
  return {
    ...enterpriseHeaders(employeeId, sessionToken),
    ...(teamId.trim() ? { 'X-Xiaoyin-Team-Id': teamId.trim() } : {}),
  }
}

// Stable local storage namespace, not a server API. Preserve existing plans across server changes.
export function localScheduleNamespace(): string {
  return serverUrl('/api/v1/schedules', false)
}
