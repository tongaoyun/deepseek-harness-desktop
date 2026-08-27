import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface HarnessRunInput {
  prompt: string
  sessionId?: string
  expertKitId?: string
  litellmBaseUrl: string
  erpMcpUrl: string
  model: string
  accessToken: string
}

export interface HarnessRunResult {
  sessionId: string
  finalResponse: string
}

export interface HarnessNotification {
  requestId: number
  event: unknown
}

export async function runHarness(input: HarnessRunInput): Promise<HarnessRunResult> {
  if (!isTauri()) throw new Error('真实 Agent 执行只能在小胤桌面客户端中运行')
  return invoke<HarnessRunResult>('run_harness', { request: input })
}

export async function listenHarnessNotifications(
  listener: (event: HarnessNotification) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return () => undefined
  return listen<HarnessNotification>('xiaoyin://harness-notification', ({ payload }) => listener(payload))
}

export function harnessActivityLabel(notification: HarnessNotification): string {
  const envelope = asRecord(notification.event)
  const event = asRecord(envelope?.event)
  const method = typeof event?.method === 'string' ? event.method : ''
  const params = asRecord(event?.params)
  const durableEvent = asRecord(params?.event)
  const eventType = typeof durableEvent?.type === 'string' ? durableEvent.type : ''
  const toolName = typeof durableEvent?.name === 'string' ? durableEvent.name : ''

  if (eventType.includes('tool') || method.includes('tool')) {
    return toolName ? `正在调用 ${toolName}` : '正在调用业务工具'
  }
  if (method.includes('status')) {
    const status = typeof params?.status === 'string' ? params.status : ''
    if (status === 'idle') return '正在整理结果'
  }
  if (eventType.includes('assistant') || method.includes('message')) return '正在生成回复'
  return '正在分析任务'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
