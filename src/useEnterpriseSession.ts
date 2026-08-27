import { useCallback, useEffect, useState } from 'react'
import {
  clearErpSession,
  isTauriRuntime,
  openErpLogin,
  resolveErpSession,
  type ErpUser,
} from './auth'

type AuthState = 'checking' | 'required' | 'authenticated' | 'error'

export function useEnterpriseSession() {
  const [state, setState] = useState<AuthState>('checking')
  const [user, setUser] = useState<ErpUser | null>(null)
  const [accessToken, setAccessToken] = useState('')
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [error, setError] = useState('')

  const acceptSession = useCallback((session: Awaited<ReturnType<typeof resolveErpSession>>) => {
    if (!session.authenticated || !session.user) return false
    setUser(session.user)
    setAccessToken(session.accessToken)
    setExpiresAt(session.expiresAt)
    setState('authenticated')
    setError('')
    return true
  }, [])

  const reopen = useCallback(async () => {
    setState('required')
    setError('')
    try {
      await openErpLogin()
    } catch (cause) {
      setState('error')
      setError(cause instanceof Error ? cause.message : '无法打开 ERP 扫码窗口')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void resolveErpSession()
      .then(async (session) => {
        if (cancelled || acceptSession(session)) return
        setState('required')
        await openErpLogin()
      })
      .catch(async (cause) => {
        if (cancelled) return
        setState('required')
        setError(cause instanceof Error ? cause.message : 'ERP 登录状态检查失败')
        try {
          await openErpLogin()
        } catch (openError) {
          if (cancelled) return
          setState('error')
          setError(openError instanceof Error ? openError.message : '无法打开 ERP 扫码窗口')
        }
      })
    return () => { cancelled = true }
  }, [acceptSession])

  useEffect(() => {
    if (!isTauriRuntime() || state === 'authenticated') return
    let cancelled = false
    let checking = false
    const timer = window.setInterval(() => {
      if (checking) return
      checking = true
      void resolveErpSession()
        .then((session) => {
          if (!cancelled) acceptSession(session)
        })
        .catch(() => undefined)
        .finally(() => { checking = false })
    }, 1_500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [acceptSession, state])

  useEffect(() => {
    if (!expiresAt || state !== 'authenticated') return
    const delay = Math.max(1_000, expiresAt * 1_000 - Date.now() - 5 * 60_000)
    const timer = window.setTimeout(() => {
      void resolveErpSession()
        .then((session) => {
          if (!acceptSession(session)) void reopen()
        })
        .catch(() => void reopen())
    }, delay)
    return () => window.clearTimeout(timer)
  }, [acceptSession, expiresAt, reopen, state])

  const logout = useCallback(async () => {
    await clearErpSession()
    setUser(null)
    setAccessToken('')
    setExpiresAt(null)
    await reopen()
  }, [reopen])

  return { accessToken, error, logout, reopen, state, user }
}
