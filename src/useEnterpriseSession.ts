import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { clearErpSession, isTauriRuntime, openErpLogin, resolveErpSession, sessionFailureMessage, usesLocalDevelopmentSession, type ErpSessionStatus } from './auth'

type AuthState = 'checking' | 'required' | 'authorizing' | 'authenticated' | 'error'
const RETRY_MS = 15_000
const LOGIN_POLL_MS = 1_500

export function useEnterpriseSession() {
  const [state, setState] = useState<AuthState>('checking')
  const [session, setSession] = useState<ErpSessionStatus>()
  const [error, setError] = useState('')
  const actions = useRef({ reopen: async () => {}, logout: async () => {} })

  useEffect(() => {
    let disposed = false
    let generation = 0
    let checking: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let accepted: ErpSessionStatus | undefined
    let loginOpened = false
    let pendingLogout = false
    let authorizingUntil = 0
    let unlisten: (() => void) | undefined
    const current = (request: number) => !disposed && request === generation
    const schedule = (delay: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => void check(), delay)
    }
    const openLogin = async (request: number) => {
      if (loginOpened || !current(request)) return
      try {
        await openErpLogin()
        if (current(request)) loginOpened = true
      } catch {
        if (current(request)) setError('无法打开扫码窗口，请重新打开。')
      }
    }
    async function check() {
      if (disposed || pendingLogout || checking === generation) return
      const request = generation
      checking = request
      clearTimeout(timer)
      try {
        const next = await resolveErpSession()
        if (!current(request)) return
        if (next.authenticated && next.user) {
          accepted = next
          setSession(next)
          setState('authenticated')
          setError('')
          authorizingUntil = 0
          loginOpened = false
          if (next.expiresAt) schedule(Math.max(1_000, next.expiresAt * 1_000 - Date.now() - 5 * 60_000))
        } else {
          accepted = undefined
          setSession(undefined)
          setError(authorizingUntil && authorizingUntil <= Date.now() ? '钉钉已确认，但 ERP 会话未建立，请重新扫码。' :
            next.diagnostic?.code === 'session_rejected' ? sessionFailureMessage(next.diagnostic) : '')
          if (authorizingUntil > Date.now()) {
            setState('authorizing')
          } else {
            setState('required')
            await openLogin(request)
          }
          if (current(request)) schedule(LOGIN_POLL_MS)
        }
      } catch (cause) {
        if (!current(request)) return
        // A failed request does not prove logout. Keep only the still-valid session.
        const accessDenied = cause && typeof cause === 'object' && 'code' in cause && cause.code === 'access_denied'
        if (accessDenied) accepted = undefined
        if (!accepted || (accepted.expiresAt !== null && accepted.expiresAt * 1_000 <= Date.now())) {
          setSession(undefined)
          setState('error')
        }
        setError(sessionFailureMessage(cause))
        schedule(RETRY_MS)
      } finally {
        if (checking === request) checking = undefined
      }
    }
    const logout = async () => {
      const request = ++generation
      pendingLogout = true
      clearTimeout(timer)
      accepted = undefined
      setSession(undefined)
      setState('checking')
      setError('')
      try {
        await clearErpSession()
        if (!current(request)) return
        pendingLogout = false
        loginOpened = false
        authorizingUntil = 0
        await check()
      } catch {
        if (current(request)) {
          setState('error')
          setError('退出登录未完成，请重试。')
        }
      }
    }
    actions.current = {
      logout,
      reopen: async () => {
        if (pendingLogout) return logout()
        loginOpened = false
        authorizingUntil = 0
        await check()
      },
    }
    const wake = () => {
      if (document.visibilityState === 'hidden') return
      if (!accepted || accepted.expiresAt === null || accepted.expiresAt * 1_000 - Date.now() <= 5 * 60_000) void check()
    }
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    if (isTauriRuntime() && !usesLocalDevelopmentSession()) {
      void listen<string>('erp-login-progress', (event) => {
        if (disposed || pendingLogout || accepted || event.payload !== 'authorizing') return
        authorizingUntil = Date.now() + 20_000
        setState('authorizing')
        setError('')
        schedule(LOGIN_POLL_MS)
      }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose }).catch(() => undefined)
    }
    void check()
    return () => {
      disposed = true
      clearTimeout(timer)
      unlisten?.()
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [])

  return {
    accessToken: session?.accessToken ?? '', authorizing: state === 'authorizing', error,
    logout: () => actions.current.logout(), reopen: () => actions.current.reopen(), state, user: session?.user ?? null,
  }
}
