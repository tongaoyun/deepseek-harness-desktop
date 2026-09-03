import { invoke, isTauri } from '@tauri-apps/api/core'
import type { DeviceHeartbeatContext } from './types'

export async function inspectDeviceHeartbeatContext(): Promise<DeviceHeartbeatContext> {
  if (isTauri()) return invoke<DeviceHeartbeatContext>('inspect_device_identity')
  const storageKey = 'xiaoyin:development-device-id'
  const deviceId = window.localStorage.getItem(storageKey) ?? crypto.randomUUID()
  window.localStorage.setItem(storageKey, deviceId)
  return {
    deviceId,
    desktopVersion: 'development',
    platform: navigator.platform.toLocaleLowerCase().includes('win') ? 'windows' : 'macos',
    architecture: 'browser',
    displayCount: 1,
    displayScalePercents: [Math.round((window.devicePixelRatio || 1) * 100)],
  }
}
