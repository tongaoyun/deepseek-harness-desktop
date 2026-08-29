import { invoke, isTauri } from '@tauri-apps/api/core'
import type {
  ConnectorCatalogEntry,
  DeviceCapabilityResult,
  RuntimeStatus,
  SubmitDeviceCapabilityReport,
} from './types'

export interface DeviceProbe {
  deviceId: string
  desktopVersion: string
  platform: string
  architecture: string
  displayCount: number
  displayScalePercents: number[]
}

export interface DeviceCapabilityContext {
  connectors: ConnectorCatalogEntry[]
  authorizedDirectoryCount: number
  runtimeStatus: RuntimeStatus
}

export async function inspectDeviceCapabilities(): Promise<DeviceProbe> {
  if (isTauri()) return invoke<DeviceProbe>('inspect_device_capabilities')
  const storageKey = 'xiaoyin:development-device-id'
  const deviceId = window.localStorage.getItem(storageKey) ?? crypto.randomUUID()
  window.localStorage.setItem(storageKey, deviceId)
  return {
    deviceId,
    desktopVersion: 'development',
    platform: normalizePlatform(navigator.platform || 'browser'),
    architecture: 'browser',
    displayCount: 1,
    displayScalePercents: [Math.round((window.devicePixelRatio || 1) * 100)],
  }
}

export function buildDeviceCapabilityReport(
  probe: DeviceProbe,
  context: DeviceCapabilityContext,
): SubmitDeviceCapabilityReport {
  const localPlatform = probe.platform === 'windows' || probe.platform === 'macos'
  const capabilities: DeviceCapabilityResult[] = [
    result('desktop.runtime', 'READY', '桌面原生运行时已启动'),
    result('local.files', context.authorizedDirectoryCount > 0 ? 'READY' : 'DEGRADED',
      context.authorizedDirectoryCount > 0 ? '当前任务已授权本地目录' : '当前任务尚未授权本地目录'),
    result('office.documents', 'READY', 'DOCX、XLSX 与 PDF 本机工具已内置'),
    result('local.shell', localPlatform ? 'READY' : 'UNSUPPORTED',
      localPlatform ? '受审批 Shell 能力已内置' : '当前平台不支持受审批 Shell'),
    result('computer.use', probe.platform === 'windows' ? 'READY' : 'UNSUPPORTED',
      probe.platform === 'windows' ? 'Windows Computer Use 能力已内置' : 'Computer Use 当前仅支持 Windows'),
    result('control.plane', context.runtimeStatus === 'ready' ? 'READY' : 'DEGRADED',
      context.runtimeStatus === 'ready' ? '控制中心连接正常' : '控制中心当前不可用'),
  ]
  const uniqueConnectors = new Map(context.connectors.map((connector) => [connector.id, connector]))
  for (const connector of uniqueConnectors.values()) {
    capabilities.push(result(`connector.${normalizeKey(connector.id)}`, connectorCapabilityStatus(connector.status),
      connectorDetail(connector.status)))
  }
  return {
    deviceId: probe.deviceId,
    desktopVersion: probe.desktopVersion,
    platform: normalizePlatform(probe.platform),
    architecture: normalizeArchitecture(probe.architecture),
    displayCount: Math.min(16, Math.max(0, probe.displayCount)),
    displayScalePercents: probe.displayScalePercents.slice(0, 16)
      .map((value) => Math.min(500, Math.max(50, Math.round(value)))),
    capabilities,
  }
}

function connectorCapabilityStatus(status: ConnectorCatalogEntry['status']): DeviceCapabilityResult['status'] {
  if (status === 'ready') return 'READY'
  if (status === 'disabled') return 'UNSUPPORTED'
  return 'DEGRADED'
}

function connectorDetail(status: ConnectorCatalogEntry['status']): string {
  return ({
    ready: '公司连接器已就绪',
    'needs-configuration': '公司连接器需要配置',
    unavailable: '公司连接器当前不可用',
    disabled: '公司连接器已停用',
  })[status]
}

function result(key: string, status: DeviceCapabilityResult['status'], detail: string): DeviceCapabilityResult {
  return { key, status, detail }
}

function normalizeKey(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 53)
  return normalized || 'unknown'
}

function normalizePlatform(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized.includes('win')) return 'windows'
  if (normalized.includes('mac')) return 'macos'
  if (normalized.includes('linux')) return 'linux'
  return 'browser'
}

function normalizeArchitecture(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32)
  return normalized.length >= 2 ? normalized : 'unknown'
}
