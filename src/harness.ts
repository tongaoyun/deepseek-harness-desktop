import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  CapabilitySnapshot,
  ConnectorDiagnosticResult,
  ConnectorRuntimeDefinition,
  LocalTaskAttachment,
  XiaoyinTaskProjection,
} from './types'
import type { StandardLocalDirectory } from './localFileIntent'
import type { TaskQuestionAnswer } from './types'

export interface HarnessRunInput {
  operationScope: string
  taskId: string
  prompt: string
  executionMode: 'agent' | 'plan'
  allowShell: boolean
  allowLsp: boolean
  allowExternalAgents: boolean
  allowHooks: boolean
  employeeId: string
  teamId: string
  sessionId?: string
  capabilitySnapshot: CapabilitySnapshot
  litellmBaseUrl: string
  knowledgeEndpoint: string
  scheduleEndpoint: string
  model: string
  reasoningEffort?: import('./modelReasoning').ReasoningEffort
  modelApiKey: string
  sessionToken: string
  localFileRootIds: string[]
  attachments: LocalTaskAttachment[]
}

export interface HarnessRunResult {
  sessionId: string
  finalResponse: string
  /** The employee stopped this turn; partial results are preserved. */
  interrupted?: boolean
}

export interface ConnectorDiagnosticInput {
  employeeId: string
  connectors: ConnectorRuntimeDefinition[]
  sessionToken: string
}

export interface LocalCapabilityCheck {
  key: string
  passed: boolean
  detail: string
}

export interface LocalCapabilitySelfTestResult {
  status: 'passed'
  checks: LocalCapabilityCheck[]
}

export interface HarnessHostHealth {
  status: string
  runtime: string
  version: string
  capabilities?: Record<string, 'enabled' | 'gated' | 'unconfigured'>
}

export interface HarnessProviderCheckResult {
  status: 'available' | 'unauthorized' | 'unreachable' | 'unconfigured'
  latencyMs: number
  detail: string
}

export interface HarnessSessionInspection {
  sessionId: string
  status: 'idle' | 'running' | 'completed' | 'failed' | 'unknown'
  updatedAt: string
  lastEventType?: string
  pendingTools: number
  projection?: XiaoyinTaskProjection
  /** Raw official Harness Session events for Conversation assembler replay. */
  events?: Array<Record<string, unknown>>
  messages?: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
}

export interface HarnessSessionSearchHit {
  sessionId: string
  excerpt: string
  updatedAt: string
}

export interface HarnessSessionSearchPage {
  items: HarnessSessionSearchHit[]
  nextCursor?: string
}

export type HarnessFailureCategory = 'timeout' | 'authentication' | 'capacity' | 'permission' | 'connector' | 'local-agent' | 'model' | 'unknown'

export interface HarnessFailure {
  category: HarnessFailureCategory
  code: string
  title: string
  message: string
  infrastructure: boolean
  retryable: boolean
}

export class HarnessFailureError extends Error {
  readonly failure: HarnessFailure

  constructor(value: HarnessFailure) {
    super(value.message)
    this.name = 'HarnessFailureError'
    this.failure = value
  }
}

export function classifyHarnessFailure(reason: unknown): HarnessFailure {
  const structured = structuredFailure(reason)
  if (structured) return structured
  const message = reason instanceof Error ? reason.message : String(reason)
  return failure('unknown', 'XY-UNSTRUCTURED-ERROR', '任务执行失败', message, false, false)
}

/** The only accepted retry metadata is the explicit Harness error envelope. */
function structuredFailure(reason: unknown): HarnessFailure | undefined {
  if (reason instanceof HarnessFailureError) return reason.failure
  if (!reason || typeof reason !== 'object') return undefined
  const root = reason as Record<string, unknown>
  const nested = root.error && typeof root.error === 'object' && !Array.isArray(root.error) ? root.error as Record<string, unknown> : undefined
  const value = nested ?? root
  const code = typeof value.code === 'string' ? value.code : undefined
  const message = typeof value.message === 'string' ? value.message : typeof value.detail === 'string' ? value.detail : undefined
  const category = value.category
  const retryable = value.retryable
  const title = value.title
  const infrastructure = value.infrastructure
  if (!code || !/^XY-[A-Z0-9-]+$/u.test(code) || !message || typeof title !== 'string' || typeof retryable !== 'boolean' || typeof infrastructure !== 'boolean' || !isFailureCategory(category)) return undefined
  return failure(category, code, title, message, infrastructure, retryable)
}

export function createHarnessFailure(value: Omit<HarnessFailure, 'message'> & { message?: string; detail?: string }): HarnessFailure {
  return failure(value.category, value.code, value.title, value.message ?? value.detail ?? '任务执行失败', value.infrastructure, value.retryable)
}

function isFailureCategory(value: unknown): value is HarnessFailureCategory {
  return ['timeout', 'authentication', 'capacity', 'permission', 'connector', 'local-agent', 'model', 'unknown'].includes(String(value))
}

export function shouldRetryHarnessFailure(failure: HarnessFailure, projection: XiaoyinTaskProjection): boolean {
  return failure.retryable && !projection.executionStarted
    && !projection.steps.some((step) => step.kind === 'tool' || step.kind === 'approval')
    && !(projection.timeline ?? []).some((entry) => entry.toolName || entry.kind === 'approval')
    && !(projection.subagents?.length)
}

function failure(
  category: HarnessFailureCategory,
  code: string,
  title: string,
  message: string,
  infrastructure: boolean,
  retryable: boolean,
): HarnessFailure {
  return { category, code, title, message, infrastructure, retryable }
}

export interface HarnessNotification {
  taskId?: string
  requestId: number
  streamId?: string
  sequence?: number
  event: unknown
}

export interface HarnessProjectionUpdate {
  sessionId: string
  key: string
  value: unknown
  seq: number
}

/** Reads the official Harness SessionProjection notification envelope. */
export function harnessProjectionUpdate(notification: HarnessNotification): HarnessProjectionUpdate | undefined {
  const event = asRecord(notification.event)
  if (event?.method !== 'session.projection') return undefined
  const params = asRecord(event.params)
  if (!params || typeof params.sessionId !== 'string' || typeof params.key !== 'string'
    || !Number.isSafeInteger(params.seq) || Number(params.seq) < -1 || !Object.hasOwn(params, 'value')) return undefined
  return { sessionId: params.sessionId, key: params.key, value: params.value, seq: Number(params.seq) }
}

export function normalizeHarnessProjection(value: unknown): XiaoyinTaskProjection | undefined {
  const projection = asRecord(value)
  if (!projection || !['idle', 'running', 'completed', 'failed', 'canceled'].includes(String(projection.status))
    || typeof projection.activity !== 'string' || typeof projection.updatedAt !== 'string'
    || !Array.isArray(projection.steps) || !Array.isArray(projection.artifacts)) return undefined
  const base = createXiaoyinTaskProjection(projection.updatedAt)
  const tokenUsage = normalizeTokenUsage(projection.tokenUsage)
  const contextPressure = normalizeContextPressure(projection.contextPressure)
  const outputRetention = normalizeOutputRetention(projection.outputRetention) ?? base.outputRetention
  const compactions = normalizeMetricInteger(projection.compactions)
  const interruption = normalizeInterruption(projection.interruption)
  const failure = normalizeFailure(projection.failure)
  const retry = normalizeRetry(projection.retry)
  return {
    status: projection.status as XiaoyinTaskProjection['status'],
    activity: projection.activity,
    updatedAt: projection.updatedAt,
    executionStarted: projection.executionStarted === true,
    ...(typeof projection.operationScope === 'string' ? { operationScope: projection.operationScope } : {}),
    ...(typeof projection.startedAt === 'string' ? { startedAt: projection.startedAt } : {}),
    ...(typeof projection.completedAt === 'string' ? { completedAt: projection.completedAt } : {}),
    steps: projection.steps as XiaoyinTaskProjection['steps'],
    timeline: Array.isArray(projection.timeline) ? projection.timeline as XiaoyinTaskProjection['timeline'] : [],
    subagents: Array.isArray(projection.subagents) ? projection.subagents as XiaoyinTaskProjection['subagents'] : [],
    changes: Array.isArray(projection.changes) ? projection.changes as XiaoyinTaskProjection['changes'] : [],
    artifacts: projection.artifacts as XiaoyinTaskProjection['artifacts'],
    visuals: Array.isArray(projection.visuals) ? projection.visuals as XiaoyinTaskProjection['visuals'] : [],
    knowledgeSources: Array.isArray(projection.knowledgeSources) ? projection.knowledgeSources as XiaoyinTaskProjection['knowledgeSources'] : [],
    outputRetention,
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(contextPressure ? { contextPressure } : {}),
    ...(compactions !== undefined ? { compactions } : {}),
    ...(interruption ? { interruption } : {}),
    ...(failure ? { failure } : {}),
    ...(retry ? { retry } : {}),
  }
}

function normalizeTokenUsage(value: unknown): XiaoyinTaskProjection['tokenUsage'] | undefined {
  const item = asRecord(value)
  if (!item) return undefined
  const uncachedInputTokens = normalizeMetricInteger(item.uncachedInputTokens)
  const outputTokens = normalizeMetricInteger(item.outputTokens)
  if (uncachedInputTokens === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = normalizeMetricInteger(item.cacheReadTokens)
  const cacheWriteTokens = normalizeMetricInteger(item.cacheWriteTokens)
  return { uncachedInputTokens, outputTokens, ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}), ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}) }
}

function normalizeContextPressure(value: unknown): XiaoyinTaskProjection['contextPressure'] | undefined {
  const item = asRecord(value)
  if (!item) return undefined
  const contextWindow = normalizeMetricInteger(item.contextWindow)
  const pressureTokens = normalizeMetricInteger(item.pressureTokens)
  const projectedTokens = normalizeMetricInteger(item.projectedTokens)
  if (contextWindow === undefined && pressureTokens === undefined && projectedTokens === undefined) return undefined
  return { ...(contextWindow !== undefined ? { contextWindow } : {}), ...(pressureTokens !== undefined ? { pressureTokens } : {}), ...(projectedTokens !== undefined ? { projectedTokens } : {}) }
}

function normalizeOutputRetention(value: unknown): XiaoyinTaskProjection['outputRetention'] | undefined {
  const item = asRecord(value)
  const prunedResults = normalizeMetricInteger(item?.prunedResults)
  const omittedTokens = normalizeMetricInteger(item?.omittedTokens)
  return prunedResults === undefined || omittedTokens === undefined ? undefined : { prunedResults, omittedTokens }
}

function normalizeInterruption(value: unknown): XiaoyinTaskProjection['interruption'] | undefined {
  const item = asRecord(value)
  if (!item || typeof item.checkpointAt !== 'string' || !['exit', 'failure', 'canceled'].includes(String(item.cause)) || !Array.isArray(item.pendingOperations)) return undefined
  const pendingOperations = item.pendingOperations.flatMap((entry) => {
    const operation = asRecord(entry)
    if (!operation || typeof operation.id !== 'string' || typeof operation.label !== 'string') return []
    return [{ id: operation.id, label: operation.label, ...(typeof operation.toolName === 'string' ? { toolName: operation.toolName } : {}) }]
  })
  return { checkpointAt: item.checkpointAt, cause: item.cause as 'exit' | 'failure' | 'canceled', pendingOperations }
}

function normalizeFailure(value: unknown): XiaoyinTaskProjection['failure'] | undefined {
  const item = asRecord(value)
  return item && typeof item.code === 'string' && typeof item.category === 'string' && typeof item.detail === 'string'
    ? {
      code: item.code,
      category: item.category,
      detail: item.detail,
      ...(typeof item.title === 'string' ? { title: item.title } : {}),
      ...(typeof item.infrastructure === 'boolean' ? { infrastructure: item.infrastructure } : {}),
      ...(typeof item.retryable === 'boolean' ? { retryable: item.retryable } : {}),
    }
    : undefined
}

function normalizeRetry(value: unknown): XiaoyinTaskProjection['retry'] | undefined {
  const item = asRecord(value)
  return item && Number.isSafeInteger(item.attempt) && Number(item.attempt) > 0
    && typeof item.code === 'string' && typeof item.title === 'string' && typeof item.detail === 'string'
    ? { attempt: Number(item.attempt), code: item.code, title: item.title, detail: item.detail }
    : undefined
}

function normalizeMetricInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

export interface AuthorizedLocalDirectory {
  id: string
  name: string
  path?: string
}

export interface DroppedPathAuthorization {
  directories: AuthorizedLocalDirectory[]
  attachments: LocalTaskAttachment[]
}

export async function runHarness(input: HarnessRunInput): Promise<HarnessRunResult> {
  if (!isTauri()) throw new Error('真实 Agent 执行只能在小胤桌面客户端中运行')
  const attachments = input.attachments.map(({ id, rootId, rootName, path, name, kind, mediaType }) => ({
    id, rootId, rootName, path, name, kind, ...(mediaType ? { mediaType } : {}),
  }))
  return invoke<HarnessRunResult>('run_harness', { request: { ...input, attachments } })
}

export async function diagnoseConnectors(
  input: ConnectorDiagnosticInput,
): Promise<ConnectorDiagnosticResult[]> {
  if (!isTauri()) throw new Error('实时连接器诊断只能在小胤桌面客户端中运行')
  return invoke<ConnectorDiagnosticResult[]>('diagnose_connectors', { request: input })
}

export async function selfTestLocalCapabilities(includeComputer = true): Promise<LocalCapabilitySelfTestResult> {
  if (!isTauri()) throw new Error('本地能力自检只能在小胤桌面客户端中运行')
  return invoke<LocalCapabilitySelfTestResult>('self_test_local_capabilities', { includeComputer })
}

export async function probeHarnessHost(modelConfigured = false, allowShell = true, allowLsp = false, allowExternalAgents = false, allowHooks = false): Promise<HarnessHostHealth> {
  if (!isTauri()) throw new Error('Harness Host 仅在小胤桌面客户端中运行')
  return invoke<HarnessHostHealth>('probe_harness_host', { modelConfigured, allowShell, allowLsp, allowExternalAgents, allowHooks })
}

export async function checkHarnessProvider(input: { litellmBaseUrl: string; model: string; modelApiKey: string }): Promise<HarnessProviderCheckResult> {
  if (!isTauri()) throw new Error('模型服务检查只能在小胤桌面客户端中运行')
  return invoke<HarnessProviderCheckResult>('check_harness_provider', { request: input })
}

export async function inspectHarnessSession(employeeId: string, sessionId: string): Promise<HarnessSessionInspection | undefined> {
  if (!isTauri()) return undefined
  return invoke<HarnessSessionInspection | undefined>('inspect_harness_session', { employeeId, sessionId })
}

export async function searchHarnessSessionsPage(employeeId: string, sessionIds: string[], query: string, limit = 100, cursor?: string): Promise<HarnessSessionSearchPage> {
  if (!isTauri()) return { items: [] }
  return invoke<HarnessSessionSearchPage>('search_harness_sessions', { employeeId, sessionIds, query, limit, cursor })
}

export async function searchHarnessSessions(employeeId: string, sessionIds: string[], query: string, limit = 100): Promise<HarnessSessionSearchHit[]> {
  return (await searchHarnessSessionsPage(employeeId, sessionIds, query, limit)).items
}

export function connectorDiagnosticsAvailable(): boolean {
  return isTauri()
}

export async function authorizeLocalDirectory(): Promise<AuthorizedLocalDirectory | null> {
  if (!isTauri()) throw new Error('本地文件夹授权只能在小胤桌面客户端中使用')
  return invoke<AuthorizedLocalDirectory | null>('authorize_local_directory')
}

export async function authorizeLocalFiles(): Promise<DroppedPathAuthorization> {
  if (!isTauri()) throw new Error('本地文件只能在小胤桌面客户端中选择')
  return invoke<DroppedPathAuthorization>('authorize_local_files')
}

export async function importPastedImage(file: File): Promise<DroppedPathAuthorization> {
  if (!isTauri()) throw new Error('截图粘贴请在小胤桌面客户端中使用')
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('截图粘贴支持 PNG 和 JPEG 图片')
  if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB')
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('读取剪贴板图片失败'))
    reader.readAsDataURL(file)
  })
  return invoke<DroppedPathAuthorization>('import_pasted_image', { data, mediaType: file.type })
}

export async function clipboardFilePaths(): Promise<string[]> {
  return isTauri() ? invoke<string[]>('clipboard_file_paths') : []
}

export async function importPastedFile(file: File): Promise<DroppedPathAuthorization> {
  if (!isTauri()) throw new Error('文件粘贴请在小胤桌面客户端中使用')
  if (['image/png', 'image/jpeg'].includes(file.type)) return importPastedImage(file)
  if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} 超过 25 MiB，请改用拖拽或选择文件`)
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    reader.readAsDataURL(file)
  })
  return invoke<DroppedPathAuthorization>('import_pasted_file', { name: file.name, data })
}

export async function authorizeStandardLocalDirectories(
  directories: StandardLocalDirectory[],
): Promise<AuthorizedLocalDirectory[]> {
  if (!isTauri() || directories.length === 0) return []
  return invoke<AuthorizedLocalDirectory[]>('authorize_standard_local_directories', {
    request: { directories },
  })
}

export async function revokeLocalDirectory(id: string): Promise<void> {
  if (!isTauri()) return
  await invoke('revoke_local_directory', { id })
}

export async function clearLocalDirectories(): Promise<void> {
  if (!isTauri()) return
  await invoke('clear_local_directories')
}

export async function restoreLocalDirectories(paths: string[]): Promise<AuthorizedLocalDirectory[]> {
  if (!isTauri() || paths.length === 0) return []
  return invoke<AuthorizedLocalDirectory[]>('restore_local_directories', { paths })
}

export async function shutdownHarness(taskId?: string): Promise<void> {
  if (!isTauri()) return
  await invoke('shutdown_harness', { taskId })
}

export async function cancelHarness(taskId: string): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('cancel_harness', { taskId })
}

/** Inject one employee message into the running turn's next step boundary. */
export async function steerHarness(taskId: string, prompt: string): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('steer_harness', { taskId, prompt })
}

/**
 * Fork the task's session before its last prompt so the last turn can be
 * re-run with the earlier context intact. Returns the new session id.
 */
export async function forkHarness(taskId: string): Promise<string> {
  if (!isTauri()) throw new Error('当前环境不支持重新生成')
  return invoke<string>('fork_harness', { taskId })
}

/** Ask the running turn to stop, keeping its partial results. */
export async function interruptHarness(taskId: string): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('interrupt_harness', { taskId })
}

export async function respondHarnessApproval(
  taskId: string,
  approvalId: string,
  decision: 'allow' | 'reject',
): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('respond_harness_approval', { taskId, approvalId, decision })
}

export async function respondHarnessQuestion(
  taskId: string,
  questionId: string,
  answers: TaskQuestionAnswer[],
): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('respond_harness_question', { taskId, questionId, answers })
}

export async function authorizeDroppedPaths(paths: string[]): Promise<DroppedPathAuthorization> {
  if (!isTauri() || paths.length === 0) return { directories: [], attachments: [] }
  return invoke<DroppedPathAuthorization>('authorize_dropped_paths', { paths })
}

export async function listenHarnessNotifications(
  listener: (event: HarnessNotification) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined
  return listen<HarnessNotification>('xiaoyin://harness-notification', ({ payload }) => listener(payload))
}

export function createXiaoyinTaskProjection(now = new Date().toISOString()): XiaoyinTaskProjection {
  return { status: 'idle', activity: '等待开始', updatedAt: now, steps: [], timeline: [], subagents: [], changes: [], artifacts: [], outputRetention: { prunedResults: 0, omittedTokens: 0 } }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
