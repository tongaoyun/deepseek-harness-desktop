import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { validateAgencySettings, type AgencySettings } from './expert-library.ts'

/** Stable official Settings namespace for personal expert content. */
export function expertSettingsNamespace(value: string): SettingsNamespace {
  return value as SettingsNamespace
}

/** volatile 配置字段是带 get() 的稳定引用，读取时必须取当前快照。 */
export function isLiveValue(value: unknown): value is { get(): unknown } {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
}

function unwrapLive(value: unknown): unknown {
  return isLiveValue(value) ? value.get() : value
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function objectList(value: unknown): unknown[] {
  return Array.isArray(value) ? value.filter(item => item !== null && typeof item === 'object') : []
}

/** 从插件配置读取启用名单。volatile 引用每次调用都重新取值，并复制冻结快照。 */
export function readAgencySettings(config: object, locale: 'zh' | 'en' = 'zh'): AgencySettings {
  const record = config as {
    enabled?: unknown
    customExperts?: unknown
    customTeams?: unknown
    enabledTeams?: unknown
  }
  const value: AgencySettings = {
    enabled: stringList(unwrapLive(record.enabled)),
    customExperts: objectList(unwrapLive(record.customExperts)) as AgencySettings['customExperts'],
    customTeams: objectList(unwrapLive(record.customTeams)) as AgencySettings['customTeams'],
    enabledTeams: stringList(unwrapLive(record.enabledTeams)),
  }
  validateAgencySettings(value, locale)
  return structuredClone(value)
}
