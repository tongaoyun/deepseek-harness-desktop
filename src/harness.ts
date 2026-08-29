import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ConnectorRuntimeDefinition, TaskExecutionStep } from './types'

export interface HarnessRunInput {
  prompt: string
  employeeId: string
  sessionId?: string
  expertKitId?: string
  litellmBaseUrl: string
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
  current: TaskExecutionStep[],
  notification: HarnessNotification,
): TaskExecutionStep[] {
  const parsed = parseHarnessEvent(notification)
  if (!parsed) return current
  const occurredAt = eventTime(parsed.event)
  const turn = integer(parsed.data.turn)
  const step = integer(parsed.data.step)

  if (parsed.type === 'step/start' && turn !== undefined && step !== undefined) {
    return upsertStep(current, {
      id: `analysis:${turn}:${step}`,
      kind: 'analysis',
      label: step === 1 ? '分析任务' : '整理工具结果',
      status: 'running',
      startedAt: occurredAt,
    })
  }

  if (parsed.type === 'assistant/message' && turn !== undefined && step !== undefined) {
    return completeStep(current, `analysis:${turn}:${step}`, 'completed', occurredAt)
  }

  if (parsed.type === 'tool/call') {
    const callId = text(parsed.data.callId)
    const toolName = text(parsed.data.name)
    if (!callId || !toolName) return current
    const analysisCompleted = turn === undefined || step === undefined
      ? current
      : completeStep(current, `analysis:${turn}:${step}`, 'completed', occurredAt)
    return upsertStep(analysisCompleted, {
      id: `tool:${callId}`,
      kind: 'tool',
      label: toolActivityLabel(toolName),
      status: 'running',
      toolName,
      startedAt: occurredAt,
    })
  }

  if (parsed.type === 'tool/result') {
    const result = toolResult(parsed.data)
    if (!result) return current
    return completeStep(current, `tool:${result.callId}`, result.failed ? 'failed' : 'completed', occurredAt)
  }

  if (parsed.type === 'turn/end' && turn !== undefined) {
    const reason = text(asRecord(parsed.data.reason)?.kind)
    const status = reason === 'completed' ? 'completed' : 'failed'
    const settled = current.map((item): TaskExecutionStep => item.status === 'running'
      ? { ...item, status, completedAt: occurredAt }
      : item)
    return upsertStep(settled, {
      id: `response:${turn}`,
      kind: 'response',
      label: status === 'completed' ? '完成回复' : '执行未完成',
      status,
      startedAt: occurredAt,
      completedAt: occurredAt,
    })
  }

  return current
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

function toolResult(data: Record<string, unknown>): { callId: string; failed: boolean } | undefined {
  const message = asRecord(data.message)
  const content = Array.isArray(message?.content) ? message.content : []
  for (const blockValue of content) {
    const block = asRecord(blockValue)
    if (block?.type !== 'tool-result') continue
    const callId = text(block.toolCallId)
    if (callId) return { callId, failed: block.isError === true }
  }
  return undefined
}

function upsertStep(current: TaskExecutionStep[], next: TaskExecutionStep): TaskExecutionStep[] {
  const index = current.findIndex((item) => item.id === next.id)
  const updated = index < 0
    ? [...current, next]
    : current.map((item, itemIndex) => itemIndex === index ? { ...item, ...next } : item)
  return updated.slice(-24)
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
