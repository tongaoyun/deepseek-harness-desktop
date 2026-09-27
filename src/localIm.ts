import { invoke, isTauri } from '@tauri-apps/api/core'
import type { CapabilitySnapshot } from './types'

let runtimeTransition: Promise<void> = Promise.resolve()

function serializeRuntime<T>(operation: () => Promise<T>): Promise<T> {
  const result = runtimeTransition.then(operation, operation)
  runtimeTransition = result.then(() => undefined, () => undefined)
  return result
}

export type ImAccessPolicy = 'open' | 'pairing'

export interface DingTalkRegistration { deviceCode: string; verificationUri: string; expiresIn: number; interval: number }
export type DingTalkRegistrationResult = { status: 'WAITING' | 'RETRY' | 'FAIL' | 'EXPIRED' } | { status: 'SUCCESS'; clientId: string; clientSecret: string }

export async function beginDingTalkRegistration(): Promise<DingTalkRegistration> {
  if (!isTauri()) throw new Error('请在小胤桌面端扫码配置钉钉，网页预览可查看手动配置')
  return invoke('begin_dingtalk_registration')
}

export async function pollDingTalkRegistration(deviceCode: string): Promise<DingTalkRegistrationResult> {
  return invoke('poll_dingtalk_registration', { deviceCode })
}

export interface LocalImHarnessContext {
  employeeId: string
  teamId: string
  litellmBaseUrl: string
  knowledgeEndpoint: string
  scheduleEndpoint: string
  capabilitySnapshot: CapabilitySnapshot
  model: string
  modelApiKey: string
  accessToken: string
  allowShell: boolean
  allowLsp: boolean
  allowExternalAgents: boolean
  allowHooks: boolean
}

export interface LocalImPairingRequest {
  conversationKey: string
  conversationType: 'group' | 'private'
  conversationTitle: string
  senderNick: string
  requestedAt: string
}

export interface LocalImStatus {
  provider: 'DINGTALK'
  configured: boolean
  enabled: boolean
  connected: boolean
  state: 'DISABLED' | 'CONNECTING' | 'READY' | 'DEGRADED'
  clientId: string
  secretConfigured: boolean
  accessPolicy: ImAccessPolicy
  notifyTaskResults: boolean
  pendingPairings: LocalImPairingRequest[]
  pairedConversations?: string[]
  conversations: LocalImConversationSummary[]
  pendingEventCount: number
  lastHeartbeatAt?: string
  lastError?: string
}

export interface LocalImConversationSummary {
  conversationKey: string
  conversationType: 'group' | 'private'
  conversationTitle: string
  senderNick: string
  lastMessage: string
  lastResponse: string
  sessionId: string
  messageCount: number
  status: 'RUNNING' | 'COMPLETED' | 'FAILED'
  deliveryStatus?: 'SENDING' | 'FAILED'
  pendingDeliveryCount?: number
  updatedAt: string
  boundTaskId?: string
  boundTaskName?: string
  messages: LocalImConversationMessage[]
  taskProjection?: Record<string, unknown>
}

export interface LocalImConversationMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}

export interface ConfigureDingTalkInput {
  clientId: string
  clientSecret: string
  enabled: boolean
  accessPolicy: ImAccessPolicy
  notifyTaskResults: boolean
  harness: LocalImHarnessContext
}

export async function loadLocalImStatus(): Promise<LocalImStatus> {
  if (!isTauri()) return emptyStatus()
  return invoke<LocalImStatus>('local_im_status')
}

export async function configureLocalDingTalk(input: ConfigureDingTalkInput): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('IM 频道只能在小胤桌面客户端中配置')
  return serializeRuntime(() => invoke<LocalImStatus>('configure_local_dingtalk', { request: input }))
}

export async function startLocalIm(harness: LocalImHarnessContext): Promise<LocalImStatus> {
  if (!isTauri()) return emptyStatus()
  return serializeRuntime(() => invoke<LocalImStatus>('start_local_im', { harness }))
}

export async function setLocalImEnabled(enabled: boolean, harness: LocalImHarnessContext): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('IM 频道只能在小胤桌面客户端中启停')
  return serializeRuntime(() => invoke<LocalImStatus>('set_local_im_enabled', { enabled, harness }))
}

export async function allowLocalImPairing(conversationKey: string): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('配对管理只能在小胤桌面客户端中使用')
  return invoke<LocalImStatus>('allow_local_im_pairing', { conversationKey })
}

export async function revokeLocalImPairing(conversationKey: string): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('配对管理只能在小胤桌面客户端中使用')
  return invoke<LocalImStatus>('revoke_local_im_pairing', { conversationKey })
}

export async function bindLocalImTask(
  conversationKey: string,
  task: { id: string; name: string; sessionId: string },
): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('任务接管只能在小胤桌面客户端中使用')
  return invoke<LocalImStatus>('bind_local_im_task', {
    conversationKey, taskId: task.id, taskName: task.name, sessionId: task.sessionId,
  })
}

export async function unbindLocalImTask(conversationKey: string): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('任务接管只能在小胤桌面客户端中使用')
  return invoke<LocalImStatus>('unbind_local_im_task', { conversationKey })
}

export async function retryLocalImDelivery(conversationKey: string): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('请在小胤桌面端重试发送')
  return invoke<LocalImStatus>('retry_local_im_delivery', { conversationKey })
}

export async function syncLocalImTasks(
  tasks: Array<{ id: string; name: string; sessionId: string }>,
): Promise<LocalImStatus | null> {
  if (!isTauri()) return null
  return invoke<LocalImStatus | null>('sync_local_im_tasks', { tasks })
}

export async function routeLocalImSchedule(
  scheduleId: string, conversationKey: string,
): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('定时任务 IM 投递只能在小胤桌面客户端中配置')
  return invoke<LocalImStatus>('route_local_im_schedule', { scheduleId, conversationKey })
}

export async function removeLocalDingTalk(): Promise<LocalImStatus> {
  if (!isTauri()) return emptyStatus()
  return serializeRuntime(() => invoke<LocalImStatus>('remove_local_dingtalk'))
}

export async function stopLocalImRuntime(): Promise<void> {
  if (!isTauri()) return
  await serializeRuntime(() => invoke('stop_local_im_runtime'))
}

function emptyStatus(): LocalImStatus {
  return {
    provider: 'DINGTALK', configured: false, enabled: false, connected: false,
    state: 'DISABLED', clientId: '', secretConfigured: false,
    accessPolicy: 'pairing', notifyTaskResults: false, pendingPairings: [], conversations: [],
    pendingEventCount: 0,
  }
}
