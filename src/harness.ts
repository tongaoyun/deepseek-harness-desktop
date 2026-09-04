import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AllowedExtensionArtifact,
  ConnectorDiagnosticResult,
  ConnectorRuntimeDefinition,
  LocalTaskAttachment,
  SubagentActivity,
  TaskArtifact,
  TaskExecutionStep,
  TaskFileChange,
  TaskMonitorState,
  TaskTimelineEntry,
} from './types'
import type { StandardLocalDirectory } from './localFileIntent'

export interface HarnessRunInput {
  taskId: string
  prompt: string
  employeeId: string
  teamId: string
  sessionId?: string
  selectedExtension?: { kind: 'expert-kit' | 'skill'; id: string }
  knowledgeBaseRefs: string[]
  allowedArtifacts: AllowedExtensionArtifact[]
  litellmBaseUrl: string
  knowledgeEndpoint: string
  scheduleEndpoint: string
  connectors: ConnectorRuntimeDefinition[]
  model: string
  modelApiKey: string
  accessToken: string
  localFileRootIds: string[]
  attachments: LocalTaskAttachment[]
}

export interface HarnessRunResult {
  sessionId: string
  finalResponse: string
}

export interface ConnectorDiagnosticInput {
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
}

export type HarnessFailureCategory = 'timeout' | 'authentication' | 'capacity' | 'permission' | 'connector' | 'local-agent' | 'model' | 'unknown'

export interface HarnessFailure {
  category: HarnessFailureCategory
  title: string
  message: string
  infrastructure: boolean
}

export function classifyHarnessFailure(reason: unknown): HarnessFailure {
  const message = reason instanceof Error ? reason.message : String(reason)
  if (/任务执行超过|timed?\s*out|timeout/iu.test(message)) return { category: 'timeout', title: '任务运行超时', message, infrastructure: false }
  if (/401|unauthorized|认证失败|invalid.*key/iu.test(message)) return { category: 'authentication', title: '模型认证失败', message, infrastructure: false }
  if (/429|rate.?limit|服务繁忙|capacity|overloaded/iu.test(message)) return { category: 'capacity', title: '模型服务繁忙', message, infrastructure: false }
  if (/permission|denied|权限|未授权|approval.*reject/iu.test(message)) return { category: 'permission', title: '操作未获授权', message, infrastructure: false }
  if (/MCP|connector|连接器|tool.*(unavailable|not found)|unknown tool/iu.test(message)) return { category: 'connector', title: '连接器调用失败', message, infrastructure: false }
  if (/Harness Host|ECONNRESET|ECONNREFUSED|broken pipe|socket hang up|进程.*退出|connection.*closed/iu.test(message)) {
    return { category: 'local-agent', title: '本地 Agent 异常', message, infrastructure: true }
  }
  if (/模型|provider|assistant|turn/iu.test(message)) return { category: 'model', title: '模型未能完成任务', message, infrastructure: false }
  return { category: 'unknown', title: '任务执行失败', message, infrastructure: false }
}

export interface HarnessNotification {
  taskId?: string
  requestId: number
  event: unknown
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

export async function selfTestLocalCapabilities(): Promise<LocalCapabilitySelfTestResult> {
  if (!isTauri()) throw new Error('本地能力自检只能在小胤桌面客户端中运行')
  return invoke<LocalCapabilitySelfTestResult>('self_test_local_capabilities')
}

export async function probeHarnessHost(): Promise<HarnessHostHealth> {
  if (!isTauri()) throw new Error('Harness Host 仅在小胤桌面客户端中运行')
  return invoke<HarnessHostHealth>('probe_harness_host')
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
  const turn = integer(parsed.data.turn)
  const step = integer(parsed.data.step)
  if (parsed.type === 'tool/call') return { key: '', mode: 'clear', text: '' }
  if (turn === undefined || step === undefined) return undefined
  const key = `assistant:${turn}:${step}`
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

export function applyHarnessNotification(
  current: TaskMonitorState,
  notification: HarnessNotification,
): TaskMonitorState {
  const parsed = parseHarnessEvent(notification)
  if (!parsed) return current
  if (!parsed.isRootSession) return {
    ...current,
    status: current.status === 'idle' ? 'running' : current.status,
    activity: '子 Agent 正在处理',
    updatedAt: eventTime(parsed.event),
  }
  const occurredAt = eventTime(parsed.event)
  const turn = integer(parsed.data.turn)
  const step = integer(parsed.data.step)
  const activity = harnessActivityLabel(notification)

  if (parsed.type === 'step/start' && turn !== undefined && step !== undefined) {
    return updateMonitor(current, activity, upsertStep(current.steps, {
      id: `analysis:${turn}:${step}`,
      kind: 'analysis',
      label: step === 1 ? '分析任务' : '整理工具结果',
      status: 'running',
      startedAt: occurredAt,
    }), occurredAt)
  }

  if (parsed.type === 'text-chunks' && turn !== undefined && step !== undefined) {
    const delta = Array.isArray(parsed.data.texts)
      ? parsed.data.texts.filter((value): value is string => typeof value === 'string').join('')
      : ''
    if (!delta) return current
    return {
      ...updateMonitor(current, activity, current.steps, occurredAt),
      timeline: appendTimelineText(current.timeline ?? [], `assistant:${turn}:${step}`, delta, occurredAt),
    }
  }

  if (parsed.type === 'assistant/message' && turn !== undefined && step !== undefined) {
    const message = assistantMessageText(parsed.data)
    const next = updateMonitor(current, activity,
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
    const analysisCompleted = turn === undefined || step === undefined
      ? current.steps
      : completeStep(current.steps, `analysis:${turn}:${step}`, 'completed', occurredAt)
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
      ...updateMonitor(current, activity, upsertStep(analysisCompleted, {
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
    const change = !result.failed && toolName
      ? fileChangeFromToolResult(toolName, result.content, occurredAt)
      : undefined
    const changes = change ? upsertFileChange(current.changes ?? [], change) : current.changes
    const presentation = toolName ? toolResultPresentation(toolName, result.content, result.failed) : {}
    const subagents = toolName === 'subagent'
      ? completeSubagent(current.subagents ?? [], result.callId, result.failed ? 'failed' : 'completed', occurredAt)
      : current.subagents
    return {
      ...updateMonitor(current, activity,
        completeStep(current.steps, `tool:${result.callId}`, result.failed ? 'failed' : 'completed', occurredAt), occurredAt),
      timeline: completeTimeline(
        current.timeline ?? [], `tool:${result.callId}`, result.failed ? 'failed' : 'completed', occurredAt, presentation,
      ),
      artifacts,
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

  if (parsed.type === 'approval/decision') {
    const approvalId = text(parsed.data.approvalId)
    const toolName = text(parsed.data.name)
    const decision = text(parsed.data.decision)
    if (!approvalId || !toolName || !['allow', 'reject'].includes(decision ?? '')) return current
    const allowed = decision === 'allow'
    return {
      ...updateMonitor(current, activity, upsertStep(current.steps, {
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
        occurredAt,
      }),
    }
  }

  if (parsed.type === 'turn/end' && turn !== undefined) {
    const reason = text(asRecord(parsed.data.reason)?.kind)
    const status = reason === 'completed' ? 'completed' : 'failed'
    const settled = current.steps.map((item): TaskExecutionStep => item.status === 'running'
      ? { ...item, status, completedAt: occurredAt }
      : item)
    const timeline = (current.timeline ?? []).map((item): TaskTimelineEntry => item.status === 'running'
      ? { ...item, status }
      : item)
    const subagents = (current.subagents ?? []).map((item): SubagentActivity => item.status === 'running'
      ? { ...item, status, completedAt: occurredAt }
      : item)
    return {
      ...current,
      status,
      activity: status === 'completed' ? '任务已完成' : '任务执行失败',
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

export function createTaskMonitor(now = new Date().toISOString()): TaskMonitorState {
  return { status: 'idle', activity: '等待开始', updatedAt: now, steps: [], timeline: [], subagents: [], changes: [], artifacts: [] }
}

function updateMonitor(
  current: TaskMonitorState,
  activity: string,
  steps: TaskExecutionStep[],
  updatedAt: string,
): TaskMonitorState {
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
  'office_xlsx_add_sheet', 'office_pptx_create', 'office_pdf_create',
  'local_files_write_text', 'local_files_copy', 'local_files_move',
])

const FILE_CHANGE_TOOLS = new Set([
  ...ARTIFACT_TOOLS,
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
    ...(text(value.source) ? { previousPath: text(value.source) } : {}),
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
  return current.map((item, itemIndex) => itemIndex !== index ? item : {
    ...item,
    ...next,
    addedLines: addOptionalCounts(item.addedLines, next.addedLines),
    deletedLines: addOptionalCounts(item.deletedLines, next.deletedLines),
  }).slice(-100)
}

function addOptionalCounts(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return left + right
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
  const kind = extension === 'xlsx' || extension === 'xls' || extension === 'csv'
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
  if (toolName === 'local_files_copy') return 'copied'
  if (toolName === 'local_files_move') return 'moved'
  return text(value.backupPath) ? 'updated' : 'created'
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
    office_docx_create: '生成 Word 文档',
    office_xlsx_create: '生成 Excel 表格',
    office_xlsx_update_cells: '修改 Excel 表格',
    office_xlsx_append_rows: '追加 Excel 数据',
    office_xlsx_add_sheet: '添加 Excel 工作表',
    office_pptx_create: '生成 PowerPoint 演示文稿',
    office_pdf_create: '生成 PDF 文档',
    local_files_roots: '检查工作目录',
    local_files_list: '查看目录内容',
    local_files_search: '搜索本地文件',
    local_files_read_text: '读取本地文件',
    local_files_write_text: '修改本地文件',
    local_files_create_directory: '新建文件夹',
    local_files_copy: '复制本地文件',
    local_files_move: '移动本地文件',
    local_files_delete: '删除本地文件',
    bash: '运行 Bash 命令',
    pwsh: '运行 PowerShell 命令',
    job_output: '读取后台任务',
    job_list: '查看后台任务',
    job_kill: '停止后台任务',
    get_goal: '查看任务目标',
    create_goal: '创建任务目标',
    update_goal: '更新任务目标',
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
  const fileLabels: Record<string, string> = {
    local_files_roots: '检查可用工作目录',
    local_files_list: path ? `查看 ${path === '.' ? '目录' : path}` : '查看目录',
    local_files_search: `搜索“${firstText(args, 'query') ?? '文件'}”`,
    local_files_read_text: path ? `读取 ${path}` : '读取文件',
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
    office_pptx_create: path ? `生成 ${path}` : '生成 PowerPoint 演示文稿',
    office_pdf_create: path ? `生成 ${path}` : '生成 PDF 文档',
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
  if (toolName.startsWith('local_files_') || toolName.startsWith('office_')) {
    if (!value) return failed ? { detail: publicToolError(content) } : {}
    return compact({
      path: text(value.path) ?? text(value.source), secondaryPath: text(value.destination),
      detail: typeof value.size === 'number' ? formatBytes(value.size) : undefined,
    })
  }
  return failed ? compact({ detail: publicToolError(content) }) : {}
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
