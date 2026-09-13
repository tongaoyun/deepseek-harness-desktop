import { useCallback, useEffect, useRef, useState } from 'react'
import { connectorDiagnosticsAvailable, probeHarnessHost, selfTestLocalCapabilities, type HarnessHostHealth } from './harness'
import type { HarnessToolsMode } from './runtimePreferences'

export type HarnessHealth = 'checking' | 'ready' | 'degraded'

export function useHarnessHealth(authenticated: boolean, modelConfigured = false, allowShell = true, allowLsp = true, allowExternalAgents = false, allowHooks = false, toolsMode: HarnessToolsMode = 'native') {
  const [health, setHealth] = useState<HarnessHealth>('checking')
  const [detail, setDetail] = useState('正在检查本地 Agent')
  const [hostHealth, setHostHealth] = useState<HarnessHostHealth>()
  const [attempt, setAttempt] = useState(0)
  const diagnosticRun = useRef(0)

  useEffect(() => {
    if (!authenticated || !connectorDiagnosticsAvailable()) {
      setHealth('ready')
      setDetail('本地 Agent 仅在桌面客户端启用')
      setHostHealth(undefined)
      return
    }
    let disposed = false
    setHealth('checking')
    setDetail('正在检查 Harness Host')
    setHostHealth(undefined)
    void probeHarnessHost(modelConfigured, allowShell, allowLsp, allowExternalAgents, allowHooks, toolsMode)
      .then(async (result) => {
        if (disposed) return
        setHostHealth(result)
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
        setHostHealth(undefined)
      })
    return () => { disposed = true }
  }, [allowExternalAgents, allowHooks, allowLsp, allowShell, attempt, authenticated, modelConfigured, toolsMode])

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

  return { health, detail, hostHealth, recover: () => setAttempt((value) => value + 1), reportInfrastructureFailure }
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
