import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { clearDingTalkSession, isTauriRuntime, openDingTalkLogin, resolveDingTalkSession, sessionFailureMessage, usesLocalDevelopmentSession, type DingTalkSessionStatus } from './auth'

type AuthState = 'checking' | 'required' | 'authorizing' | 'authenticated' | 'error'
const RETRY_MS = 15_000
const LOGIN_POLL_MS = 1_500
const STARTUP_COOKIE_GRACE_MS = 1_500

export function useEnterpriseSession() {
  const [state, setState] = useState<AuthState>('checking')
  const [session, setSession] = useState<DingTalkSessionStatus>()
  const [error, setError] = useState('')
  const actions = useRef({ reopen: async () => {}, logout: async () => {} })

  useEffect(() => {
    let disposed = false
    let generation = 0
    let checking: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let accepted: DingTalkSessionStatus | undefined
    let loginOpened = false
    let pendingLogout = false
    let manualRetryQueued = false
    let authorizingUntil = 0
    let startupCookieCheckPending = true
    let unlisten: (() => void) | undefined
    const current = (request: number) => !disposed && request === generation
    const schedule = (delay: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => void check(), delay)
    }
    const openLogin = async (request: number) => {
      if (loginOpened || !current(request)) return
      try {
        await openDingTalkLogin()
        if (current(request)) loginOpened = true
      } catch {
        if (current(request)) setError('无法打开钉钉授权，请重试。')
      }
    }
    async function check() {
      if (disposed || pendingLogout || checking === generation) return
      const request = generation
      const manualRetry = manualRetryQueued
      manualRetryQueued = false
      checking = request
      clearTimeout(timer)
      try {
        const next = await resolveDingTalkSession()
        if (!current(request)) return
        if (next.authenticated && next.user) {
          startupCookieCheckPending = false
          accepted = next
          setSession(next)
          setState('authenticated')
          setError('')
          authorizingUntil = 0
          loginOpened = false
          if (next.expiresAt) schedule(Math.max(1_000, next.expiresAt * 1_000 - Date.now() - 5 * 60_000))
        } else {
          if (startupCookieCheckPending && !manualRetry && next.diagnostic?.code === 'cookie_missing') {
            startupCookieCheckPending = false
            setState('checking')
            setError('')
            schedule(STARTUP_COOKIE_GRACE_MS)
            return
          }
          startupCookieCheckPending = false
          accepted = undefined
          setSession(undefined)
          setError(authorizingUntil && authorizingUntil <= Date.now() ? '钉钉授权已结束，但小胤会话未建立，请重新打开钉钉。' :
            next.diagnostic?.code === 'session_rejected' ? sessionFailureMessage(next.diagnostic) : '')
          if (authorizingUntil > Date.now()) {
            setState('authorizing')
          } else {
            setState('required')
            // Open official DingTalk OAuth after a confirmed missing session.
            // Transient network failures still stay on the login screen without a flash.
            const shouldOpenLogin = manualRetry || next.diagnostic?.code === 'cookie_missing' || next.diagnostic?.code === 'session_rejected'
            if (shouldOpenLogin) await openLogin(request)
          }
          if (current(request)) schedule(LOGIN_POLL_MS)
        }
      } catch (cause) {
        if (!current(request)) return
        if (manualRetryQueued) return
        // A failed request does not prove logout. Keep only the still-valid session.
        const accessDenied = cause && typeof cause === 'object' && 'code' in cause && cause.code === 'access_denied'
        if (accessDenied) accepted = undefined
        if (!accepted || (accepted.expiresAt !== null && accepted.expiresAt * 1_000 <= Date.now())) {
          setSession(undefined)
          setState('error')
        }
        const message = sessionFailureMessage(cause)
        setError(manualRetry ? `重新检查后仍未成功：${message}` : message)
        schedule(RETRY_MS)
      } finally {
        if (checking === request) {
          checking = undefined
          if (manualRetryQueued && current(request) && !pendingLogout) schedule(0)
        }
      }
    }
    const logout = async () => {
      const request = ++generation
      pendingLogout = true
      manualRetryQueued = false
      clearTimeout(timer)
      accepted = undefined
      setSession(undefined)
      setState('checking')
      setError('')
      try {
        await clearDingTalkSession()
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
        manualRetryQueued = true
        setState('checking')
        setError('')
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
      void listen<string>('dingtalk-login-progress', (event) => {
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
    sessionToken: session?.sessionToken ?? '', authorizing: state === 'authorizing', error,
    logout: () => actions.current.logout(), reopen: () => actions.current.reopen(), state, user: session?.user ?? null,
  }
}
