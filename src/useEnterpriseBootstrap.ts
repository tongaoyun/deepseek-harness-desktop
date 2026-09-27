import { useEffect, useState } from 'react'
import { loadBootstrap } from './api'
import type { BootstrapResponse, RuntimeStatus } from './types'

/** Refresh policy between turns without interrupting work already in flight. */
export function useEnterpriseBootstrap(employeeId: string | undefined, sessionToken: string, refreshKey: number) {
  const key = JSON.stringify([employeeId, sessionToken, refreshKey])
  const [snapshot, setSnapshot] = useState<{ key: string; bootstrap?: BootstrapResponse; runtimeStatus: RuntimeStatus; error: string }>(
    { key: '', runtimeStatus: 'connecting', error: '' },
  )
  useEffect(() => {
    setSnapshot({ key, runtimeStatus: 'connecting', error: '' })
    if (!employeeId) return
    const controller = new AbortController()
    let loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const next = await loadBootstrap(employeeId, sessionToken, controller.signal)
        if (controller.signal.aborted) return
        if (next.employeeId !== employeeId) throw new Error('控制中心员工身份不匹配')
        setSnapshot((current) => current.key === key ? {
          key, bootstrap: JSON.stringify(current.bootstrap) === JSON.stringify(next) ? current.bootstrap : next,
          runtimeStatus: 'ready', error: '',
        } : current)
      } catch (reason) {
        if (controller.signal.aborted) return
        setSnapshot((current) => current.key === key ? {
          ...current, runtimeStatus: current.bootstrap ? current.runtimeStatus : 'offline',
          error: current.bootstrap ? `配置刷新失败，暂用上次配置：${reason instanceof Error ? reason.message : String(reason)}` : '',
        } : current)
      } finally { loading = false }
    }
    const onFocus = () => { void refresh() }
    void refresh()
    const timer = window.setInterval(onFocus, 60_000)
    window.addEventListener('focus', onFocus)
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [employeeId, sessionToken, refreshKey])
  return snapshot.key === key
    ? { bootstrap: snapshot.bootstrap, runtimeStatus: snapshot.runtimeStatus, error: snapshot.error }
    : { bootstrap: undefined, runtimeStatus: 'connecting' as RuntimeStatus, error: '' }
}
