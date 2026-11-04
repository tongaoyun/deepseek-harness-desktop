import { EXPERT_PACKAGE_SOURCE, importExpertPackage, type ExpertPackageSource } from './package-transfer.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CREATION_SERVICE, type CreationDrafts } from './creation.ts'
import type { CreationEditorData } from './remote-contract.ts'
import { publishedTeamSchema } from '@deepseek-harness/product/company-team'
import { AGENCY_TEAM_SERVICE, type AgencyTeamLibrary } from './team-library.ts'
import { nativeTeamMemberName } from './team-engine.ts'
import { teamText } from './team-i18n.ts'
import type { TeamInput } from '@deepseek-harness/product/company-team'
import type { TeamSnapshot, TeamEngineStatus } from './team-contract.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { CompanyContentSource } from '@deepseek-harness/product/protocol'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { AGENCY_AGENTS_DESCRIPTORS } from './remote-contract.ts'
import { TYPERT as generatedHost } from './generated/typert.host.js'
import { AGENCY_PERSONA_SERVICE, type AgencyPersonaSource } from './index.ts'
import { formatHost, readHostLocale } from './i18n.ts'
import { AGENCY_LIBRARY_SERVICE, type AgencyExpertLibrary } from './expert-library.ts'
import type { CatalogSnapshot, CustomExpertInput } from './expert-contract.ts'

function personaSource(ctx: Context): AgencyPersonaSource {
  try {
    const source = ctx.get(AGENCY_PERSONA_SERVICE) as AgencyPersonaSource | undefined
    if (source !== undefined) return source
  } catch (cause: unknown) {
    throw new Error(formatHost(readHostLocale(ctx), 'error.personaSourceUnavailable'), { cause })
  }
  throw new Error(formatHost(readHostLocale(ctx), 'error.personaSourceUnavailable'))
}

/** Retain native Host metadata while applying the product's semantic validators. */
const TYPERT = {
  ...generatedHost as TypertContribution,
  invocations: AGENCY_AGENTS_DESCRIPTORS,
} satisfies TypertContribution

/** 供客户端读取和保存已启用专家的顶层 Host Remote 服务。 */
export default class AgencyAgentsRemote extends TypertRemoteService {
  static inject = ['settings', 'typert']

  constructor(ctx: Context) {
    super(ctx, 'agencyAgents')
    this.ctx.typert.register(TYPERT)
  }

  /** Claim an explicitly confirmed draft for its original Session and one editor window.
   * @param sessionId - Session owning the tool result.
   * @param proposalId - Exact proposal confirmed by the human.
   * @param signal - Cancellation before the draft is claimed.
   * @returns Draft and current revision-checked editing inputs; rejects if unavailable.
   */
  @Remote('claimCreation')
  async claimCreation(sessionId: SessionId, proposalId: string, signal: AbortSignal): Promise<CreationEditorData> {
    signal.throwIfAborted()
    const drafts = this.ctx.get(CREATION_SERVICE) as CreationDrafts | undefined
    const catalog = await this.library().catalog(signal)
    signal.throwIfAborted()
    const teams = this.describeTeams(await this.teams().snapshot(undefined, signal))
    signal.throwIfAborted()
    const draft = drafts?.claim(SessionId(sessionId), proposalId)
    if (!draft) throw new Error(readHostLocale(this.ctx) === 'zh' ? '草案未确认、已过期或已在其他窗口打开，请重新生成预览' : 'Draft is unconfirmed, expired or already opened elsewhere. Generate a new preview.')
    return { draft, catalog, teams }
  }

  /** Import complete package bytes into a personal draft; saving remains explicit.
   * @param files - Complete base64-encoded package files.
   * @param signal - Native request cancellation.
   * @returns Editable package draft.
   */
  @Remote('importExpert')
  async importExpert(files: Record<string, string>, signal: AbortSignal): Promise<CustomExpertInput> {
    signal.throwIfAborted()
    return importExpertPackage(files)
  }

  /** Export the complete selected package, including binary resources.
   * @param slug - Selected expert identifier.
   * @param signal - Native request cancellation.
   * @returns Complete package and catalog metadata.
   */
  @Remote('exportExpert')
  async exportExpert(slug: string, signal: AbortSignal): Promise<{ resourceKey: string; files: Record<string, string>; catalog: Record<string, string> }> {
    signal.throwIfAborted()
    const source = this.ctx.get(EXPERT_PACKAGE_SOURCE) as ExpertPackageSource | undefined
    if (!source) throw new Error('Expert package source is unavailable')
    const value = await source.read(slug, signal)
    signal.throwIfAborted()
    return value
  }

  private teams(): AgencyTeamLibrary {
    const library = this.ctx.get(AGENCY_TEAM_SERVICE) as AgencyTeamLibrary | undefined
    if (!library) throw new Error(teamText(readHostLocale(this.ctx), '专家团服务不可用，请重新加载插件。'))
    return library
  }

  /**
   * 读取个人专家团及原生成员名称。
   * @param signal - 当前读取的原生 Remote 取消信号。
   * @returns 个人专家团和成员目录。
   */
  @Remote('getTeams')
  async getTeams(signal: AbortSignal): Promise<TeamSnapshot> {
    signal.throwIfAborted()
    const snapshot = await this.teams().snapshot(undefined, signal)
    signal.throwIfAborted()
    return this.describeTeams(snapshot)
  }

  /**
   * Export one saved team with immutable references to published company experts.
   * @param id - Personal team identifier.
   * @param expectedRevision - Revision read before preparing the submission.
   * @param signal - Native Remote cancellation for version and catalog reads.
   * @returns Resource key and Base64-encoded files for company review.
   */
  @Remote('exportTeam')
  async exportTeam(id: string, expectedRevision: number, signal: AbortSignal): Promise<{ resourceKey: string; files: Record<string, string> }> {
    signal.throwIfAborted()
    const company = this.ctx.get('companyContent') as CompanyContentSource | undefined
    const companyVersion = await company?.read(signal)
    signal.throwIfAborted()
    const snapshot = await this.teams().snapshot(undefined, signal)
    signal.throwIfAborted()
    const team = snapshot.teams.find(item => item.id === id && !('company' in item && item.company))
    if (!team || snapshot.revision !== expectedRevision) throw new Error(teamText(readHostLocale(this.ctx), '专家团已更新，请刷新后提交'))
    const catalog = await this.library().catalog(signal)
    signal.throwIfAborted()
    for (const member of team.members) {
      const expert = catalog.experts.find(item => item.slug === member.expertSlug && !item.conflict)
      if (!expert?.company || !member.expertVersion || !member.expertSha256) throw new Error(teamText(readHostLocale(this.ctx), '发布团队前，请先发布成员专家并选择公司专家版本。'))
    }
    signal.throwIfAborted()
    const latest = await this.teams().snapshot(undefined, signal)
    signal.throwIfAborted()
    const latestCompany = await company?.read(signal)
    signal.throwIfAborted()
    if (latest.revision !== expectedRevision || latestCompany?.sha256 !== companyVersion?.sha256) throw new Error(teamText(readHostLocale(this.ctx), '专家团已更新，请刷新后提交'))
    const { id: _id, ...definition } = team
    const key = 'teams/' + id.slice('team-custom-'.length)
    const content = publishedTeamSchema.parse({ schemaVersion: 1, id: key.slice('teams/'.length), team: definition })
    return { resourceKey: key, files: { [key + '.json']: Buffer.from(JSON.stringify(content)).toString('base64') } }
  }

  /**
   * 保存个人专家团，过期修订号拒绝写入。
   * @param team - 待保存的个人专家团。
   * @param enabled - 保存后的启用选择。
   * @param expectedRevision - 调用方读取的官方配置修订号。
   * @param signal - 当前请求的取消信号。
   * @returns 保存后的专家团快照。
   */
  @Remote('saveTeam')
  async saveTeam(team: TeamInput, enabled: boolean, expectedRevision: number, signal?: AbortSignal): Promise<TeamSnapshot> {
    signal?.throwIfAborted()
    const snapshot = await this.teams().save(team, enabled, expectedRevision, signal)
    signal?.throwIfAborted()
    return this.describeTeams(snapshot)
  }

  /**
   * 更新专家团选择。
   * @param id - 个人专家团标识。
   * @param enabled - 保存后的启用选择。
   * @param expectedRevision - 调用方读取的官方配置修订号。
   * @param signal - 当前请求的取消信号。
   * @returns 修改后的专家团快照。
   */
  @Remote('setTeamEnabled')
  async setTeamEnabled(id: string, enabled: boolean, expectedRevision: number, signal?: AbortSignal): Promise<TeamSnapshot> {
    signal?.throwIfAborted()
    const snapshot = await this.teams().setEnabled(id, enabled, expectedRevision, signal)
    signal?.throwIfAborted()
    return this.describeTeams(snapshot)
  }

  /**
   * 删除个人专家团。
   * @param id - 个人专家团标识。
   * @param expectedRevision - 调用方读取的官方配置修订号。
   * @param signal - 当前请求的取消信号。
   * @returns 删除后的专家团快照。
   */
  @Remote('deleteTeam')
  async deleteTeam(id: string, expectedRevision: number, signal?: AbortSignal): Promise<TeamSnapshot> {
    signal?.throwIfAborted()
    const snapshot = await this.teams().remove(id, expectedRevision, signal)
    signal?.throwIfAborted()
    return this.describeTeams(snapshot)
  }

  private describeTeams(snapshot: TeamSnapshot): TeamSnapshot {
    const engine = this.ctx.get('agencyAgentsTeamEngine') as (() => TeamEngineStatus) | undefined
    const nativeMembers = Object.fromEntries(snapshot.teams.flatMap(team => team.members.map(member => [nativeTeamMemberName(team.id, member.expertSlug), member.expertSlug])))
    return { ...snapshot, nativeMembers, ...(engine ? { engine: engine() } : {}) }
  }

  private library(): AgencyExpertLibrary {
    const library = this.ctx.get(AGENCY_LIBRARY_SERVICE) as AgencyExpertLibrary | undefined
    if (library === undefined) throw new Error(formatHost(readHostLocale(this.ctx), 'error.personaSourceUnavailable'))
    return library
  }

  /**
   * 返回动态名册，不预加载任何专家提示词正文。
   * @param refreshCompany - 是否同步检查团队目录。
   * @param signal - 当前读取的原生 Remote 取消信号；不取消共享的公司同步。
   * @returns 当前个人和团队专家目录。
   */
  @Remote('getCatalog')
  async getCatalog(refreshCompany: boolean, signal: AbortSignal): Promise<CatalogSnapshot> {
    signal.throwIfAborted()
    if (refreshCompany) await (this.ctx.get('companyContent') as CompanyContentSource | undefined)?.refresh(signal)
    signal.throwIfAborted()
    const catalog = await this.library().catalog(signal)
    signal.throwIfAborted()
    return catalog
  }

  /**
   * 读取可编辑的个人专家。
   * @param slug - 稳定专家标识。
   * @param signal - 当前读取的原生 Remote 取消信号。
   * @returns 可编辑的个人专家正文和元数据。
   */
  @Remote('getCustomExpert')
  async getCustomExpert(slug: string, signal: AbortSignal): Promise<CustomExpertInput> {
    signal.throwIfAborted()
    const expert = await this.library().getCustom(slug)
    signal.throwIfAborted()
    return expert
  }

  /**
   * 新建或更新自定义专家，同时提交启用状态；过期修订号拒绝写入。
   * @param expert - 待保存的个人专家。
   * @param enabled - 保存后的启用选择。
   * @param expectedRevision - 调用方读取的官方配置修订号。
   * @param signal - 当前请求的取消信号。
   * @returns 成功提交后的最新目录。
   */
  @Remote('saveCustomExpert')
  async saveCustomExpert(expert: CustomExpertInput, enabled: boolean, expectedRevision: number, signal?: AbortSignal): Promise<CatalogSnapshot> {
    signal?.throwIfAborted()
    const catalog = await this.library().saveCustom(expert, enabled, expectedRevision, signal)
    signal?.throwIfAborted()
    return catalog
  }

  /**
   * 删除个人专家，保留并发写入检查。
   * @param slug - 稳定专家标识。
   * @param expectedRevision - 调用方读取的官方配置修订号。
   * @param signal - 当前请求的取消信号。
   * @returns 删除完成后的最新目录。
   */
  @Remote('deleteCustomExpert')
  async deleteCustomExpert(slug: string, expectedRevision: number, signal?: AbortSignal): Promise<CatalogSnapshot> {
    signal?.throwIfAborted()
    const catalog = await this.library().deleteCustom(slug, expectedRevision, signal)
    signal?.throwIfAborted()
    return catalog
  }

  /**
   * 整体替换启用的专家 slug 列表。
   * @param enabled - 保存后的启用选择。
   * @param expectedRevision - 调用方读取的官方配置修订号。
   * @param signal - 当前请求的取消信号。
   * @returns 已提交的启用选择及修订号。
   */
  @Remote('setEnabled')
  async setEnabled(enabled: string[], expectedRevision: number, signal?: AbortSignal): Promise<{ enabled: string[]; revision: number }> {
    signal?.throwIfAborted()
    const result = await this.library().setEnabled(enabled, expectedRevision, signal)
    signal?.throwIfAborted()
    return result
  }

  /**
   * 按需读取一位专家的 persona 正文，避免将完整提示词随客户端名册预加载。
   * @param slug - 稳定专家标识。
   * @param division - 专家所属分类。
   * @param signal - 当前读取的原生 Remote 取消信号。
   * @returns 经当前访问检查读取的专家正文。
   */
  @Remote('getPrompt')
  async getPrompt(slug: string, division: string, signal: AbortSignal): Promise<{ prompt: string }> {
    signal.throwIfAborted()
    const result = await personaSource(this.ctx).getPrompt(slug, division, readHostLocale(this.ctx), undefined, signal)
    signal.throwIfAborted()
    return result
  }
}
