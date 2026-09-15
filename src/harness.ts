import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { taskInterruption } from './taskInterruption'
import type {
  CapabilitySnapshot,
  ConnectorDiagnosticResult,
  ConnectorRuntimeDefinition,
  KnowledgeSearchHit,
  LocalTaskAttachment,
  SubagentActivity,
  TaskArtifact,
  TaskExecutionStep,
  TaskFileChange,
  XiaoyinTaskProjection,
  TaskQuestionAnswer,
  TaskQuestionItem,
  TaskTimelineEntry,
  TaskVisualArtifact,
  TaskMessage,
} from './types'
import type { StandardLocalDirectory } from './localFileIntent'

export interface HarnessRunInput {
  operationScope: string
  taskId: string
  prompt: string
  executionMode: 'agent' | 'plan'
  toolsMode: 'native' | 'ptc' | 'both'
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
  accessToken: string
  localFileRootIds: string[]
  attachments: LocalTaskAttachment[]
}

export interface HarnessRunResult {
  sessionId: string
  finalResponse: string
  outcome?: import('./taskOutcome').TaskOutcome
}

export interface ConnectorDiagnosticInput {
  employeeId: string
  connectors: ConnectorRuntimeDefinition[]
  accessToken: string
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
  messages?: Array<Pick<TaskMessage, 'id' | 'role' | 'text'>>
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

export function classifyHarnessFailure(reason: unknown): HarnessFailure {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (message.includes('[XY-OPERATION-UNCERTAIN]')) return failure('connector', 'XY-OPERATION-UNCERTAIN', '外部操作结果待核对', message, false, false)
  if (message.includes('[XY-CONNECTOR-AUTH]')) return failure('connector', 'XY-CONNECTOR-AUTH', '连接器需要重新授权', message, false, false)
  if (message.includes('[XY-CONNECTOR-PERMISSION]')) return failure('connector', 'XY-CONNECTOR-PERMISSION', '连接器访问受限', message, false, false)
  if (message.includes('[XY-CONNECTOR]')) return failure('connector', 'XY-CONNECTOR', '连接器调用失败', message, false, false)
  if (/任务执行超过|timed?\s*out|timeout/iu.test(message)) return failure('timeout', 'XY-TIMEOUT', '任务运行超时', message, false, false)
  if (/401|unauthorized|认证失败|invalid.*key/iu.test(message)) return failure('authentication', 'XY-AUTH', '模型认证失败', message, false, false)
  if (/429|rate.?limit|服务繁忙|capacity|overloaded/iu.test(message)) return failure('capacity', 'XY-CAPACITY', '模型服务繁忙', message, false, true)
  if (/permission|denied|权限|未授权|approval.*reject/iu.test(message)) return failure('permission', 'XY-PERMISSION', '操作未获授权', message, false, false)
  if (/MCP|connector|连接器|tool.*(unavailable|not found)|unknown tool/iu.test(message)) return failure('connector', 'XY-CONNECTOR', '连接器调用失败', message, false, false)
  if (/Harness Host|ECONNRESET|ECONNREFUSED|broken pipe|socket hang up|进程.*退出|connection.*closed/iu.test(message)) {
    return failure('local-agent', 'XY-LOCAL-AGENT', '本地 Agent 异常', message, true, true)
  }
  if (/模型|provider|assistant|turn/iu.test(message)) return failure('model', 'XY-MODEL', '模型未能完成任务', message, false, true)
  return failure('unknown', 'XY-UNKNOWN', '任务执行失败', message, false, false)
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
  const outcome = normalizeOutcome(projection.outcome)
  const failure = normalizeFailure(projection.failure)
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
    ...(outcome ? { outcome } : {}),
    ...(failure ? { failure } : {}),
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

function normalizeOutcome(value: unknown): XiaoyinTaskProjection['outcome'] | undefined {
  const item = asRecord(value)
  if (!item || !['completed', 'partial', 'needs_input', 'needs_confirmation', 'blocked', 'unverified'].includes(String(item.status)) || typeof item.summary !== 'string' || !Array.isArray(item.remaining) || item.remaining.some((entry) => typeof entry !== 'string') || !Array.isArray(item.checks)) return undefined
  const checks = item.checks.flatMap((entry) => {
    const check = asRecord(entry)
    if (!check || typeof check.description !== 'string' || typeof check.evidence !== 'string' || !['passed', 'failed', 'not_run'].includes(String(check.result))) return []
    return [{ description: check.description, result: check.result as 'passed' | 'failed' | 'not_run', evidence: check.evidence }]
  })
  return { status: item.status as NonNullable<XiaoyinTaskProjection['outcome']>['status'], summary: item.summary, remaining: item.remaining as string[], checks }
}

function normalizeFailure(value: unknown): XiaoyinTaskProjection['failure'] | undefined {
  const item = asRecord(value)
  return item && typeof item.code === 'string' && typeof item.category === 'string' && typeof item.detail === 'string'
    ? { code: item.code, category: item.category, detail: item.detail }
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
  return invoke<HarnessRunResult>('run_harness', { request: input })
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

export async function probeHarnessHost(modelConfigured = false, allowShell = true, allowLsp = false, allowExternalAgents = false, allowHooks = false, toolsMode: 'native' | 'ptc' | 'both' = 'native'): Promise<HarnessHostHealth> {
  if (!isTauri()) throw new Error('Harness Host 仅在小胤桌面客户端中运行')
  return invoke<HarnessHostHealth>('probe_harness_host', { modelConfigured, allowShell, allowLsp, allowExternalAgents, allowHooks, toolsMode })
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

export function harnessActivityLabel(notification: HarnessNotification): string {
  const parsed = parseHarnessEvent(notification)
  if (!parsed) return '正在分析任务'

  if (parsed.type === 'tool/call') {
    const toolName = text(parsed.data.name)
    return toolName ? `正在${toolActivityLabel(toolName)}` : '正在调用业务工具'
  }
  if (parsed.method.includes('status')) {
    const status = text(parsed.params.status)
    if (status === 'idle') return '正在整理结果'
  }
  if (parsed.type === 'assistant/message' || parsed.type === 'text-chunks' || parsed.method.includes('message')) return '正在生成回复'
  return '正在分析任务'
}

export interface HarnessResponseUpdate {
  key: string
  mode: 'append' | 'replace' | 'clear'
  text: string
}

/** Visible assistant text only. Reasoning events and tool payloads never enter the reply. */
export function harnessResponseUpdate(notification: HarnessNotification): HarnessResponseUpdate | undefined {
  const parsed = parseHarnessEvent(notification)
  if (!parsed || !parsed.isRootSession) return undefined
  // Tool calls are a separate Codex-style activity item. Keep any assistant
  // text already streamed above it visible; clearing it makes the transcript
  // flash and then disappear while the tool is running.
  if (parsed.type === 'tool/call') return undefined
  if (parsed.type === 'assistant/stream' && parsed.data.type === 'start') return { key: '', mode: 'clear', text: '' }
  const key = 'assistant:visible-response'
  if (parsed.type === 'text-chunks') {
    const delta = Array.isArray(parsed.data.texts)
      ? parsed.data.texts.filter((value): value is string => typeof value === 'string').join('')
      : ''
    return delta ? { key, mode: 'append', text: delta } : undefined
  }
  if (parsed.type === 'assistant/message') {
    const message = assistantMessageText(parsed.data)
    return message ? { key, mode: 'replace', text: message } : undefined
  }
  return undefined
}

/** Keep receipts for already-started tools while Stop is settling, not late text/status. */
export function applyStoppingHarnessNotification(current: XiaoyinTaskProjection, notification: HarnessNotification): XiaoyinTaskProjection {
  const parsed = parseHarnessEvent(notification)
  if (!parsed?.isRootSession || parsed.type !== 'tool/result') return current
  const result = toolResult(parsed.data)
  if (!result || !current.steps.some((step) => step.id === `tool:${result.callId}` && step.status === 'running')) return current
  const next = applyHarnessNotification(current, notification)
  return { ...next, status: current.status, activity: current.activity }
}

export function applyHarnessNotification(
  current: XiaoyinTaskProjection,
  notification: HarnessNotification,
): XiaoyinTaskProjection {
  const parsed = parseHarnessEvent(notification)
  if (!parsed) return current
  // This fact survives bounded display history and includes delegated tool activity.
  if (['tool/call', 'tool/result', 'approval/request', 'question/request'].includes(parsed.type)) current = { ...current, executionStarted: true }
  if (!parsed.isRootSession) return {
    ...current,
    status: current.status === 'idle' ? 'running' : current.status,
    activity: '子 Agent 正在处理',
    updatedAt: eventTime(parsed.event),
  }
  const occurredAt = eventTime(parsed.event)
  const turn = integer(parsed.data.turn) ?? 0
  const step = integer(parsed.data.step) ?? 0
  const activity = harnessActivityLabel(notification)

  if (parsed.type === 'step/start') {
    return updateProjection(current, activity, upsertStep(current.steps, {
      id: `analysis:${turn}:${step}`,
      kind: 'analysis',
      label: step === 1 ? '分析任务' : '整理工具结果',
      status: 'running',
      startedAt: occurredAt,
    }), occurredAt)
  }

  if (parsed.type === 'text-chunks') {
    const delta = Array.isArray(parsed.data.texts)
      ? parsed.data.texts.filter((value): value is string => typeof value === 'string').join('')
      : ''
    if (!delta) return current
    return {
      ...updateProjection(current, activity, current.steps, occurredAt),
      timeline: appendTimelineText(current.timeline ?? [], `assistant:${turn}:${step}`, delta, occurredAt),
    }
  }

  if (parsed.type === 'assistant/message') {
    const message = assistantMessageText(parsed.data)
    const next = updateProjection(current, activity,
      completeStep(current.steps, `analysis:${turn}:${step}`, 'completed', occurredAt), occurredAt)
    return message ? {
      ...next,
      timeline: upsertTimeline(current.timeline ?? [], {
        id: `assistant:${turn}:${step}`,
        kind: 'assistant',
        label: '说明',
        text: message,
        status: 'completed',
        occurredAt,
      }),
    } : next
  }

  if (parsed.type === 'tool/call') {
    const callId = text(parsed.data.callId)
    const toolName = text(parsed.data.name)
    if (!callId || !toolName) return current
    const analysisCompleted = completeStep(current.steps, `analysis:${turn}:${step}`, 'completed', occurredAt)
    const presentation = toolPresentation(toolName, parsed.data.arguments)
    const subagents = toolName === 'subagent'
      ? upsertSubagent(current.subagents ?? [], {
        id: callId,
        label: presentation.label,
        status: 'running',
        startedAt: occurredAt,
      })
      : current.subagents
    return {
      ...updateProjection(current, activity, upsertStep(analysisCompleted, {
      id: `tool:${callId}`,
      kind: 'tool',
      label: toolActivityLabel(toolName),
      status: 'running',
      toolName,
      startedAt: occurredAt,
      }), occurredAt),
      timeline: upsertTimeline(current.timeline ?? [], {
        id: `tool:${callId}`,
        ...presentation,
        status: 'running',
        toolName,
        occurredAt,
      }),
      ...(subagents === undefined ? {} : { subagents }),
    }
  }

  if (parsed.type === 'tool/result') {
    const result = toolResult(parsed.data)
    if (!result) return current
    const toolName = current.steps.find((item) => item.id === `tool:${result.callId}`)?.toolName
    const artifact = !result.failed && toolName
      ? artifactFromToolResult(toolName, result.content, occurredAt)
      : undefined
    const artifacts = artifact
      ? [...current.artifacts.filter((item) => item.id !== artifact.id), artifact].slice(-50)
      : current.artifacts
    const newVisuals = !result.failed && toolName
      ? visualsFromToolResult(toolName, result.content, occurredAt)
      : []
    const visualIds = new Set(newVisuals.map((item) => item.id))
    const visuals = newVisuals.length
      ? [...(current.visuals ?? []).filter((item) => !visualIds.has(item.id)), ...newVisuals].slice(-20)
      : current.visuals
    const change = !result.failed && toolName
      ? fileChangeFromToolResult(toolName, result.content, occurredAt)
      : undefined
    const changes = change ? upsertFileChange(current.changes ?? [], change) : current.changes
    const presentation = toolName ? toolResultPresentation(toolName, result.content, result.failed) : {}
    const subagents = toolName === 'subagent'
      ? completeSubagent(current.subagents ?? [], result.callId, result.failed ? 'failed' : 'completed', occurredAt)
      : current.subagents
    return {
      ...updateProjection(current, activity,
        completeStep(current.steps, `tool:${result.callId}`, result.failed ? 'failed' : 'completed', occurredAt), occurredAt),
      timeline: completeTimeline(
        current.timeline ?? [], `tool:${result.callId}`, result.failed ? 'failed' : 'completed', occurredAt, presentation,
      ),
      artifacts,
      ...(!result.failed && toolName === 'knowledge_search' ? { knowledgeSources: mergeKnowledgeSources(current.knowledgeSources ?? [], result.content) } : {}),
      ...(visuals === undefined ? {} : { visuals }),
      ...(changes === undefined ? {} : { changes }),
      ...(subagents === undefined ? {} : { subagents }),
    }
  }

  if (parsed.type === 'error' || parsed.type === 'warning' || parsed.type.endsWith('/error')) {
    const detail = publicEventError(parsed.data)
    const kind = parsed.type === 'warning' ? 'warning' : 'error'
    return {
      ...current,
      activity: kind === 'error' ? '任务执行遇到问题' : current.activity,
      updatedAt: occurredAt,
      timeline: upsertTimeline(current.timeline ?? [], {
        id: `${kind}:${turn ?? 'session'}:${step ?? Date.parse(occurredAt)}`,
        kind,
        label: kind === 'error' ? '执行遇到问题' : '注意',
        status: kind === 'error' ? 'failed' : 'completed',
        ...(detail ? { detail } : {}),
        occurredAt,
        completedAt: occurredAt,
      }),
    }
  }

  if (parsed.type === 'approval/request') {
    const approvalId = text(parsed.data.approvalId)
    const toolName = text(parsed.data.name)
    if (!approvalId || !toolName) return current
    return {
      ...updateProjection(current, `等待确认：${toolActivityLabel(toolName)}`, upsertStep(current.steps, {
        id: `approval:${approvalId}`,
        kind: 'approval',
        label: `确认${toolActivityLabel(toolName)}`,
        status: 'running',
        toolName,
        startedAt: occurredAt,
      }), occurredAt),
      timeline: upsertTimeline(current.timeline ?? [], {
        id: `approval:${approvalId}`,
        kind: 'approval',
        label: `需要确认：${toolActivityLabel(toolName)}`,
        status: 'running',
        toolName,
        approvalId,
        ...(bounded(text(parsed.data.reason), 2_000) ? { detail: bounded(text(parsed.data.reason), 2_000) } : {}),
        occurredAt,
      }),
    }
  }

  if (parsed.type === 'approval/decision') {
    const approvalId = text(parsed.data.approvalId)
    const toolName = text(parsed.data.name)
    const decision = text(parsed.data.decision)
    if (!approvalId || !toolName || !['allow', 'reject'].includes(decision ?? '')) return current
    const allowed = decision === 'allow'
    return {
      ...updateProjection(current, activity, upsertStep(current.steps, {
      id: `approval:${approvalId}`,
      kind: 'approval',
      label: `${allowed ? '已允许' : '已拒绝'}${toolActivityLabel(toolName)}`,
      status: allowed ? 'completed' : 'failed',
      toolName,
      startedAt: occurredAt,
      completedAt: occurredAt,
      }), occurredAt),
      timeline: upsertTimeline(current.timeline ?? [], {
        id: `approval:${approvalId}`,
        kind: 'approval',
        label: `${allowed ? '已允许' : '已拒绝'}${toolActivityLabel(toolName)}`,
        status: allowed ? 'completed' : 'failed',
        toolName,
        approvalId,
        occurredAt,
        completedAt: occurredAt,
      }),
    }
  }

  if (parsed.type === 'question/request') {
    const questionId = text(parsed.data.questionId)
    const questions = parseTaskQuestions(parsed.data.questions)
    if (!questionId || questions.length === 0) return current
    const planReview = questions.some((question) => question.intent?.kind === 'plan-review')
    return {
      ...current,
      status: 'running',
      activity: planReview ? '等待你审阅计划' : '等待你回答',
      updatedAt: occurredAt,
      timeline: upsertTimeline(current.timeline ?? [], {
        id: `question:${questionId}`,
        kind: 'question',
        label: planReview ? '计划审阅' : '需要你的回答',
        status: 'running',
        questionId,
        questions,
        occurredAt,
      }),
    }
  }

  if (parsed.type === 'question/answered') {
    const questionId = text(parsed.data.questionId)
    if (!questionId) return current
    return {
      ...current,
      activity,
      updatedAt: occurredAt,
      timeline: completeTimeline(current.timeline ?? [], `question:${questionId}`, 'completed', occurredAt),
    }
  }

  if (parsed.type === 'compaction/start' || parsed.type === 'compaction/end') {
    const count = (current.compactions ?? 0) + (parsed.type === 'compaction/end' ? 1 : 0)
    return {
      ...current,
      activity: parsed.type === 'compaction/start' ? '正在整理上下文' : current.activity,
      updatedAt: occurredAt,
      compactions: count,
      timeline: upsertTimeline(current.timeline ?? [], {
        id: `compaction:${text(parsed.data.compactionId) ?? `${turn}:${step}`}`,
        kind: 'tool',
        label: parsed.type === 'compaction/start' ? '整理上下文' : '上下文整理完成',
        status: parsed.type === 'compaction/start' ? 'running' : 'completed',
        occurredAt,
        completedAt: parsed.type === 'compaction/end' ? occurredAt : undefined,
      }),
    }
  }

  if (parsed.type === 'compaction/prune') {
    const shadowedSeqs = Array.isArray(parsed.data.shadowedSeqs) ? parsed.data.shadowedSeqs.length : 1
    const shadowedTokenCount = integer(parsed.data.shadowedTokenCount) ?? 0
    const currentRetention = current.outputRetention ?? { prunedResults: 0, omittedTokens: 0 }
    return {
      ...updateProjection(current, '正在整理工具结果', current.steps, occurredAt),
      outputRetention: {
        prunedResults: currentRetention.prunedResults + shadowedSeqs,
        omittedTokens: currentRetention.omittedTokens + shadowedTokenCount,
      },
      timeline: upsertTimeline(current.timeline ?? [], {
        id: `retention:${Array.isArray(parsed.data.shadowedSeqs) ? parsed.data.shadowedSeqs.join(',') : `${turn}:${step}`}`,
        kind: 'tool', label: '裁剪工具结果', status: 'completed',
        detail: `${shadowedSeqs} 项${shadowedTokenCount > 0 ? `，约 ${shadowedTokenCount} tokens` : ''}`,
        occurredAt, completedAt: occurredAt,
      }),
    }
  }

  if (parsed.type === 'turn/end') {
    const reason = text(asRecord(parsed.data.reason)?.kind)
    const status = reason === 'completed' ? 'completed' : 'failed'
    const interruption = taskInterruption(current, 'failure', occurredAt)
    const settled = current.steps.map((item): TaskExecutionStep => item.status === 'running'
      ? { ...item, status: item.kind === 'tool' ? 'canceled' : status, completedAt: occurredAt }
      : item)
    const timeline = (current.timeline ?? []).map((item): TaskTimelineEntry => item.status === 'running'
      ? { ...item, status: item.toolName && item.kind !== 'approval' ? 'canceled' : status }
      : item)
    const subagents = (current.subagents ?? []).map((item): SubagentActivity => item.status === 'running'
      ? { ...item, status, completedAt: occurredAt }
      : item)
    return {
      ...current,
      ...(status === 'failed' || interruption.pendingOperations.length ? { interruption } : {}),
      status,
      activity: status === 'completed' ? '本轮已结束' : '任务执行失败',
      updatedAt: occurredAt,
      completedAt: occurredAt,
      timeline,
      subagents,
      steps: upsertStep(settled, {
      id: `response:${turn}`,
      kind: 'response',
      label: status === 'completed' ? '完成回复' : '执行未完成',
      status,
      startedAt: occurredAt,
      completedAt: occurredAt,
      }),
    }
  }

  return current
}

export function createXiaoyinTaskProjection(now = new Date().toISOString()): XiaoyinTaskProjection {
  return { status: 'idle', activity: '等待开始', updatedAt: now, steps: [], timeline: [], subagents: [], changes: [], artifacts: [], outputRetention: { prunedResults: 0, omittedTokens: 0 } }
}

function updateProjection(
  current: XiaoyinTaskProjection,
  activity: string,
  steps: TaskExecutionStep[],
  updatedAt: string,
): XiaoyinTaskProjection {
  return { ...current, status: 'running', activity, steps, updatedAt }
}

function parseHarnessEvent(notification: HarnessNotification): {
  method: string
  params: Record<string, unknown>
  event: Record<string, unknown>
  type: string
  data: Record<string, unknown>
  isRootSession: boolean
} | undefined {
  const envelope = asRecord(notification.event)
  const wireEvent = asRecord(envelope?.event)
  const method = text(wireEvent?.method) ?? ''
  const params = asRecord(wireEvent?.params) ?? {}
  const event = asRecord(params.event) ?? {}
  const rootSessionId = text(envelope?.rootSessionId)
  const eventSessionId = text(params.sessionId)
  return {
    method,
    params,
    event,
    type: text(event.type) ?? '',
    data: asRecord(event.data) ?? {},
    isRootSession: !rootSessionId || !eventSessionId || rootSessionId === eventSessionId,
  }
}

function toolResult(data: Record<string, unknown>): { callId: string; failed: boolean; content: unknown } | undefined {
  const message = asRecord(data.message)
  const content = Array.isArray(message?.content) ? message.content : []
  for (const blockValue of content) {
    const block = asRecord(blockValue)
    if (block?.type !== 'tool-result') continue
    const callId = text(block.toolCallId)
    if (callId) return { callId, failed: block.isError === true, content: block.content }
  }
  return undefined
}

const ARTIFACT_TOOLS = new Set([
  'office.docx.create', 'office.xlsx.create', 'office.pdf.create',
  'office_docx_create', 'office_xlsx_create', 'office_xlsx_update_cells', 'office_xlsx_append_rows',
  'office_xlsx_add_sheet', 'office_xlsx_format_sheet', 'office_pptx_create', 'office_pdf_create',
  'office_document_export_pdf', 'office_xlsx_recalculate',
  'local_files_publish',
])

const FILE_CHANGE_TOOLS = new Set([
  ...[...ARTIFACT_TOOLS].filter((tool) => tool !== 'local_files_publish'),
  'local_files_write_text', 'local_files_copy', 'local_files_move',
  'local_files_delete',
])

function fileChangeFromToolResult(toolName: string, content: unknown, changedAt: string): TaskFileChange | undefined {
  if (!FILE_CHANGE_TOOLS.has(toolName)) return undefined
  const value = toolResultValue(content)
  if (!value) return undefined
  const rootId = text(value.rootId)
  const rootName = text(value.rootName)
  const path = text(value.path) ?? text(value.destination)
  if (!rootId || !rootName || !path || path === '.' || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return undefined
  const name = path.split('/').filter(Boolean).at(-1)
  if (!name) return undefined
  const addedLines = nonNegativeInteger(value.addedLines)
  const deletedLines = nonNegativeInteger(value.deletedLines)
  return {
    id: `${rootId}:${path}`,
    rootId,
    rootName,
    path,
    name,
    sourceTool: toolName,
    action: fileChangeAction(toolName, value),
    ...(text(value.afterHash) ? { afterHash: text(value.afterHash) } : {}),
    ...(text(value.beforeHash) ? { beforeHash: text(value.beforeHash) } : {}),
    ...(text(value.source) ? { previousPath: text(value.source) } : {}),
    ...(text(value.backupPath) ? { backupPath: text(value.backupPath) } : {}),
    ...(addedLines === undefined ? {} : { addedLines }),
    ...(deletedLines === undefined ? {} : { deletedLines }),
    changedAt,
  }
}

function fileChangeAction(toolName: string, value: Record<string, unknown>): TaskFileChange['action'] {
  if (toolName === 'local_files_copy') return 'copied'
  if (toolName === 'local_files_move') return 'moved'
  if (toolName === 'local_files_delete') return 'deleted'
  if (text(value.action) === 'updated' || text(value.backupPath)) return 'updated'
  return 'created'
}

function upsertFileChange(current: TaskFileChange[], next: TaskFileChange): TaskFileChange[] {
  const index = current.findIndex((item) => item.id === next.id)
  if (index < 0) return [...current, next].slice(-100)
  return current.map((item, itemIndex): TaskFileChange => {
    if (itemIndex !== index) return item
    // Review the whole turn from the first baseline to the final file. Summing
    // intermediate edits can never reliably describe that final diff.
    const action: TaskFileChange['action'] = next.action === 'deleted'
      ? 'deleted'
      : item.action === 'created' || item.action === 'copied' || item.action === 'moved' || item.action === 'deleted' ? item.action : next.action
    return {
      ...item,
      ...next,
      action,
      backupPath: item.backupPath,
      beforeHash: item.beforeHash,
      afterHash: next.afterHash,
      addedLines: undefined,
      deletedLines: undefined,
    }
  }).slice(-100)
}

function artifactFromToolResult(toolName: string, content: unknown, createdAt: string): TaskArtifact | undefined {
  if (!ARTIFACT_TOOLS.has(toolName)) return undefined
  const value = toolResultValue(content)
  if (!value) return undefined
  const rootId = text(value.rootId)
  const rootName = text(value.rootName)
  const path = text(value.path) ?? text(value.destination)
  if (!rootId || !rootName || !path || path === '.' || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return undefined
  const name = path.split('/').filter(Boolean).at(-1)
  if (!name) return undefined
  const extension = name.split('.').at(-1)?.toLowerCase()
  const kind = /\.(png|jpe?g|webp|gif|bmp)$/i.test(name) ? 'image' : extension === 'xlsx' || extension === 'xls' || extension === 'csv'
    ? 'spreadsheet'
    : extension === 'pptx'
      ? 'presentation'
      : extension === 'pdf'
      ? 'pdf'
      : extension === 'doc' || extension === 'docx'
        ? 'document'
        : extension === 'txt' || extension === 'md'
          ? 'text'
          : 'file'
  const sizeBytes = typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
    ? value.size
    : undefined
  return {
    id: `${rootId}:${path}`,
    rootId,
    rootName,
    path,
    name,
    kind,
    sourceTool: toolName,
    action: artifactAction(toolName, value),
    ...(text(value.backupPath) ? { backupPath: text(value.backupPath) } : {}),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    createdAt,
  }
}

function artifactAction(toolName: string, value: Record<string, unknown>): TaskArtifact['action'] {
  if (toolName === 'local_files_publish') return 'published'
  if (toolName === 'local_files_copy') return 'copied'
  if (toolName === 'local_files_move') return 'moved'
  return text(value.backupPath) ? 'updated' : 'created'
}

function visualsFromToolResult(toolName: string, content: unknown, createdAt: string): TaskVisualArtifact[] {
  const blocks = Array.isArray(content) ? content : []
  const visuals = new Map<string, TaskVisualArtifact>()
  for (const value of blocks) {
    const block = asRecord(value)
    const attachment = asRecord(block?.attachment)
    const attachmentId = text(attachment?.attachmentId)
    const mediaType = text(attachment?.mediaType)
    const width = nonNegativeInteger(attachment?.width)
    const height = nonNegativeInteger(attachment?.height)
    if (block?.type !== 'image' || !attachmentId?.match(/^sha256:[a-f0-9]{64}$/u)
      || (mediaType !== 'image/png' && mediaType !== 'image/jpeg') || !width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)) continue
    const id = `${toolName}:${attachmentId}`
    visuals.set(id, {
      id,
      attachmentId,
      mediaType,
      name: text(attachment?.name) ?? (toolName === 'browser_screenshot' ? '网页截图' : toolName.startsWith('computer_use_') ? '桌面截图' : '工具返回图片'),
      width,
      height,
      sourceTool: toolName,
      createdAt,
    })
  }
  return [...visuals.values()]
}

function mergeKnowledgeSources(previous: KnowledgeSearchHit[], content: unknown): KnowledgeSearchHit[] {
  const sources = new Map(previous.map((hit) => [hit.sourceId, hit]))
  for (const value of Array.isArray(content) ? content : []) {
    const block = asRecord(value)
    if (typeof block?.text !== 'string') continue
    try {
      const hits: unknown = JSON.parse(block.text)
      for (const raw of Array.isArray(hits) ? hits.slice(0, 20) : []) {
        const hit = asRecord(raw)
        if (!hit || typeof hit.sourceId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(hit.sourceId)) continue
        if (!['knowledgeBaseId', 'knowledgeBaseName', 'documentId', 'filename', 'locator', 'content'].every((key) => typeof hit[key] === 'string')) continue
        sources.set(hit.sourceId, { sourceId: hit.sourceId, knowledgeBaseId: String(hit.knowledgeBaseId).slice(0, 64),
          knowledgeBaseName: String(hit.knowledgeBaseName).slice(0, 120), documentId: String(hit.documentId).slice(0, 64),
          filename: String(hit.filename).slice(0, 255), locator: String(hit.locator).slice(0, 500), content: String(hit.content).slice(0, 1600),
          score: typeof hit.score === 'number' && Number.isFinite(hit.score) ? hit.score : 0 })
      }
    } catch { /* Ignore non-JSON tool text, never infer references from model prose. */ }
  }
  return [...sources.values()].slice(-24)
}

function toolResultValue(content: unknown): Record<string, unknown> | undefined {
  const blocks = Array.isArray(content) ? content : []
  for (const value of blocks) {
    const block = asRecord(value)
    const serialized = text(block?.text)
    if (!serialized) continue
    try {
      const parsed = JSON.parse(serialized)
      const record = asRecord(parsed)
      if (record) return record
    } catch { /* only structured JSON emitted by an allowlisted local tool is accepted */ }
  }
  return undefined
}

function upsertStep(current: TaskExecutionStep[], next: TaskExecutionStep): TaskExecutionStep[] {
  const index = current.findIndex((item) => item.id === next.id)
  const updated = index < 0
    ? [...current, next]
    : current.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item)
  return updated.slice(-100)
}

function completeStep(
  current: TaskExecutionStep[],
  id: string,
  status: 'completed' | 'failed',
  completedAt: string,
): TaskExecutionStep[] {
  return current.map((item) => item.id === id && item.status === 'running'
    ? { ...item, status, completedAt }
    : item)
}

function upsertSubagent(current: SubagentActivity[], next: SubagentActivity): SubagentActivity[] {
  const index = current.findIndex((item) => item.id === next.id)
  return (index < 0
    ? [...current, next]
    : current.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item)).slice(-20)
}

function completeSubagent(
  current: SubagentActivity[],
  id: string,
  status: 'completed' | 'failed',
  completedAt: string,
): SubagentActivity[] {
  return current.map((item) => item.id === id ? { ...item, status, completedAt } : item)
}

function assistantMessageText(data: Record<string, unknown>): string {
  const message = asRecord(data.message)
  const content = Array.isArray(message?.content) ? message.content : []
  return content.map((value) => {
    const block = asRecord(value)
    return block?.type === 'text' ? text(block.text) ?? '' : ''
  }).join('').trim()
}

function upsertTimeline(current: TaskTimelineEntry[], next: TaskTimelineEntry): TaskTimelineEntry[] {
  const index = current.findIndex((item) => item.id === next.id)
  return (index < 0
    ? [...current, next]
    : current.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item)).slice(-100)
}

function completeTimeline(
  current: TaskTimelineEntry[],
  id: string,
  status: 'completed' | 'failed',
  completedAt: string,
  patch: Partial<TaskTimelineEntry> = {},
): TaskTimelineEntry[] {
  return current.map((item) => item.id === id ? { ...item, ...patch, status, completedAt } : item)
}

function appendTimelineText(
  current: TaskTimelineEntry[],
  id: string,
  delta: string,
  occurredAt: string,
): TaskTimelineEntry[] {
  const existing = current.find((item) => item.id === id)
  return upsertTimeline(current, {
    id,
    kind: 'assistant',
    label: '回复',
    status: 'running',
    text: `${existing?.text ?? ''}${delta}`,
    occurredAt: existing?.occurredAt ?? occurredAt,
  })
}

function toolActivityLabel(toolName: string): string {
  const known = ({
    skill: '加载专家技能',
    order_get: '查询订单',
    sales_summary: '查询销售汇总',
    inventory_risk: '查询库存风险',
    knowledge_list: '读取知识库目录',
    knowledge_search: '检索企业知识库',
    'office.document.read': '读取 Office 文档',
    'office.docx.create': '生成 Word 文档',
    'office.xlsx.create': '生成 Excel 表格',
    'office.pdf.create': '生成 PDF 文档',
    office_document_read: '读取 Office 文档',
    office_document_check: '检查交付文档',
    office_engine_status: '检查文档转换能力',
    office_document_export_pdf: '导出 PDF 副本',
    office_xlsx_recalculate: '重算表格副本',
    office_pdf_page: '查看 PDF 页面',
    computer_use_observe: '观察桌面', computer_use_click: '点击应用', computer_use_type: '输入文字',
    computer_use_key: '发送按键', computer_use_scroll: '滚动界面',
    office_docx_create: '生成 Word 文档',
    office_xlsx_create: '生成 Excel 表格',
    office_xlsx_update_cells: '修改 Excel 表格',
    office_xlsx_append_rows: '追加 Excel 数据',
    office_xlsx_add_sheet: '添加 Excel 工作表',
    office_xlsx_format_sheet: '调整表格排版',
    office_pptx_create: '生成 PowerPoint 演示文稿',
    office_pdf_create: '生成 PDF 文档',
    local_files_roots: '检查工作目录',
    local_files_list: '查看目录内容',
    local_files_search: '搜索本地文件',
    local_files_read_text: '读取本地文件',
    local_files_publish: '准备交付文件',
    present: '声明交付文件',
    local_files_write_text: '修改本地文件',
    local_files_create_directory: '新建文件夹',
    local_files_copy: '复制本地文件',
    local_files_move: '移动本地文件',
    local_files_delete: '删除本地文件',
    bash: '运行 Bash 命令',
    pwsh: '运行 PowerShell 命令',
    terminal_open: '打开持久终端',
    terminal_send: '发送终端命令',
    terminal_read: '读取终端输出',
    terminal_signal: '控制终端进程',
    terminal_close: '关闭持久终端',
    terminal_list: '查看持久终端',
    job_output: '读取后台任务',
    job_list: '查看后台任务',
    job_kill: '停止后台任务',
    schedule_create: '创建会话提醒',
    schedule_list: '查看会话提醒',
    schedule_delete: '取消会话提醒',
    schedules_list: '查询定时任务',
    schedules_create: '创建定时任务',
    schedules_update: '修改定时任务',
    schedules_pause: '暂停定时任务',
    schedules_resume: '恢复定时任务',
    schedules_delete: '删除定时任务',
    todo_write: '更新任务清单',
    workflow: '执行工作流',
    web_search: '搜索网页资料',
    web_fetch: '读取网页内容',
    exit_plan_mode: '提交计划审阅',
    get_goal: '查看任务目标',
    task_report: '整理交付结果',
    create_goal: '创建任务目标',
    update_goal: '更新任务目标',
    session_search: '查询历史会话',
    session_event_search: '查询会话事件',
    session_trace: '查看会话关系',
    session_event_trace: '查看事件关系',
    session_event_read: '读取会话事件',
    list_agents: '查看子 Agent',
    subagent: '委派子任务',
    browser_open: '打开网页',
    browser_snapshot: '读取网页',
    browser_click: '操作网页',
    browser_click_text: '操作网页',
    browser_click_point: '操作网页',
    browser_type: '填写网页内容',
    browser_press_key: '操作网页键盘',
    browser_wait_for: '等待网页内容',
    browser_reload: '刷新网页',
    browser_downloads: '查看下载文件',
  } as Record<string, string>)[toolName]
  if (known) return known
  if (toolName.startsWith('mcp_')) {
    const connector = toolName.slice(4).split('_')[0]
    return connector ? `使用 ${connector} 连接器` : '调用连接器'
  }
  return `调用 ${toolName}`
}

function toolPresentation(toolName: string, rawArguments: unknown): Pick<TaskTimelineEntry,
  'kind' | 'label' | 'detail' | 'text' | 'path' | 'secondaryPath' | 'connectorName'> {
  const args = toolArguments(rawArguments)
  const path = firstText(args, 'path', 'workdir')
  const destination = firstText(args, 'destinationPath')
  if (toolName === 'bash' || toolName === 'pwsh') return compact({
    kind: 'command', label: '运行命令', detail: firstText(args, 'description'), path,
    text: bounded(firstText(args, 'command'), 16_000),
  })
  if (toolName === 'subagent') return compact({
    kind: 'subagent', label: firstText(args, 'description') ?? '委派子任务',
  })
  if (toolName === 'subagent_fork' || toolName.startsWith('subagent_')) return compact({
    kind: 'subagent', label: firstText(args, 'description') ?? '委派子任务',
  })
  if (toolName === 'web_search' || toolName === 'web_fetch') return compact({
    kind: 'browser', label: toolActivityLabel(toolName), detail: firstText(args, 'query', 'url'),
  })
  if (toolName === 'todo_write' || toolName === 'workflow' || toolName === 'exit_plan_mode') return compact({
    kind: 'tool', label: toolActivityLabel(toolName), detail: firstText(args, 'description', 'name'),
  })
  if (toolName.startsWith('session_')) return compact({
    kind: 'tool', label: toolActivityLabel(toolName), detail: '结果按当前工作目录与会话权限过滤',
  })
  if (toolName === 'job_list' || toolName === 'job_output' || toolName === 'job_kill') return compact({
    kind: 'tool', label: toolActivityLabel(toolName), detail: '后台任务状态由 Harness Jobs 统一管理',
  })
  if (toolName === 'schedule_create' || toolName === 'schedule_list' || toolName === 'schedule_delete') return compact({
    kind: 'tool', label: toolActivityLabel(toolName), detail: '提醒由 Harness Session 持久化，仅在当前会话内投递',
  })
  if (toolName.startsWith('schedules_')) return compact({
    kind: 'tool', label: toolActivityLabel(toolName), detail: '计划由小胤本机调度器管理',
  })
  if (toolName.startsWith('terminal_')) return compact({
    kind: 'command', label: toolActivityLabel(toolName), detail: firstText(args, 'description', 'input', 'command'),
  })
  const fileLabels: Record<string, string> = {
    local_files_roots: '检查可用工作目录',
    local_files_list: path ? `查看 ${path === '.' ? '目录' : path}` : '查看目录',
    local_files_search: `搜索“${firstText(args, 'query') ?? '文件'}”`,
    local_files_read_text: path ? `读取 ${path}` : '读取文件',
    local_files_publish: path ? `准备交付 ${path}` : '准备交付文件',
    local_files_write_text: path ? `写入 ${path}` : '写入文件',
    local_files_create_directory: path ? `创建 ${path}` : '创建文件夹',
    local_files_copy: destination ? `复制到 ${destination}` : '复制文件',
    local_files_move: destination ? `移动到 ${destination}` : '移动文件',
    local_files_delete: path ? `删除 ${path}` : '删除文件',
    office_document_read: path ? `读取 ${path}` : '读取 Office 文档',
    office_docx_create: path ? `生成 ${path}` : '生成 Word 文档',
    office_xlsx_create: path ? `生成 ${path}` : '生成 Excel 表格',
    office_xlsx_update_cells: path ? `修改 ${path}` : '修改 Excel 表格',
    office_xlsx_append_rows: path ? `追加数据到 ${path}` : '追加 Excel 数据',
    office_xlsx_add_sheet: path ? `添加工作表到 ${path}` : '添加 Excel 工作表',
    office_xlsx_format_sheet: path ? `调整 ${path} 的排版` : '调整表格排版',
    office_pptx_create: path ? `生成 ${path}` : '生成 PowerPoint 演示文稿',
    office_pdf_create: path ? `生成 ${path}` : '生成 PDF 文档',
    office_document_export_pdf: path ? `将 ${path} 导出为 PDF 副本` : '导出 PDF 副本',
    office_xlsx_recalculate: path ? `重算 ${path} 并保存副本` : '重算表格副本',
  }
  if (fileLabels[toolName]) return compact({
    kind: 'file', label: fileLabels[toolName], path: firstText(args, 'path', 'sourcePath'), secondaryPath: destination,
  })
  if (toolName.startsWith('browser_')) return compact({
    kind: 'browser', label: toolActivityLabel(toolName), detail: firstText(args, 'url'),
  })
  if (toolName.startsWith('mcp_')) {
    const connectorName = connectorNameFromTool(toolName)
    return compact({ kind: 'connector', label: `使用 ${connectorName}`, connectorName, detail: connectorAction(toolName) })
  }
  return { kind: 'tool', label: toolActivityLabel(toolName) }
}

function toolResultPresentation(
  toolName: string,
  content: unknown,
  failed: boolean,
): Partial<TaskTimelineEntry> {
  const value = toolResultValue(content)
  if (toolName === 'bash' || toolName === 'pwsh') {
    const output = toolResultText(content)
    const exitCode = output.match(/\[exit code: (\d+)]\s*$/)?.[1]
    return compact({
      output: bounded(output.replace(/\n?\[exit code: \d+]\s*$/, '').trim(), 12_000),
      detail: failed ? publicToolError(content) : exitCode === undefined ? undefined : `退出码 ${exitCode}`,
    })
  }
  if (failed) return compact({ detail: publicToolError(content), path: text(value?.path) })
  if (toolName === 'local_files_list' && value) {
    const entries = Array.isArray(value.entries) ? value.entries : []
    return compact({
      path: text(value.directory), itemCount: entries.length,
      detail: `${entries.length} 项${value.truncated === true ? '（仅显示部分）' : ''}`,
    })
  }
  if (toolName === 'local_files_search' && value) {
    const matches = Array.isArray(value.matches) ? value.matches : []
    return compact({
      path: text(value.directory), itemCount: matches.length,
      detail: `找到 ${matches.length} 项${value.truncated === true ? '（仅显示部分）' : ''}`,
    })
  }
  if (toolName.startsWith('session_')) return compact({
    detail: failed ? publicToolError(content) : '查询完成，结果仅在当前任务上下文中使用',
  })
  if (toolName === 'job_list' || toolName === 'job_output' || toolName === 'job_kill') return compact({
    detail: failed ? publicToolError(content) : '已同步 Harness 后台任务状态',
  })
  if (toolName === 'schedule_create' || toolName === 'schedule_list' || toolName === 'schedule_delete') return compact({
    detail: failed ? publicToolError(content) : '已同步当前会话提醒',
  })
  if (toolName.startsWith('schedules_')) return compact({
    detail: failed ? publicToolError(content) : '已同步本机定时任务',
  })
  if (toolName.startsWith('local_files_') || toolName.startsWith('office_')) {
    if (!value) return failed ? { detail: publicToolError(content) } : {}
    return compact({
      path: text(value.path) ?? text(value.source), secondaryPath: text(value.destination),
      detail: typeof value.size === 'number' ? formatBytes(value.size) : undefined,
    })
  }
  return failed ? compact({ detail: publicToolError(content) }) : {}
}

function parseTaskQuestions(value: unknown): TaskQuestionItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): TaskQuestionItem[] => {
    const question = asRecord(item)
    const id = text(question?.id)
    const prompt = text(question?.question)
    if (!id || !prompt) return []
    const options = Array.isArray(question?.options) ? question.options.flatMap((item) => {
      const option = asRecord(item)
      const label = text(option?.label)
      if (!label) return []
      const description = text(option?.description)
      return [{ label, ...(description ? { description } : {}) }]
    }) : undefined
    const intentValue = asRecord(question?.intent)
    const approve = text(intentValue?.approve)
    const intent = intentValue?.kind === 'plan-review' && approve
      ? { kind: 'plan-review' as const, approve }
      : undefined
    const header = text(question?.header)
    const detail = text(question?.detail)
    return [{
      id, question: prompt,
      ...(header ? { header } : {}), ...(detail ? { detail } : {}),
      ...(options ? { options } : {}), ...(question?.multiSelect === true ? { multiSelect: true } : {}),
      ...(intent ? { intent } : {}),
    }]
  })
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || value.length > 100_000) return {}
  try { return asRecord(JSON.parse(value)) ?? {} } catch { return {} }
}

function firstText(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = text(value[key])
    if (found) return found
  }
  return undefined
}

function connectorNameFromTool(toolName: string): string {
  const value = toolName.slice(4).split('_')[0]?.trim()
  return value ? humanize(value) : '连接器'
}

function connectorAction(toolName: string): string | undefined {
  const parts = toolName.slice(4).split('_')
  return parts.length > 1 ? humanize(parts.slice(1).join(' ')) : undefined
}

function humanize(value: string): string {
  return value.replaceAll(/[-_]+/g, ' ').trim()
}

function publicEventError(data: Record<string, unknown>): string | undefined {
  return bounded(firstText(data, 'message', 'error', 'detail'), 1_000)
}

function publicToolError(content: unknown): string | undefined {
  return bounded(toolResultText(content), 1_000)
}

function toolResultText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : []
  return blocks.map((item) => text(asRecord(item)?.text)).filter(Boolean).join('\n')
}

function bounded(value: string | undefined, length: number): string | undefined {
  if (!value) return undefined
  return value.length <= length ? value : `${value.slice(0, length)}…`
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`
  return `${(value / 1_048_576).toFixed(1)} MB`
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== '')) as T
}

function eventTime(event: Record<string, unknown>): string {
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
  return new Date(time).toISOString()
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
