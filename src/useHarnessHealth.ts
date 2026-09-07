import { useCallback, useEffect, useRef, useState } from 'react'
import { connectorDiagnosticsAvailable, probeHarnessHost, selfTestLocalCapabilities } from './harness'

export type HarnessHealth = 'checking' | 'ready' | 'degraded'

export function useHarnessHealth(authenticated: boolean) {
  const [health, setHealth] = useState<HarnessHealth>('checking')
  const [detail, setDetail] = useState('正在检查本地 Agent')
  const [attempt, setAttempt] = useState(0)
  const diagnosticRun = useRef(0)

  useEffect(() => {
    if (!authenticated || !connectorDiagnosticsAvailable()) {
      setHealth('ready')
      setDetail('本地 Agent 仅在桌面客户端启用')
      return
    }
    let disposed = false
    setHealth('checking')
    setDetail('正在检查 Harness Host')
    void probeHarnessHost()
      .then(async (result) => {
        if (disposed) return
        if (result.status !== 'ready') {
          setHealth('degraded')
          setDetail(`Harness Host 状态异常：${result.status}`)
          return
        }
        if (attempt > 0) {
          const selfTest = await selfTestLocalCapabilities()
          if (disposed) return
          setHealth('ready')
          setDetail(`本地能力自检通过 · ${selfTest.checks.length} 项`)
          return
        }
        setHealth('ready')
        setDetail(`Harness Host 已就绪 · ${result.version}`)
      })
      .catch((reason) => {
        if (disposed) return
        setHealth('degraded')
        setDetail(message(reason))
      })
    return () => { disposed = true }
  }, [attempt, authenticated])

  const reportInfrastructureFailure = useCallback((reason: string) => {
    const run = diagnosticRun.current + 1
    diagnosticRun.current = run
    setHealth('degraded')
    setDetail(`Harness 执行异常：${reason}`)
    void selfTestLocalCapabilities()
      .then((result) => {
        if (diagnosticRun.current === run) setDetail(`Harness 执行异常：${reason} · 本地能力自检 ${result.checks.length} 项通过`)
      })
      .catch((error) => {
        if (diagnosticRun.current === run) setDetail(`Harness 执行异常：${reason} · 自检失败：${message(error)}`)
      })
  }, [])

  return { health, detail, recover: () => setAttempt((value) => value + 1), reportInfrastructureFailure }
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
