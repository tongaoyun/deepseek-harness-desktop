import { invoke } from '@tauri-apps/api/core'

export type DingTalkUser = {
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

export type DingTalkSessionStatus = {
  authenticated: boolean
  sessionToken: string
  expiresAt: number | null
  user: DingTalkUser | null
  loginUrl: string
  diagnostic?: DingTalkSessionDiagnostic
}

const sessionMessages = {
  authenticated: '钉钉身份已确认。',
  cookie_missing: '正在打开钉钉授权，已登录钉钉的账号会自动确认。',
  session_rejected: '小胤登录已失效，正在重新打开钉钉授权。',
  access_denied: '钉钉拒绝访问员工身份，请联系管理员检查账号权限。',
  network_error: '暂时无法连接小胤服务，正在自动重试。',
  request_timeout: '小胤服务响应超时，正在自动重试。',
  identity_unavailable: '小胤身份服务暂时不可用，正在自动重试。',
  identity_invalid: '小胤返回的员工身份不完整，请联系管理员。',
  control_plane_auth_failed: '控制中心未能建立安全会话，请检查服务配置后重试。',
  cookie_read_failed: '无法读取本机登录记录，请重试或重启小胤。',
  cookie_store_failed: '无法访问系统凭据库中的登录记录，请解锁凭据库后重试。',
  configuration_invalid: '钉钉登录配置无效，请联系管理员。',
} as const

export type DingTalkSessionDiagnostic = {
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
  return !isTauriRuntime() || (import.meta.env.DEV && import.meta.env.VITE_SKIP_DINGTALK_LOGIN === 'true')
}

export async function resolveDingTalkSession(): Promise<DingTalkSessionStatus> {
  if (usesLocalDevelopmentSession()) {
    return {
      authenticated: true,
      sessionToken: '',
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
  return invoke<DingTalkSessionStatus>('dingtalk_session')
}

export async function openDingTalkLogin(): Promise<void> {
  if (usesLocalDevelopmentSession()) return
  await invoke('open_dingtalk_login')
}

export async function clearDingTalkSession(): Promise<void> {
  if (usesLocalDevelopmentSession()) return
  await invoke('clear_dingtalk_session')
}
