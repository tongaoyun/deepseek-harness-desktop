import { useCallback, useEffect } from 'react'
import { submitDeviceCapabilityReport, submitDeviceHeartbeat } from './api'
import { inspectDeviceHeartbeatContext } from './deviceHeartbeat'
import { installedExtensionSnapshot, listInstalledExtensions } from './expertKits'
import type { BootstrapResponse, ExpertKitCatalogEntry, SkillCatalogEntry } from './types'

export function useDeviceHeartbeat({
  accessToken,
  authenticated,
  bootstrap,
  employeeId,
  expertKits,
  harnessHealth,
  runtimeReady,
  skills,
}: {
  accessToken: string
  authenticated: boolean
  bootstrap?: BootstrapResponse
  employeeId?: string
  expertKits: ExpertKitCatalogEntry[]
  harnessHealth: 'checking' | 'ready' | 'degraded'
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
        const capabilityKeys = [...new Set([...bootstrap.capabilities, 'xiaoyin-server', 'harness'])]
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
            capabilities: capabilityKeys.map((key) => ({
              key,
              status: key === 'harness' && harnessHealth !== 'ready' ? 'DEGRADED' as const : 'READY' as const,
              detail: key === 'harness'
                ? harnessHealth === 'ready' ? '本地 Agent 已就绪' : '本地 Agent 正在检测或需要恢复'
                : '企业能力已由控制面下发并可用',
            })),
          }),
        ])
      }
    } catch { /* Device inventory is best effort and must never interrupt employee work. */ }
  }, [accessToken, authenticated, bootstrap, employeeId, expertKits, harnessHealth, runtimeReady, skills])

  useEffect(() => {
    if (!authenticated || !runtimeReady || !bootstrap || !employeeId) return
    void heartbeat()
    const timer = window.setInterval(() => void heartbeat(), 6 * 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [authenticated, bootstrap, employeeId, heartbeat, runtimeReady])

  return heartbeat
}
