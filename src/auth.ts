import { invoke } from '@tauri-apps/api/core'

export type ErpUser = {
  userId: string
  displayName: string
  department: string
  teamId: string
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
  diagnostic?: ErpSessionDiagnostic
}

const sessionMessages = {
  authenticated: '企业身份已确认。',
  cookie_missing: '本机没有可用的 ERP 登录记录，请扫码登录。',
  session_rejected: 'ERP 登录已失效，请重新扫码。',
  access_denied: 'ERP 拒绝访问员工身份，请联系管理员检查账号权限。',
  network_error: '暂时无法连接 ERP，正在自动重试。',
  request_timeout: 'ERP 响应超时，正在自动重试。',
  identity_unavailable: 'ERP 身份服务暂时不可用，正在自动重试。',
  identity_invalid: 'ERP 返回的员工身份不完整，请联系管理员。',
  control_plane_auth_failed: '控制中心未能建立安全会话，请检查服务配置后重试。',
  cookie_read_failed: '无法读取本机登录记录，请重试或重启小胤。',
  cookie_store_failed: '无法访问系统凭据库中的登录记录，请解锁凭据库后重试。',
  configuration_invalid: 'ERP 登录配置无效，请联系管理员。',
} as const

export type ErpSessionDiagnostic = {
  code: keyof typeof sessionMessages
  cookieCount: number | null
  httpStatus: number | null
  checkedAt: number
  appVersion: string
  os: string
  arch: string
  runId: string
  debugBuild: boolean
}

export function sessionFailureMessage(cause: unknown): string {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
  return typeof code === 'string' && Object.hasOwn(sessionMessages, code)
    ? sessionMessages[code as keyof typeof sessionMessages]
    : '登录状态检查失败，正在自动重试。'
}

export function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window
}

export function usesLocalDevelopmentSession(): boolean {
  return !isTauriRuntime() || (import.meta.env.DEV && import.meta.env.VITE_SKIP_ERP_LOGIN === 'true')
}

export async function resolveErpSession(): Promise<ErpSessionStatus> {
  if (usesLocalDevelopmentSession()) {
    return {
      authenticated: true,
      accessToken: '',
      expiresAt: null,
      user: {
        userId: 'local-development',
        displayName: '本地员工',
        department: '跨境运营',
        teamId: 'local',
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
  if (usesLocalDevelopmentSession()) return
  await invoke('open_erp_login')
}

export async function clearErpSession(): Promise<void> {
  if (usesLocalDevelopmentSession()) return
  await invoke('clear_erp_session')
}
