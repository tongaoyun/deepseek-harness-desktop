import { z } from 'zod'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { teamSchema } from './team-contract.ts'
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
  return z.array(z.string()).default([]).parse(value)
}

function objectList(value: unknown): unknown[] {
  return z.array(z.unknown()).default([]).parse(value)
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
    customTeams: objectList(unwrapLive(record.customTeams)).map((item) => {
      if (item && typeof item === 'object' && 'schemaVersion' in item) {
        const document = z.object({ schemaVersion: z.literal(1), id: z.string(),
          team: z.record(z.string(), z.unknown()) }).strict().parse(item)
        return teamSchema.parse({ ...document.team, id: document.id })
      }
      return item as NonNullable<AgencySettings['customTeams']>[number]
    }),
    enabledTeams: stringList(unwrapLive(record.enabledTeams)),
  }
  if (!(value.customExperts ?? []).some(expert => 'prompt' in expert)) validateAgencySettings(value, locale)
  return structuredClone(value)
}

/** Read one employee's Settings projection; file contents stay outside Settings. */
export function readPersonalLibraries(config: object): Record<string, unknown> {
  const value = 'personalLibraries' in config ? unwrapLive(config.personalLibraries) : {}
  return z.record(z.string(), z.unknown()).parse(value)
}
/** Whether the unscoped personal records have already been assigned to an employee. */
export function personalContentClaimed(config: object): boolean {
  return 'personalContentClaimed' in config && unwrapLive(config.personalContentClaimed) === true
}

/** Persist personal teams as the same versioned document used for company teams.
 * @param value - Validated team projections.
 * @returns Versioned team documents.
 */
export function personalTeamDocuments(value: unknown): unknown[] {
  return z.array(teamSchema).parse(value).map(({ id, ...team }) => ({ schemaVersion: 1, id, team }))
}
/** Encode employee settings without duplicating expert package contents.
 * @param value - Employee-scoped settings projection.
 * @returns Persistent document with versioned team records.
 */
export function personalSettingsDocument(value: AgencySettings): object {
  return { ...value, customTeams: personalTeamDocuments(value.customTeams ?? []) }
}
