import { TEAM_CUSTOM_ID, teamSchema, type ExpertTeam } from './team-contract.ts'
import { randomUUID } from 'node:crypto'
import { teamText } from './team-i18n.ts'
import schema from '@deepseek-ai/schemastery'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { z } from 'zod'
import { CUSTOM_EXPERT_LIMIT, CUSTOM_EXPERT_SLUG, customError, customExpertInputSchema, customExpertSchema, type CatalogSnapshot, type CustomExpert, type CustomExpertInput, type ExpertSummary } from './expert-contract.ts'
import { ZH_DIVISION } from './names.ts'

export const AGENCY_LIBRARY_SERVICE = 'agencyAgentsLibrary'
export interface AgencySettings { enabled: string[]; customExperts?: CustomExpert[]; customTeams?: ExpertTeam[]; enabledTeams?: string[] }

/** 个人内容与启用状态在同一 namespace 原子持久化；新安装默认为空。 */
export const agencySettingsSchema = schema.object({
  enabled: schema.array(schema.string()).default([]),
  customExperts: schema.array(schema.any()).default([]),
  customTeams: schema.array(schema.any()).default([]),
  enabledTeams: schema.array(schema.string()).default([]),
})

export function validateAgencySettings(value: AgencySettings, locale: 'zh' | 'en' = 'zh'): void {
  const teams = z.array(teamSchema).max(100).parse(value.customTeams ?? [])
  const teamIds = new Set<string>()
  const teamNames = new Set<string>()
  for (const team of teams) {
    if (!TEAM_CUSTOM_ID.test(team.id) || teamIds.has(team.id) || teamNames.has(normalizeName(team.name))) {
      throw new Error(teamText(locale, '专家团标识或名称重复。'))
    }
    teamIds.add(team.id)
    teamNames.add(normalizeName(team.name))
  }
  const records = z.array(customExpertSchema).parse(value.customExperts ?? [])
  if (records.filter(item => !item.deleted).length > CUSTOM_EXPERT_LIMIT) throw customError('limit', locale)
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const expert of value.customExperts ?? []) {
    if (ids.has(expert.slug) || (!expert.deleted && names.has(normalizeName(expert.name)))) throw customError('duplicate', locale)
    ids.add(expert.slug)
    if (!expert.deleted) names.add(normalizeName(expert.name))
  }
}

export interface ExpertSettingsStore {
  read(): AgencySettings
  revision(): number
  mutate(ops: SettingsPathOp[], expectedRevision: number): Promise<void>
}
/** Commit personal expert or team settings, preserving native transaction conflict semantics.
 * @param store Authoritative revision-checked settings writer.
 * @param ops Atomic settings edits.
 * @param expectedRevision Revision confirmed by the caller.
 * @param locale Language for a rejected stale write.
 * @returns Completion after persistence; failed writes never publish a success snapshot.
 */
export async function mutateExpertSettings(store: ExpertSettingsStore, ops: SettingsPathOp[], expectedRevision: number, locale: 'zh' | 'en'): Promise<void> {
  try {
    await store.mutate(ops, expectedRevision)
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SETTINGS_CONFLICT') {
      throw customError('conflict', locale, { cause: error })
    }
    throw error
  }
}
export interface AgencyExpertLibrary {
  catalog(): Promise<CatalogSnapshot>
  getCustom(slug: string): Promise<CustomExpert>
  saveCustom(input: CustomExpertInput, enabled: boolean, expectedRevision: number): Promise<CatalogSnapshot>
  deleteCustom(slug: string, expectedRevision: number): Promise<CatalogSnapshot>
  setEnabled(enabled: string[], expectedRevision: number): Promise<{ enabled: string[]; revision: number }>
  cleanupDeleted(): Promise<void>
}
export const normalizeName = (value: string): string => value.trim().toLowerCase()

/** 合并只读基础名册与自定义数据；依赖宿主的持久化事务和修订号仲裁。 */
export function createExpertLibrary(
  base: () => Promise<ReadonlyArray<ExpertSummary>>,
  store: ExpertSettingsStore,
  divisions: readonly string[],
  locale: () => 'zh' | 'en',
): AgencyExpertLibrary {
  const read = (): { enabled: string[]; customExperts: CustomExpert[] } => {
    const state = store.read()
    return { enabled: state.enabled, customExperts: z.array(customExpertSchema).parse(state.customExperts ?? []) }
  }
  const checkRevision = (revision: number): void => {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== store.revision()) throw customError('conflict', locale())
  }
  const summary = (expert: CustomExpert): ExpertSummary => ({
    slug: expert.slug, name: expert.name, nameEn: expert.name,
    description: expert.description, descriptionEn: '', emoji: expert.emoji,
    division: expert.division, divisionZh: ZH_DIVISION[expert.division] ?? expert.division,
    avatar: expert.avatar, custom: true,
  })
  const overlaps = (a: ExpertSummary, b: ExpertSummary): boolean => a.slug === b.slug || !a.teamMember && !b.teamMember && [a.name, a.nameEn].some(name => [b.name, b.nameEn].some(other => normalizeName(name) === normalizeName(other)))
  // 只校验当前编辑对象，其他已有冲突不能阻断逐个修复。
  const assertUnique = (expert: ExpertSummary, others: readonly ExpertSummary[]): void => {
    if (others.some(other => overlaps(expert, other))) throw customError('duplicate', locale())
  }
  // 只按数组引用缓存。调用方必须返回同一份基础名册；就地修改该数组不会使冲突标记失效。
  let catalogMemo: { source: readonly ExpertSummary[]; experts: ExpertSummary[] } | undefined
  const projectCatalog = (catalogExperts: readonly ExpertSummary[]): readonly ExpertSummary[] => {
    if (catalogMemo?.source === catalogExperts) return catalogMemo.experts
    const experts = catalogExperts.map(expert => ({ ...expert, conflict: catalogExperts.some(other => other !== expert && overlaps(expert, other)) }))
    catalogMemo = { source: catalogExperts, experts }
    return experts
  }
  const project = (catalogExperts: readonly ExpertSummary[], state: ReturnType<typeof read>): CatalogSnapshot => {
    const ready = projectCatalog(catalogExperts)
    const custom = state.customExperts.filter(item => !item.deleted).map(summary)
    const experts = [...ready,
      ...custom.map(expert => ({ ...expert, conflict: [...ready, ...custom.filter(other => other !== expert)].some(other => overlaps(expert, other)) }))]
    const available = new Set(experts.filter(expert => !expert.conflict).map(expert => expert.slug))
    return { experts, enabled: [...new Set(state.enabled.filter(slug => available.has(slug)))], revision: store.revision() }
  }
  const assertWritable = (slug: string): void => {
    if (!CUSTOM_EXPERT_SLUG.test(slug)) throw customError('readonly', locale())
  }
  const activeRecords = (records: CustomExpert[]): CustomExpert[] => records.filter(item => !item.deleted).map(({ deleted: _deleted, wasEnabled: _wasEnabled, ...item }) => item)
  const persist = async (state: ReturnType<typeof read>, revision: number): Promise<CatalogSnapshot> => {
    await mutateExpertSettings(store, [
      { op: 'set', path: ['customExperts'], value: activeRecords(state.customExperts) },
      { op: 'set', path: ['enabled'], value: [...new Set(state.enabled)] },
    ], revision, locale())
    return library.catalog()
  }
  const library: AgencyExpertLibrary = {
    async catalog() {
      const catalogExperts = await base()
      const state = read()
      return project(catalogExperts, state)
    },
    async getCustom(slug) {
      assertWritable(slug)
      const expert = read().customExperts.find(item => item.slug === slug && !item.deleted)
      if (expert === undefined) throw customError('missing', locale())
      return expert
    },
    async saveCustom(input, enabled, expectedRevision) {
      const catalogExperts = await base()
      checkRevision(expectedRevision)
      const parsed = customExpertInputSchema.safeParse(input)
      if (!parsed.success || typeof enabled !== 'boolean') throw customError('invalid', locale())
      const value = parsed.data
      if (!divisions.includes(value.division) && !catalogExperts.some(item => item.division === value.division)) throw customError('division', locale())
      const state = read()
      if (value.slug !== undefined && !state.customExperts.some(item => item.slug === value.slug && !item.deleted)) throw customError('missing', locale())
      if (value.slug === undefined && state.customExperts.filter(item => !item.deleted).length >= CUSTOM_EXPERT_LIMIT) throw customError('limit', locale())
      const expert: CustomExpert = { ...value, slug: value.slug ?? `custom-${randomUUID()}` }
      const next = state.customExperts.filter(item => item.slug !== expert.slug)
      next.push(expert)
      assertUnique(summary(expert), [...catalogExperts, ...next.filter(item => !item.deleted && item.slug !== expert.slug).map(summary)])
      return persist({ customExperts: next, enabled: [...state.enabled.filter(slug => slug !== expert.slug), ...(enabled ? [expert.slug] : [])] }, expectedRevision)
    },
    async deleteCustom(slug, expectedRevision) {
      assertWritable(slug)
      checkRevision(expectedRevision)
      const state = read()
      if (!state.customExperts.some(item => item.slug === slug && !item.deleted)) throw customError('missing', locale())
      return persist({
        customExperts: state.customExperts.filter(item => item.slug !== slug),
        enabled: state.enabled.filter(item => item !== slug),
      }, expectedRevision)
    },
    async setEnabled(enabled, expectedRevision) {
      const catalogExperts = await base()
      checkRevision(expectedRevision)
      const state = read()
      const available = new Set(project(catalogExperts, state).experts.filter(expert => !expert.conflict).map(expert => expert.slug))
      if (enabled.some(slug => !available.has(slug))) throw customError('unavailable', locale())
      const next = [...new Set(enabled)]
      await mutateExpertSettings(store, [
        { op: 'set', path: ['customExperts'], value: activeRecords(state.customExperts) },
        { op: 'set', path: ['enabled'], value: next },
      ], expectedRevision, locale())
      return { enabled: next, revision: store.revision() }
    },
    async cleanupDeleted() {
      const state = read()
      if (!state.customExperts.some(item => item.deleted !== undefined || item.wasEnabled !== undefined)) return
      // 默认源及卸载回退无需访问设置区；快照与修订号之间没有异步间隙。
      const expectedRevision = store.revision()
      const records = activeRecords(state.customExperts)
      const deleted = new Set(state.customExperts.filter(item => item.deleted).map(item => item.slug))
      await mutateExpertSettings(store, [
        { op: 'set', path: ['customExperts'], value: records },
        { op: 'set', path: ['enabled'], value: state.enabled.filter(slug => !deleted.has(slug)) },
      ], expectedRevision, locale())
    },
  }
  return library
}
