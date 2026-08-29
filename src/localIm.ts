import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ConnectorRuntimeDefinition } from './types'

export type ImAccessPolicy = 'open' | 'pairing'

export interface LocalImHarnessContext {
  employeeId: string
  teamId: string
  litellmBaseUrl: string
  knowledgeEndpoint: string
  connectors: ConnectorRuntimeDefinition[]
  model: string
  modelApiKey: string
  accessToken: string
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
  pendingPairings: LocalImPairingRequest[]
  lastError?: string
}

export interface ConfigureDingTalkInput {
  clientId: string
  clientSecret: string
  enabled: boolean
  accessPolicy: ImAccessPolicy
  harness: LocalImHarnessContext
}

export async function loadLocalImStatus(): Promise<LocalImStatus> {
  if (!isTauri()) return emptyStatus()
  return invoke<LocalImStatus>('local_im_status')
}

export async function configureLocalDingTalk(input: ConfigureDingTalkInput): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('IM 频道只能在小胤桌面客户端中配置')
  return invoke<LocalImStatus>('configure_local_dingtalk', { request: input })
}

export async function startLocalIm(harness: LocalImHarnessContext): Promise<LocalImStatus> {
  if (!isTauri()) return emptyStatus()
  return invoke<LocalImStatus>('start_local_im', { harness })
}

export async function setLocalImEnabled(enabled: boolean, harness: LocalImHarnessContext): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('IM 频道只能在小胤桌面客户端中启停')
  return invoke<LocalImStatus>('set_local_im_enabled', { enabled, harness })
}

export async function allowLocalImPairing(conversationKey: string): Promise<LocalImStatus> {
  if (!isTauri()) throw new Error('配对管理只能在小胤桌面客户端中使用')
  return invoke<LocalImStatus>('allow_local_im_pairing', { conversationKey })
}

export async function removeLocalDingTalk(): Promise<LocalImStatus> {
  if (!isTauri()) return emptyStatus()
  return invoke<LocalImStatus>('remove_local_dingtalk')
}

export async function stopLocalImRuntime(): Promise<void> {
  if (!isTauri()) return
  await invoke('stop_local_im_runtime')
}

function emptyStatus(): LocalImStatus {
  return {
    provider: 'DINGTALK', configured: false, enabled: false, connected: false,
    state: 'DISABLED', clientId: '', secretConfigured: false,
    accessPolicy: 'pairing', pendingPairings: [],
  }
}
