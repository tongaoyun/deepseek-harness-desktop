import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ConnectorRuntimeDefinition } from './types'

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
