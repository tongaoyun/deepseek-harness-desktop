import { useCallback, useEffect, useRef, useState } from 'react'
import { connectorDiagnosticsAvailable, probeHarnessHost, selfTestLocalCapabilities, type HarnessHostHealth } from './harness'

export type HarnessHealth = 'idle' | 'checking' | 'ready' | 'degraded'

export function useHarnessHealth(authenticated: boolean, modelConfigured = false, allowShell = true, allowLsp = false, allowExternalAgents = false, allowHooks = false) {
  const [health, setHealth] = useState<HarnessHealth>('idle')
  const [detail, setDetail] = useState('本地执行环境将在任务开始时按需启动')
  const [hostHealth, setHostHealth] = useState<HarnessHostHealth>()
  const diagnosticRun = useRef(0)

  useEffect(() => {
    diagnosticRun.current += 1
    if (!authenticated || !connectorDiagnosticsAvailable()) {
      setHostHealth(undefined)
      setHealth('idle')
      setDetail('本地 Agent 仅在桌面客户端启用')
      return
    }
    setHealth('idle')
    setDetail('本地执行环境将在任务开始时按需启动')
  }, [allowExternalAgents, allowHooks, allowLsp, allowShell, authenticated, modelConfigured])

  const recover = useCallback(async () => {
    if (!authenticated || !connectorDiagnosticsAvailable()) return
    const run = diagnosticRun.current + 1
    diagnosticRun.current = run
    setHealth('checking')
    setDetail('正在检查本地执行环境')
    try {
      const result = await probeHarnessHost(modelConfigured, allowShell, allowLsp, allowExternalAgents, allowHooks)
      if (diagnosticRun.current !== run) return
      setHostHealth(result)
      if (result.status !== 'ready') throw new Error(`本地执行环境状态异常：${result.status}`)
      const selfTest = await selfTestLocalCapabilities()
      if (diagnosticRun.current !== run) return
      setHealth('ready')
      setDetail(`本地能力检查通过 · ${selfTest.checks.length} 项`)
    } catch (reason) {
      if (diagnosticRun.current !== run) return
      setHealth('degraded')
      setDetail(message(reason))
      setHostHealth(undefined)
    }
  }, [allowExternalAgents, allowHooks, allowLsp, allowShell, authenticated, modelConfigured])

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

  return { health, detail, hostHealth, recover, reportInfrastructureFailure }
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
