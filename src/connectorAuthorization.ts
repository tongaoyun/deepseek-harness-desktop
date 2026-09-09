import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ConnectorRuntimeDefinition } from './types'

export interface ConnectorAuthorizationState {
  status: 'authorized' | 'disconnected' | 'canceled'
  scope?: string
  expiresAt?: number
  revoked?: boolean
}

export async function connectorAuthorization(employeeId: string, connector: ConnectorRuntimeDefinition,
  action: 'status' | 'authorize' | 'disconnect' | 'cancel'): Promise<ConnectorAuthorizationState> {
  if (!isTauri()) throw new Error('请在小胤桌面客户端中授权')
  const result = await invoke<ConnectorAuthorizationState | { status: number; error: string }>('connector_authorization', {
    request: { employeeId, connector, action },
  })
  if ('error' in result) throw new Error(result.error)
  return result
}
