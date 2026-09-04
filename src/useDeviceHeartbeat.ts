import { useCallback, useEffect } from 'react'
import { submitDeviceHeartbeat } from './api'
import { inspectDeviceHeartbeatContext } from './deviceHeartbeat'
import { installedExtensionSnapshot, listInstalledExtensions } from './expertKits'
import type { BootstrapResponse, ExpertKitCatalogEntry, SkillCatalogEntry } from './types'

export function useDeviceHeartbeat({
  accessToken,
  authenticated,
  bootstrap,
  employeeId,
  expertKits,
  runtimeReady,
  skills,
}: {
  accessToken: string
  authenticated: boolean
  bootstrap?: BootstrapResponse
  employeeId?: string
  expertKits: ExpertKitCatalogEntry[]
  runtimeReady: boolean
  skills: SkillCatalogEntry[]
}) {
  const heartbeat = useCallback(async () => {
    if (!authenticated || !runtimeReady || !bootstrap || !employeeId) return
    try {
      const context = await inspectDeviceHeartbeatContext()
      const installed = await listInstalledExtensions()
      if (/^\d+\.\d+\.\d+$/.test(context.desktopVersion)) {
        await submitDeviceHeartbeat(bootstrap.endpoints.deviceCapabilities ?? '/api/v1/device-capabilities',
          employeeId, accessToken, { ...context, installedExtensions: installedExtensionSnapshot(installed, [
            ...expertKits.map(({ id, version }) => ({ kind: 'expert-kit' as const, id, version })),
            ...skills.map(({ id, version }) => ({ kind: 'skill' as const, id, version })),
          ]) })
      }
    } catch { /* Device inventory is best effort and must never interrupt employee work. */ }
  }, [accessToken, authenticated, bootstrap, employeeId, expertKits, runtimeReady, skills])

  useEffect(() => {
    if (!authenticated || !runtimeReady || !bootstrap || !employeeId) return
    void heartbeat()
    const timer = window.setInterval(() => void heartbeat(), 6 * 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [authenticated, bootstrap, employeeId, heartbeat, runtimeReady])

  return heartbeat
}
