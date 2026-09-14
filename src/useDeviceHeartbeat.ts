import { useCallback, useEffect } from 'react'
import { submitDeviceCapabilityReport, submitDeviceHeartbeat } from './api'
import { inspectDeviceHeartbeatContext } from './deviceHeartbeat'
import { installedExtensionSnapshot, listInstalledExtensions } from './expertKits'
import type { HarnessHostHealth } from './harness'
import type { BootstrapResponse, ExpertKitCatalogEntry, SkillCatalogEntry } from './types'
import type { HarnessHealth } from './useHarnessHealth'

export function useDeviceHeartbeat({
  accessToken,
  authenticated,
  bootstrap,
  employeeId,
  expertKits,
  harnessHealth,
  harnessCapabilities,
  runtimeReady,
  skills,
}: {
  accessToken: string
  authenticated: boolean
  bootstrap?: BootstrapResponse
  employeeId?: string
  expertKits: ExpertKitCatalogEntry[]
  harnessHealth: HarnessHealth
  harnessCapabilities?: HarnessHostHealth['capabilities']
  runtimeReady: boolean
  skills: SkillCatalogEntry[]
}) {
  const heartbeat = useCallback(async () => {
    if (!authenticated || !runtimeReady || !bootstrap || !employeeId) return
    try {
      const context = await inspectDeviceHeartbeatContext()
      const installed = await listInstalledExtensions()
      if (/^\d+\.\d+\.\d+$/.test(context.desktopVersion)) {
        const endpoint = bootstrap.endpoints.deviceCapabilities ?? '/api/v1/device-capabilities'
        const capabilityKeys = [...new Set([...bootstrap.capabilities, 'xiaoyin-server', 'harness', ...Object.keys(harnessCapabilities ?? {}).map((key) => `harness.${key}`)])]
          .map((key) => key.trim().toLowerCase())
          .filter((key) => /^[a-z][a-z0-9.-]{1,63}$/.test(key))
        await Promise.all([
          submitDeviceHeartbeat(endpoint, employeeId, accessToken, {
            ...context,
            installedExtensions: installedExtensionSnapshot(installed, [
              ...expertKits.map(({ id, version }) => ({ kind: 'expert-kit' as const, id, version })),
              ...skills.map(({ id, version }) => ({ kind: 'skill' as const, id, version })),
            ]),
          }),
          submitDeviceCapabilityReport(endpoint, employeeId, accessToken, {
            ...context,
            capabilities: capabilityKeys.map((key) => capabilityReportEntry(key, harnessHealth, harnessCapabilities)),
          }),
        ])
      }
    } catch { /* Device inventory is best effort and must never interrupt employee work. */ }
  }, [accessToken, authenticated, bootstrap, employeeId, expertKits, harnessCapabilities, harnessHealth, runtimeReady, skills])

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
): { key: string; status: 'READY' | 'DEGRADED' | 'UNSUPPORTED'; detail: string } {
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
  return { key, status: 'READY', detail: '企业能力已由控制面下发并可用' }
}
