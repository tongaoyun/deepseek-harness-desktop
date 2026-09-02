import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  AllowedExtensionArtifact,
  ConnectorDiagnosticResult,
  ConnectorRuntimeDefinition,
  TaskArtifact,
  TaskExecutionStep,
  TaskMonitorState,
} from './types'

export interface HarnessRunInput {
  prompt: string
  employeeId: string
  teamId: string
  sessionId?: string
  selectedExtension?: { kind: 'expert-kit' | 'skill'; id: string }
  knowledgeBaseRefs: string[]
  allowedArtifacts: AllowedExtensionArtifact[]
  litellmBaseUrl: string
  knowledgeEndpoint: string
  connectors: ConnectorRuntimeDefinition[]
  model: string
  modelApiKey: string
  accessToken: string
  localFileRootIds: string[]
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

export interface HarnessNotification {
  requestId: number
  event: unknown
}

export interface AuthorizedLocalDirectory {
  id: string
  name: string
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

export async function revokeLocalDirectory(id: string): Promise<void> {
  if (!isTauri()) return
  await invoke('revoke_local_directory', { id })
}

export async function clearLocalDirectories(): Promise<void> {
  if (!isTauri()) return
  await invoke('clear_local_directories')
}

export async function shutdownHarness(): Promise<void> {
  if (!isTauri()) return
  await invoke('shutdown_harness')
}

export async function cancelHarness(): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('cancel_harness')
}

export async function authorizeDroppedPaths(paths: string[]): Promise<AuthorizedLocalDirectory[]> {
  if (!isTauri() || paths.length === 0) return []
  return invoke<AuthorizedLocalDirectory[]>('authorize_dropped_paths', { paths })
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
  if (parsed.type === 'assistant/message' || parsed.method.includes('message')) return '正在生成回复'
  return '正在分析任务'
}

export function applyHarnessNotification(
  current: TaskMonitorState,
  notification: HarnessNotification,
): TaskMonitorState {
  const parsed = parseHarnessEvent(notification)
  if (!parsed) return current
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

  if (parsed.type === 'assistant/message' && turn !== undefined && step !== undefined) {
    return updateMonitor(current, activity,
      completeStep(current.steps, `analysis:${turn}:${step}`, 'completed', occurredAt), occurredAt)
  }

  if (parsed.type === 'tool/call') {
    const callId = text(parsed.data.callId)
    const toolName = text(parsed.data.name)
    if (!callId || !toolName) return current
    const analysisCompleted = turn === undefined || step === undefined
      ? current.steps
      : completeStep(current.steps, `analysis:${turn}:${step}`, 'completed', occurredAt)
    return updateMonitor(current, activity, upsertStep(analysisCompleted, {
      id: `tool:${callId}`,
      kind: 'tool',
      label: toolActivityLabel(toolName),
      status: 'running',
      toolName,
      startedAt: occurredAt,
    }), occurredAt)
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
    return {
      ...updateMonitor(current, activity,
        completeStep(current.steps, `tool:${result.callId}`, result.failed ? 'failed' : 'completed', occurredAt), occurredAt),
      artifacts,
    }
  }

  if (parsed.type === 'approval/decision') {
    const approvalId = text(parsed.data.approvalId)
    const toolName = text(parsed.data.name)
    const decision = text(parsed.data.decision)
    if (!approvalId || !toolName || !['allow', 'reject'].includes(decision ?? '')) return current
    const allowed = decision === 'allow'
    return updateMonitor(current, activity, upsertStep(current.steps, {
      id: `approval:${approvalId}`,
      kind: 'approval',
      label: `${allowed ? '已允许' : '已拒绝'}${toolActivityLabel(toolName)}`,
      status: allowed ? 'completed' : 'failed',
      toolName,
      startedAt: occurredAt,
      completedAt: occurredAt,
    }), occurredAt)
  }

  if (parsed.type === 'turn/end' && turn !== undefined) {
    const reason = text(asRecord(parsed.data.reason)?.kind)
    const status = reason === 'completed' ? 'completed' : 'failed'
    const settled = current.steps.map((item): TaskExecutionStep => item.status === 'running'
      ? { ...item, status, completedAt: occurredAt }
      : item)
    return {
      ...current,
      status,
      activity: status === 'completed' ? '任务已完成' : '任务执行失败',
      updatedAt: occurredAt,
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
  return { status: 'idle', activity: '等待开始', updatedAt: now, steps: [], artifacts: [] }
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
} | undefined {
  const envelope = asRecord(notification.event)
  const wireEvent = asRecord(envelope?.event)
  const method = text(wireEvent?.method) ?? ''
  const params = asRecord(wireEvent?.params) ?? {}
  const event = asRecord(params.event) ?? {}
  return {
    method,
    params,
    event,
    type: text(event.type) ?? '',
    data: asRecord(event.data) ?? {},
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
  'local_files_write_text', 'local_files_copy', 'local_files_move',
])

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
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    createdAt,
  }
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

function toolActivityLabel(toolName: string): string {
  return ({
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
    local_shell_run: '运行本地命令',
  } as Record<string, string>)[toolName] ?? `调用 ${toolName}`
}

function eventTime(event: Record<string, unknown>): string {
  const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
  return new Date(time).toISOString()
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? value as number : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
