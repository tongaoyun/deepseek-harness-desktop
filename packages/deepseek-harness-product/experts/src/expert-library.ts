import { TEAM_CUSTOM_ID, teamSchema, type ExpertTeam } from './team-contract.ts'
import { agentSpecManifest } from '@deepseek-harness/product/company-content'
import { ExpertPackageStore } from './expert-packages.ts'
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
  personalLibraries: schema.any().default({}),
  personalContentClaimed: schema.boolean().default(false),
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
  if (records.length > CUSTOM_EXPERT_LIMIT) throw customError('limit', locale)
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const expert of value.customExperts ?? []) {
    if (ids.has(expert.slug) || names.has(normalizeName(expert.name))) throw customError('duplicate', locale)
    ids.add(expert.slug)
    names.add(normalizeName(expert.name))
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
  /** Read the current catalog; an optional signal cancels source preparation and discards late results. */
  catalog(signal?: AbortSignal): Promise<CatalogSnapshot>
  getCustom(slug: string): Promise<CustomExpertInput & { slug: string }>
  getPrompt(slug: string, hash?: string): Promise<string>
  /** Cancellation stops catalog preparation before the atomic Settings transaction starts. */
  saveCustom(input: CustomExpertInput, enabled: boolean, expectedRevision: number, signal?: AbortSignal): Promise<CatalogSnapshot>
  /** Cancellation cannot roll back a dispatched Settings transaction. */
  deleteCustom(slug: string, expectedRevision: number, signal?: AbortSignal): Promise<CatalogSnapshot>
  /** Cancellation stops catalog preparation before the atomic Settings transaction starts. */
  setEnabled(enabled: string[], expectedRevision: number, signal?: AbortSignal): Promise<{ enabled: string[]; revision: number }>
}
export const normalizeName = (value: string): string => value.trim().toLowerCase()

const summary = (expert: CustomExpert): ExpertSummary => ({
  slug: expert.slug, name: expert.name, nameEn: expert.name,
  description: expert.description, descriptionEn: '', emoji: expert.emoji,
  division: expert.division, divisionZh: ZH_DIVISION[expert.division] ?? expert.division,
  avatar: expert.avatar, custom: true, packageVersion: expert.packageVersion, packageSha256: expert.packageSha256,
})
const overlaps = (a: ExpertSummary, b: ExpertSummary): boolean => a.slug === b.slug || !a.teamMember && !b.teamMember && [a.name, a.nameEn].some(name => [b.name, b.nameEn].some(other => normalizeName(name) === normalizeName(other)))

/** Project committed personal settings against an already prepared read-only catalog.
 * @param catalogExperts Read-only experts with their source-conflict flags.
 * @param state Current committed personal settings.
 * @param revision Native Settings revision for this state.
 * @returns Credential-free catalog without additional source reads.
 */
export function projectExpertCatalog(catalogExperts: readonly ExpertSummary[], state: Pick<AgencySettings, 'enabled' | 'customExperts'>,
  revision: number): CatalogSnapshot {
  const custom = (state.customExperts ?? []).map(summary)
  const experts = [...catalogExperts,
    ...custom.map(expert => ({ ...expert, conflict: [...catalogExperts, ...custom.filter(other => other !== expert)].some(other => overlaps(expert, other)) }))]
  const available = new Set(experts.filter(expert => !expert.conflict).map(expert => expert.slug))
  return { experts, enabled: [...new Set(state.enabled.filter(slug => available.has(slug)))], revision }
}

/** 合并只读基础名册与自定义数据；依赖宿主的持久化事务和修订号仲裁。 */
export function createExpertLibrary(
  base: (signal?: AbortSignal) => Promise<ReadonlyArray<ExpertSummary>>,
  store: ExpertSettingsStore,
  divisions: readonly string[],
  locale: () => 'zh' | 'en',
  packages?: ExpertPackageStore,
  prepare: () => Promise<void> = async () => {},
): AgencyExpertLibrary {
  const read = (): { enabled: string[]; customExperts: CustomExpert[] } => {
    const state = store.read()
    return { enabled: state.enabled, customExperts: z.array(customExpertSchema).parse(state.customExperts ?? []) }
  }
  const checkRevision = (revision: number): void => {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== store.revision()) throw customError('conflict', locale())
  }
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
    return projectExpertCatalog(projectCatalog(catalogExperts), state, store.revision())
  }
  const assertWritable = (slug: string): void => {
    if (!CUSTOM_EXPERT_SLUG.test(slug)) throw customError('readonly', locale())
  }
  const persist = async (state: ReturnType<typeof read>, revision: number, catalogExperts: readonly ExpertSummary[], signal?: AbortSignal): Promise<CatalogSnapshot> => {
    signal?.throwIfAborted()
    await mutateExpertSettings(store, [
      { op: 'set', path: ['customExperts'], value: state.customExperts },
      { op: 'set', path: ['enabled'], value: [...new Set(state.enabled)] },
    ], revision, locale())
    return project(catalogExperts, read())
  }
  const library: AgencyExpertLibrary = {
    async catalog(signal) {
      await prepare()
      signal?.throwIfAborted()
      const catalogExperts = await base(signal)
      signal?.throwIfAborted()
      const state = read()
      return project(catalogExperts, state)
    },
    async getCustom(slug) {
      await prepare()
      assertWritable(slug)
      const expert = read().customExperts.find(item => item.slug === slug)
      if (expert === undefined) throw customError('missing', locale())
      if (!packages) throw new Error('Personal expert package storage is unavailable')
      return packages.read(expert)
    },
    async getPrompt(slug, hash) {
      await prepare()
      const expert = read().customExperts.find(item => item.slug === slug)
      if (!expert || !packages) throw customError('missing', locale())
      return packages.prompt(hash ? { ...expert, packageSha256: hash, packageVersion: `0.0.0-${hash.slice(0, 56)}` } : expert)
    },
    async saveCustom(input, enabled, expectedRevision, signal) {
      await prepare()
      signal?.throwIfAborted()
      const catalogExperts = await base(signal)
      signal?.throwIfAborted()
      checkRevision(expectedRevision)
      const parsed = customExpertInputSchema.safeParse(input)
      if (!parsed.success || typeof enabled !== 'boolean') throw customError('invalid', locale())
      const value = parsed.data
      if (!divisions.includes(value.division) && !catalogExperts.some(item => item.division === value.division)) throw customError('division', locale())
      const state = read()
      if (value.slug !== undefined && !state.customExperts.some(item => item.slug === value.slug)) throw customError('missing', locale())
      if (value.slug === undefined && state.customExperts.length >= CUSTOM_EXPERT_LIMIT) throw customError('limit', locale())
      const slug = value.slug ?? (value.manifest ? agentSpecManifest(value.manifest).worker.suggested_name : `custom-${randomUUID()}`)
      const { prompt: _prompt, agents: _agents, manifest: _manifest, resources: _resources, ...metadata } = value
      if (!packages) throw new Error('Personal expert package storage is unavailable')
      const packageRef = await packages.save(slug, value)
      signal?.throwIfAborted()
      checkRevision(expectedRevision)
      const expert: CustomExpert = { ...metadata, slug, ...packageRef }
      const next = state.customExperts.filter(item => item.slug !== expert.slug)
      next.push(expert)
      assertUnique(summary(expert), [...catalogExperts, ...next.filter(item => item.slug !== expert.slug).map(summary)])
      return persist({ customExperts: next, enabled: [...state.enabled.filter(slug => slug !== expert.slug), ...(enabled ? [expert.slug] : [])] }, expectedRevision, catalogExperts, signal)
    },
    async deleteCustom(slug, expectedRevision, signal) {
      await prepare()
      signal?.throwIfAborted()
      assertWritable(slug)
      const catalogExperts = await base(signal)
      signal?.throwIfAborted()
      checkRevision(expectedRevision)
      const state = read()
      if (!state.customExperts.some(item => item.slug === slug)) throw customError('missing', locale())
      return persist({
        customExperts: state.customExperts.filter(item => item.slug !== slug),
        enabled: state.enabled.filter(item => item !== slug),
      }, expectedRevision, catalogExperts, signal)
    },
    async setEnabled(enabled, expectedRevision, signal) {
      await prepare()
      signal?.throwIfAborted()
      const catalogExperts = await base(signal)
      signal?.throwIfAborted()
      checkRevision(expectedRevision)
      const state = read()
      const available = new Set(project(catalogExperts, state).experts.filter(expert => !expert.conflict).map(expert => expert.slug))
      if (enabled.some(slug => !available.has(slug))) throw customError('unavailable', locale())
      const next = [...new Set(enabled)]
      await mutateExpertSettings(store, [
        { op: 'set', path: ['customExperts'], value: state.customExperts },
        { op: 'set', path: ['enabled'], value: next },
      ], expectedRevision, locale())
      signal?.throwIfAborted()
      const current = project(catalogExperts, read())
      return { enabled: current.enabled, revision: current.revision }
    },
  }
  return library
}
