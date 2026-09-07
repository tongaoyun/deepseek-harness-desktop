import { useEffect, useState } from 'react'
import { loadBootstrap } from './api'
import type { BootstrapResponse, RuntimeStatus } from './types'

/** Refresh policy between turns without interrupting work already in flight. */
export function useEnterpriseBootstrap(employeeId: string | undefined, accessToken: string, refreshKey: number) {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>()
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>('connecting')
  const [error, setError] = useState('')
  useEffect(() => {
    setBootstrap(undefined)
    setError('')
    setRuntimeStatus('connecting')
    if (!employeeId) return
    const controller = new AbortController()
    let loading = false
    let loaded = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const next = await loadBootstrap(employeeId, accessToken, controller.signal)
        if (controller.signal.aborted) return
        loaded = true
        setBootstrap((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
        setRuntimeStatus('ready')
        setError('')
      } catch (reason) {
        if (controller.signal.aborted) return
        if (!loaded) setRuntimeStatus('offline')
        setError(loaded ? `配置刷新失败，暂用上次配置：${reason instanceof Error ? reason.message : String(reason)}` : '')
      } finally { loading = false }
    }
    const onFocus = () => { void refresh() }
    void refresh()
    const timer = window.setInterval(onFocus, 60_000)
    window.addEventListener('focus', onFocus)
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [employeeId, accessToken, refreshKey])
  return { bootstrap, runtimeStatus, error }
}
