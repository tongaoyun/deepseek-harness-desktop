import { useCallback, useEffect, useRef } from 'react'
import { submitDeviceCapabilityReport, submitDeviceHeartbeat } from './api'
import { inspectDeviceHeartbeatContext } from './deviceHeartbeat'
import { installedExtensionSnapshot, listInstalledExtensions } from './expertKits'
import { selfTestLocalCapabilities, type HarnessHostHealth, type LocalCapabilitySelfTestResult } from './harness'
import type { BootstrapResponse, ExpertKitCatalogEntry, SkillCatalogEntry } from './types'
import type { HarnessHealth } from './useHarnessHealth'

export function useDeviceHeartbeat({
  sessionToken,
  authenticated,
  bootstrap,
  employeeId,
  expertKits,
  harnessHealth,
  harnessCapabilities,
  runtimeReady,
  skills,
}: {
  sessionToken: string
  authenticated: boolean
  bootstrap?: BootstrapResponse
  employeeId?: string
  expertKits: ExpertKitCatalogEntry[]
  harnessHealth: HarnessHealth
  harnessCapabilities?: HarnessHostHealth['capabilities']
  runtimeReady: boolean
  skills: SkillCatalogEntry[]
}) {
  const inventoryCheck = useRef<{ employeeId: string; result: Promise<LocalCapabilitySelfTestResult | undefined>; checkedAt: number } | undefined>(undefined)
  const heartbeat = useCallback(async () => {
    if (!authenticated || !runtimeReady || !bootstrap || !employeeId) return
    try {
      const context = await inspectDeviceHeartbeatContext()
      const installed = await listInstalledExtensions()
      if (/^\d+\.\d+\.\d+$/.test(context.desktopVersion)) {
        const endpoint = bootstrap.endpoints.deviceCapabilities ?? '/api/v1/device-capabilities'
        if (inventoryCheck.current?.employeeId !== employeeId || Date.now() - inventoryCheck.current.checkedAt >= 6 * 60 * 60 * 1000) {
          inventoryCheck.current = { employeeId, checkedAt: Date.now(), result: selfTestLocalCapabilities(false).catch(() => undefined) }
        }
        const selfTest = await inventoryCheck.current.result
        const capabilityKeys = [...new Set(['desktop.runtime', 'office.documents', 'control.plane', 'harness', ...Object.keys(harnessCapabilities ?? {}).map((key) => `harness.${key}`)])]
          .map((key) => key.trim().toLowerCase())
          .filter((key) => /^[a-z][a-z0-9.-]{1,63}$/.test(key))
        await Promise.all([
          submitDeviceHeartbeat(endpoint, employeeId, sessionToken, {
            ...context,
            installedExtensions: installedExtensionSnapshot(installed, [
              ...expertKits.map(({ id, version }) => ({ kind: 'expert-kit' as const, id, version })),
              ...skills.map(({ id, version }) => ({ kind: 'skill' as const, id, version })),
            ]),
          }),
          submitDeviceCapabilityReport(endpoint, employeeId, sessionToken, {
            ...context,
            capabilities: capabilityKeys.map((key) => capabilityReportEntry(key, harnessHealth, harnessCapabilities, selfTest)),
          }),
        ])
      }
    } catch { /* Device inventory is best effort and must never interrupt employee work. */ }
  }, [sessionToken, authenticated, bootstrap, employeeId, expertKits, harnessCapabilities, harnessHealth, runtimeReady, skills])

  useEffect(() => {
    if (!authenticated || !runtimeReady || !bootstrap || !employeeId) return
    void heartbeat()
    const timer = window.setInterval(() => void heartbeat(), 6 * 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [authenticated, bootstrap, employeeId, heartbeat, runtimeReady])

  return heartbeat
}

export function capabilityReportEntry(
  key: string,
  harnessHealth: HarnessHealth,
  harnessCapabilities?: HarnessHostHealth['capabilities'],
  selfTest?: LocalCapabilitySelfTestResult,
): { key: string; status: 'READY' | 'DEGRADED' | 'UNSUPPORTED'; detail: string } {
  if (key === 'control.plane') return { key, status: 'READY', detail: '已通过身份验证并取得控制面配置' }
  if (key === 'desktop.runtime' || key === 'office.documents') {
    const required = key === 'desktop.runtime' ? ['local-files', 'native-shell'] : ['office-runtime', 'office-skills', 'libreoffice-kit']
    const passed = selfTest?.status === 'passed' && required.every((name) => selfTest.checks.some((check) => check.key === name && check.passed))
    return { key, status: passed ? 'READY' : 'DEGRADED', detail: passed ? '本地能力自检通过' : '本地能力自检未通过，请运行诊断' }
  }
  if (key === 'harness') {
    const operational = harnessHealth === 'idle' || harnessHealth === 'ready'
    return {
      key,
      status: operational ? 'READY' : 'DEGRADED',
      detail: harnessHealth === 'idle' ? '本地 Agent 将在任务开始时按需启动' : harnessHealth === 'ready' ? '本地 Agent 已检查可用' : '本地 Agent 正在检测或需要恢复',
    }
  }
  if (key.startsWith('harness.')) {
    const name = key.slice('harness.'.length)
    const sourceKey = Object.keys(harnessCapabilities ?? {}).find((candidate) => candidate.toLowerCase() === name)
    const capability = sourceKey ? harnessCapabilities?.[sourceKey] : undefined
    return capability === 'enabled'
      ? { key, status: 'READY', detail: 'Harness 能力已启用' }
      : capability === 'gated'
        ? { key, status: 'DEGRADED', detail: 'Harness 能力已安装，但受桌面策略控制' }
        : capability === 'unconfigured'
          ? { key, status: 'UNSUPPORTED', detail: 'Harness 能力未在当前运行环境配置' }
          : { key, status: 'DEGRADED', detail: 'Harness 能力尚未完成本机探测' }
  }
  return { key, status: 'UNSUPPORTED', detail: '没有对应的本地能力检测结果' }
}
