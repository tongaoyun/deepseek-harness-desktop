import { invoke } from '@tauri-apps/api/core'

export type ErpUser = {
  userId: string
  displayName: string
  department: string
  position: string
  dataPermission: string
  companyId: string
  companyName: string
  role: 'admin' | 'operator'
}

export type ErpSessionStatus = {
  authenticated: boolean
  accessToken: string
  expiresAt: number | null
  user: ErpUser | null
  loginUrl: string
}

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

export async function resolveErpSession(): Promise<ErpSessionStatus> {
  if (!isTauriRuntime()) {
    return {
      authenticated: true,
      accessToken: '',
      expiresAt: null,
      user: {
        userId: 'local-development',
        displayName: '本地员工',
        department: '跨境运营',
        position: '开发预览',
        dataPermission: 'development',
        companyId: 'local',
        companyName: '企业内部版',
        role: 'admin',
      },
      loginUrl: '',
    }
  }
  return invoke<ErpSessionStatus>('erp_session')
}

export async function openErpLogin(): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('open_erp_login')
}

export async function clearErpSession(): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('clear_erp_session')
}
