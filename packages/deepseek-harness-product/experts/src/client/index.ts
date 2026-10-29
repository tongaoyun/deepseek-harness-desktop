import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import { createExpertClientState, type ExpertClientState } from './client-state.ts'
import { commitBulk } from './bulk-operations.ts'
import { LibraryConfirm } from './library-ui.tsx'
import { CreationCard } from './creation-card.tsx'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { Button, Input } from './plugin-ui.ts'
import { SegmentedControl, SegmentedTabs, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { LibraryCard } from './library-ui.tsx'
import { IconPlus } from './team-shared.tsx'
import type { AgencyTeamsRemote } from './remote.ts'
import { TeamsPanel, unwrap, type TeamRemote } from './team-ui.tsx'
import { TEAM_CSS } from './team-style.ts'
import { TeamMenu } from './team-composer.tsx'
import { TEAM_REFERENCE_SOURCE, insertTeamReference, teamReference } from './team-reference.ts'
import { TeamLocaleContext } from './team-locale.ts'
import { teamText } from '../team-i18n.ts'
import type { ExpertTeam } from '../team-contract.ts'
import { PromptDialog } from "./prompt-dialog.ts";
import React from 'react'
import { CategorySelect } from './category-select.ts'
import { ExpertDiscovery, DISCOVERY_CSS } from './expert-discovery.ts'
import type { Context as CordisClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { InputTriggerSource, ReferenceInsert, TokenSpan } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: 拉入 api-remotes 的 ctx.remote 合并（client 侧 TypertClientRemote）。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: 拉入 ctx.locale 的 Context merge（跨插件协作只走服务，不做值导入）。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { EXPERT_DIVISION_ORDER, ZH_DIVISION, EN_DIVISION } from '../names.ts'
import { EXPERT_AVATAR_URLS } from './avatars.ts'
import { zh, en, type AgencyKey } from './locales.ts'
import { TYPERT_REMOTE } from './remote.ts'
import { DEFAULT_EXPERT_EMOJI, isExpertConflict, type CustomExpertInput, type CatalogSnapshot } from '../expert-contract.ts'
import { CustomExpertEditor, CustomDeleteDialog, CUSTOM_EDITOR_CSS } from './custom-editor.ts'
import { installNativeTeamNames } from './native-team-names.ts'
import type { AgencyCatalogRemote } from './remote.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** agency-agents 客户端词条命名空间。 */
    agency: AgencyKey
  }
}

const PLUGIN_ID = '@deepseek-harness/product-experts'
/** 本插件客户端词条字典命名空间。 */
const NS = 'agency'



interface LineIconProps {
  readonly className?: string
  readonly size?: number
  readonly strokeWidth?: number
  readonly 'aria-hidden'?: boolean
}

function lineIcon(props: LineIconProps, ...children: React.ReactNode[]): React.ReactElement {
  const { size = 24, strokeWidth = 2, ...rest } = props
  return React.createElement('svg', {
    ...rest,
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    focusable: false,
  }, ...children)
}

function Copy(props: LineIconProps): React.ReactElement {
  return lineIcon(props,
    React.createElement('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }),
    React.createElement('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }))
}

function EditIcon(props: LineIconProps): React.ReactElement {
  return lineIcon(props,
    React.createElement('path', { d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }),
    React.createElement('path', { d: 'm15 5 4 4' }))
}

function TrashIcon(props: LineIconProps): React.ReactElement {
  return lineIcon(props,
    React.createElement('path', { d: 'M3 6h18' }),
    React.createElement('path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }),
    React.createElement('path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }))
}

function Eye(props: LineIconProps): React.ReactElement {
  return lineIcon(props,
    React.createElement('path', { d: 'M2.06 12a10.7 10.7 0 0 1 19.88 0 10.7 10.7 0 0 1-19.88 0' }),
    React.createElement('circle', { cx: 12, cy: 12, r: 3 }))
}

function Search(props: LineIconProps): React.ReactElement {
  return lineIcon(props,
    React.createElement('circle', { cx: 11, cy: 11, r: 8 }),
    React.createElement('path', { d: 'm21 21-4.3-4.3' }))
}

type ClientContext = CordisClientContext


const DIVISION_ORDER = EXPERT_DIVISION_ORDER

type AvatarCategory = 'development' | 'design' | 'product' | 'research' | 'writing'

/** 头像只按视觉领域分池，目录筛选使用企业业务分类。 */
const AVATAR_CATEGORY_DIVISIONS: Readonly<Record<AvatarCategory, ReadonlySet<string>>> = {
  development: new Set(['engineering', 'testing']),
  design: new Set(['product', 'catalog']),
  product: new Set(['orders', 'supply-chain', 'warehouse', 'logistics', 'marketplace', 'support', 'company']),
  research: new Set(['finance', 'analytics']),
  writing: new Set(['marketing', 'specialized']),
}

interface ExpertView {
  readonly slug: string
  readonly name: string
  readonly nameEn: string
  readonly emoji: string
  readonly division: string
  readonly divisionZh: string
  readonly divisionEn: string
  readonly description: string
  readonly descriptionEn: string
  readonly conflict?: boolean
  readonly company?: boolean
  readonly teamMember?: boolean
  readonly custom?: boolean
  readonly avatar?: number
}

interface ExpertGroup<T extends ExpertView> {
  readonly division: string
  readonly divisionZh: string
  readonly experts: T[]
}


/** 按当前语言比较专家显示名，供设置页和菜单分组排序。 */
export function compareExpertName(
  a: { readonly name: string; readonly nameEn: string },
  b: { readonly name: string; readonly nameEn: string },
  active: 'zh' | 'en',
): number {
  const left = active === 'en' ? a.nameEn : a.name
  const right = active === 'en' ? b.nameEn : b.name
  return left.localeCompare(right, active === 'en' ? 'en' : 'zh')
}

function groupByDivision<T extends ExpertView>(list: ReadonlyArray<T>, active: 'zh' | 'en'): ExpertGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const e of list) {
    const arr = groups.get(e.division) ?? []
    arr.push(e)
    groups.set(e.division, arr)
  }
  return [...new Set([...DIVISION_ORDER, ...groups.keys()])].filter((d) => groups.has(d)).map((d) => ({
    division: d,
    divisionZh: ZH_DIVISION[d] ?? d,
    experts: (groups.get(d) ?? []).slice().sort((a, b) => compareExpertName(a, b, active)),
  }))
}

/** 设置页检索用的专家字段，避免把完整视图类型泄漏到筛选逻辑。 */
export interface ExpertSearchable {
  readonly slug: string
  readonly name: string
  readonly nameEn: string
  readonly division: string
  readonly divisionZh: string
  readonly divisionEn: string
  readonly description: string
  readonly descriptionEn: string
}

/** 规范化检索词：兼容全角字符，合并空白并转小写，便于中英文统一匹配。 */
export function normalizeExpertQuery(query: string): string {
  return query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

/** 按标识、名称、分区或简介做多关键词包含匹配；空检索视为全部命中。 */
export function matchExpertQuery(expert: ExpertSearchable, query: string): boolean {
  const q = normalizeExpertQuery(query)
  if (q === '') return true
  const fields = [
    ...(!expert.slug.startsWith('custom-') ? [expert.slug] : []),
    expert.name,
    expert.nameEn,
    expert.division,
    expert.divisionZh,
    expert.divisionEn,
    expert.description,
    expert.descriptionEn,
  ].map(normalizeExpertQuery)
  return q.split(' ').every((term) => fields.some((field) => /^[a-z0-9]+$/u.test(term)
    ? (field.match(/[a-z0-9]+/gu) ?? []).some(word => term.length <= 2 ? word === term : word.startsWith(term))
    : field.includes(term)))
}

/** 先按分区收窄，再按检索词过滤。division 为空表示全部分类。 */
export function filterExperts<T extends ExpertSearchable>(
  list: ReadonlyArray<T>,
  options: { readonly query?: string; readonly division?: string },
): T[] {
  const division = options.division ?? ''
  return list.filter((expert) => (division === '' || expert.division === division) && matchExpertQuery(expert, options.query ?? ''))
}

/** 目录分类筛选值：空值表示全部，企业分类按业务流程排列。 */
export function expertDivisionFilterValues(): string[] {
  return ['', ...DIVISION_ORDER]
}

/** 将已启用专家稳定地移到前面，两组内部顺序不变且不修改输入数组。 */
export function sortExpertsByEnabled<T extends { readonly slug: string }>(
  list: ReadonlyArray<T>,
  enabled: ReadonlySet<string>,
): T[] {
  const active: T[] = []
  const inactive: T[] = []
  for (const expert of list) {
    if (enabled.has(expert.slug)) active.push(expert)
    else inactive.push(expert)
  }
  return [...active, ...inactive]
}

/** 按首次进入设置页时保存的顺序排列；不在单项启停后重新排序。 */
export function sortExpertsByOrder<T extends { readonly slug: string }>(
  list: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
): T[] {
  const positions = new Map(order.map((slug, index) => [slug, index]))
  return list.slice().sort((left, right) => {
    const leftPosition = positions.get(left.slug) ?? Number.MAX_SAFE_INTEGER
    const rightPosition = positions.get(right.slug) ?? Number.MAX_SAFE_INTEGER
    return leftPosition - rightPosition
  })
}

/** 根据 slug 稳定分配复用头像；空头像池安全回退为第 0 项。 */
export function expertAvatarIndex(slug: string, avatarCount: number): number {
  if (avatarCount <= 0) return 0
  let hash = 2166136261
  for (let index = 0; index < slug.length; index += 1) {
    hash = Math.imul(hash ^ slug.charCodeAt(index), 16777619)
  }
  return (hash >>> 0) % avatarCount
}

/** 五大业务分类各自使用独立头像池，降低同屏重复并保持专家形象稳定。 */
export const EXPERT_AVATAR_POOL_INDEXES = {
  development: [1, 5, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  writing: [3, 7, 19, 20, 21, 22, 23, 24],
  product: [0, 8, 25, 26, 27, 28],
  research: [2, 4, 29, 30, 31, 32],
  design: [6, 33, 34, 35],
} as const satisfies Readonly<Record<AvatarCategory, ReadonlyArray<number>>>

const ALL_EXPERT_AVATAR_INDEXES = Object.values(EXPERT_AVATAR_POOL_INDEXES).flat()

function expertCategoryForDivision(division: string): AvatarCategory | undefined {
  return (Object.entries(AVATAR_CATEGORY_DIVISIONS) as ReadonlyArray<
    readonly [AvatarCategory, ReadonlySet<string>]
  >).find(([, divisions]) => divisions.has(division))?.[0]
}

/** 按分类及标识稳定分配头像，不依赖预置专家名册。 */
export function expertAvatarIndexForDivision(slug: string, division: string): number {
  const category = expertCategoryForDivision(division)
  const pool: readonly number[] = category === undefined ? ALL_EXPERT_AVATAR_INDEXES : EXPERT_AVATAR_POOL_INDEXES[category]
  return pool[expertAvatarIndex(slug, pool.length)] ?? 0
}

/** 按当前 locale 取专家显示名：en 用花名册英文名，其余用中文名。 */
function displayName(e: ExpertView, active: 'zh' | 'en'): string {
  return active === 'en' ? e.nameEn : e.name
}

/** 候选名称只保留专家名。选择菜单使用头像，不再把 emoji 写进可见文字。 */
export function inputTriggerCandidateName(
  expert: Pick<ExpertView, 'name' | 'nameEn'>,
  active: 'zh' | 'en',
): string {
  return active === 'en' ? expert.nameEn : expert.name
}

function menuAvatar(expert: Pick<ExpertView, 'slug' | 'division' | 'custom' | 'avatar'>): string {
  const index = expert.custom ? expert.avatar ?? 0 : expertAvatarIndexForDivision(expert.slug, expert.division)
  return EXPERT_AVATAR_URLS[index] ?? EXPERT_AVATAR_URLS[0]
}

/** 统一生成宿主可识别的专家提及文本，避免重复 @ 或将展示 emoji 写入草稿。 */
export function formatExpertMention(name: string): string {
  return `@${name.trim().replace(/^@+/, '')}`
}

/** 使用不换行空格分隔专家引用，避免消息渲染层折叠相邻 chip 的普通空格。 */
export function formatExpertMentionInsertion(name: string): string {
  return `${formatExpertMention(name)}\u00A0`
}

/** 仅公开已启用专家的本地化名称，供宿主扫描并装饰 @名称 纯文本引用。 */
export function buildExpertMentionLexicon(
  experts: ReadonlyArray<{ readonly slug: string; readonly name: string; readonly nameEn: string }>,
  enabled: ReadonlySet<string>,
  active: 'zh' | 'en',
): string[] {
  return experts
    .filter((expert) => enabled.has(expert.slug))
    .map((expert) => active === 'en' ? expert.nameEn : expert.name)
}

/** 按当前 locale 取 @ 菜单分组标题；未知分区保留原值，便于扩展来源安全降级。 */
export function inputTriggerSourceName(division: string, active: 'zh' | 'en'): string {
  const divisions = active === 'en' ? EN_DIVISION : ZH_DIVISION
  return divisions[division] ?? division
}

/** 引用所有者必须跨语言稳定，避免草稿中的 chip 在切换界面语言后失去序列化器。 */
export function inputTriggerSourceId(division: string): string {
  return `${PLUGIN_ID}:${division}`
}

/** 专家引用使用宿主内置代理图标。 */
export interface ExpertReference extends ReferenceInsert {
  readonly appearance: 'session'
}

/** 将专家投影为宿主的原子引用；slug 仅作为内部 ref，不进入标签、剪贴板或模型文本。 */
export function buildExpertReference(
  expert: Pick<ExpertView, 'slug' | 'name' | 'nameEn' | 'emoji' | 'division' | 'custom'>,
  active: 'zh' | 'en',
): ExpertReference {
  const name = active === 'en' ? expert.nameEn : expert.name
  return {
    source: inputTriggerSourceId(expert.division),
    ref: expert.slug,
    label: name,
    appearance: 'session',
    clipboardText: formatExpertMentionInsertion(name),
  }
}

/** 名册更新后仍可发送旧草稿，但不向用户或模型泄露已失效的内部标识。 */
export function expertMentionFromReference(slug: string, active: 'zh' | 'en', experts: readonly ExpertView[] = []): string {
  const expert = experts.find((item) => item.slug === slug)
  if (expert === undefined) {
    return active === 'en'
      ? '@Removed expert (please reselect)\u00A0'
      : '@已移除专家（请重新选择）\u00A0'
  }
  return formatExpertMentionInsertion(displayName(expert, active))
}

/** 按当前 locale 取专家简介：en 用原始英文描述（缺失时回退中文），其余用中文描述。 */
function displayDescription(e: ExpertView, active: 'zh' | 'en'): string {
  return active === 'en' && e.descriptionEn !== '' ? e.descriptionEn : e.description
}

// @ 菜单里使用稳定分区 ID；这里放开名称列，让带图标的专家名称整行显示。
const EXPERT_MENU_ITEM_SELECTORS = DIVISION_ORDER
  .map((division) => inputTriggerSourceId(division))
  .map((name) => `[role="listbox"] div[data-source=${JSON.stringify(name)}] ~ button`)
const MENU_NAME_OVERRIDE = EXPERT_MENU_ITEM_SELECTORS
  .map((selector) => `${selector} span:last-child`)
  .join(',')
const EXPERT_MENU_NAME_STYLE = 'flex:1 1 auto;max-width:none;min-width:0'
export const COMPOSER_CSS = '.aag-btn-wrap{position:relative;order:1;display:inline-flex;flex:0 0 auto}.aag-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 8px;white-space:nowrap;border:none;border-radius:999px;corner-shape:round;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:500;cursor:pointer}.aag-btn:hover,.aag-btn[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.aag-btn:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}.aag-btn>svg{flex:none}.aag-menu{position:absolute;bottom:calc(100% + 4px);left:0;box-sizing:border-box;padding:4px;display:flex;flex-direction:column;gap:0;width:300px;max-width:360px;max-height:calc(100dvh - 24px);overflow-y:auto;border:0;border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-2);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);z-index:10000}.aag-menu[data-placement="below"]{top:calc(100% + 4px);bottom:auto}.aag-menu-title{padding:8px 10px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}.aag-menu-item{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:var(--dsw-radius-md,10px);background:transparent;cursor:pointer;text-align:left;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);box-sizing:border-box}.aag-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}.aag-menu-empty{padding:8px 10px;color:var(--dsw-alias-label-secondary);font-size:13px}'
// 设置页版式对齐 dsh-skills-manager：工具栏 + 汇总条 + 分组卡片 + 行内启停按钮。
export const SETTINGS_CSS = `
.aag-section{box-sizing:border-box;display:flex;min-width:0;width:100%;flex-direction:column;gap:16px;padding:0 0 32px;color:var(--dsw-alias-label-primary)}
.aag-toolbar{display:flex;flex-direction:column;gap:8px;padding-bottom:12px}
.aag-title-row{display:flex;align-items:center;gap:8px 12px;min-width:0;flex-wrap:wrap}
.aag-settings-links{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.aag-settings-links>span[data-mpi-check]{display:inline-flex;align-items:center}
.aag-title{margin:0;font-size:20px;line-height:28px;font-weight:650;letter-spacing:-.2px}
.aag-read-loading{display:flex;align-items:center;min-height:40px;color:var(--dsw-alias-label-tertiary)}
.aag-note{overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.aag-error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px}
.aag-filters{display:flex;align-items:flex-end;gap:10px;width:100%;min-width:0;max-width:100%}
.aag-field{display:flex;min-width:0;flex:1;flex-direction:column;gap:6px}
.aag-field-source,.aag-field-category,.aag-field-status{flex:0 0 auto;width:auto;max-width:100%}
.aag-field-search{flex:1 1 0;min-width:0;max-width:100%}
.aag-search-wrap{display:flex;align-items:center;width:100%;min-width:0;max-width:100%}
.aag-search{box-sizing:border-box;width:100%;min-width:0;max-width:100%}
.aag-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:28px 16px;border:0.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center}
@media (max-width:560px){.aag-toolbar,.aag-title-row{flex-wrap:wrap}.aag-filters{flex-direction:column;align-items:stretch}.aag-field-category,.aag-field-search{flex:none}}
`
// 标题固定占两行。卡片高度必须和这个占位一致，虚拟列表不能再测量视口里的第一张卡。
const EXPERT_CARD_GAP = 10
const EXPERT_CARD_NAME_HEIGHT = 44
const EXPERT_CARD_HEIGHT = 191
const EXPERT_CARD_ROW = EXPERT_CARD_HEIGHT + EXPERT_CARD_GAP

export const CARD_SETTINGS_CSS = `
.aag-section{container-type:inline-size}
.aag-toolbar{display:flex;align-items:flex-start;gap:12px;min-height:36px;padding:0}
.aag-title-row{display:flex;flex:1;align-items:center;gap:8px 12px;min-width:0;flex-wrap:wrap}
.aag-title{font-size:24px;line-height:32px;font-weight:600;letter-spacing:-.4px;white-space:nowrap}
.aag-header-stat{display:inline-flex;align-items:baseline;gap:5px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:nowrap}
.aag-header-stat strong{color:var(--dsw-alias-label-primary);font-weight:500}
.aag-card-action:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}
.aag-card-filters{align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:8px 12px;min-width:0}
.aag-filter-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-left:auto;flex:0 1 auto;max-width:100%}
.aag-icon-btn{box-sizing:border-box;width:22px!important;min-width:22px!important;height:22px!important;padding:0!important;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center}
.aag-icon-btn svg{display:block;width:16px;height:16px}
.aag-icon-btn:hover:not(:disabled):not(.is-danger){color:var(--dsw-alias-link)!important;border-color:var(--dsw-alias-link)!important;background:transparent!important}
.aag-card-filters .aag-field-source,.aag-card-filters .aag-field-category,.aag-card-filters .aag-field-status{flex:0 0 auto;width:auto;max-width:none}
.aag-card-filters .aag-field-search{flex:1 1 0;min-width:0}
.aag-card-filters .aag-field>span{display:inline-flex;width:auto;max-width:none}
@media(max-width:560px){.aag-card-filters{align-items:stretch;gap:8px}.aag-card-filters .aag-field{flex:1 1 120px;width:auto}.aag-card-filters .aag-field-search{flex:1 1 100%}.aag-filter-actions{margin-left:0}}
.aag-search-wrap{display:flex;align-items:center;width:100%;min-width:0;max-width:100%}
.aag-search-wrap>.aag-search{width:100%;min-width:0;max-width:100%}
.aag-search-wrap>.aag-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.aag-expert-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;margin-top:2px}
.aag-expert-window{position:relative;margin-top:2px;overflow-anchor:none}.aag-expert-window>.aag-expert-grid{position:absolute;right:0;left:0;margin-top:0}
.aag-expert-card{display:grid;box-sizing:border-box;min-width:0;height:${EXPERT_CARD_HEIGHT}px;min-height:${EXPERT_CARD_HEIGHT}px;overflow:hidden;grid-template-rows:minmax(141px,1fr) 32px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1)}
.aag-expert-card:hover{border-color:var(--dsw-alias-border-l3)}
.aag-card-body{position:relative;display:flex;flex-direction:column;min-width:0;padding:12px 14px 10px;height:100%;box-sizing:border-box}
.aag-card-header{position:relative;display:grid;min-width:0;grid-template-columns:44px minmax(0,1fr);column-gap:10px;align-items:center}
.aag-expert-avatar{display:block;width:44px;height:44px;border:0;border-radius:50%;corner-shape:round;background:var(--dsw-alias-bg-layer-3);object-fit:cover;object-position:center 20%}
.aag-card-identity{display:flex;min-width:0;flex-direction:column;padding-right:48px}
.aag-card-name{display:flex;flex-direction:column;justify-content:flex-start;overflow:hidden;height:${EXPERT_CARD_NAME_HEIGHT}px;min-height:${EXPERT_CARD_NAME_HEIGHT}px}
.aag-card-name-text{display:-webkit-box;overflow:hidden;font-size:16px;font-weight:650;line-height:22px;-webkit-box-orient:vertical;-webkit-line-clamp:1}
.aag-card-division{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.aag-division-pill{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.06));border:0.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1));color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;letter-spacing:0.2px}
.aag-card-description{flex:1;display:-webkit-box;margin:8px 0 0;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;-webkit-box-orient:vertical;-webkit-line-clamp:3}
.aag-card-actions{display:flex;align-items:stretch;height:32px;min-height:32px;max-height:32px;border-top:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.aag-card-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:1 1 0;min-width:0;height:32px;min-height:32px;padding:0 8px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:500;line-height:18px;white-space:nowrap;cursor:pointer;transition:color 120ms ease,background 120ms ease}
.aag-card-action svg{flex-shrink:0;width:15px;height:15px;opacity:.85;transition:opacity 120ms ease}
.aag-card-action:hover:not(:disabled) svg{opacity:1}
.aag-card-action+.aag-card-action{border-left:0.5px solid var(--dsw-alias-border-l2)}
.aag-card-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aag-card-action:disabled{opacity:.5;cursor:default}
.aag-card-action-danger{color:var(--dsw-alias-state-error-primary)}
.aag-card-action-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-tertiary,rgba(239,68,68,0.1))}
.aag-card-action span.aag-card-action-text{display:none}
.aag-card-action{padding:0 4px}
.aag-switch{position:absolute;top:0;right:0;display:flex;align-items:center;flex-direction:column;gap:3px}
.aag-switch-state{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
.aag-prompt-body{display:block;box-sizing:border-box;height:min(560px,calc(100vh - 220px));min-height:240px;margin:0;padding:12px 14px;resize:none;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:1.75;letter-spacing:0.01em;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-md,12px)}
.aag-prompt-body::-webkit-scrollbar{width:6px;height:6px}
.aag-prompt-body::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l3);border-radius:999px}
.aag-prompt-body:focus,.aag-prompt-body:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none;box-shadow:none}
@container (max-width:519px){.aag-expert-grid{grid-template-columns:1fr}.aag-title-row{gap:8px 12px}.aag-settings-links{flex-basis:100%}}
@container (max-width:430px){.aag-card-body{grid-template-columns:40px minmax(0,1fr);column-gap:10px}.aag-expert-avatar{width:40px;height:40px}.aag-card-name{font-size:16px;line-height:22px}}
`

import { PLUGIN_UI_CSS } from './plugin-ui.ts'

export const CSS = PLUGIN_UI_CSS + TEAM_CSS + COMPOSER_CSS + SETTINGS_CSS + CARD_SETTINGS_CSS + DISCOVERY_CSS
  + MENU_NAME_OVERRIDE + `{${EXPERT_MENU_NAME_STYLE}}`

/** 本插件 Remote 命名空间的 client 侧 face（ctx.remote.agencyAgents 的形状）。 */
type AgencyAgentsRemoteApi = AgencyCatalogRemote & Partial<AgencyTeamsRemote>
  & Pick<TypertRemoteNamespaceMap['agencyAgents'], 'getEnabled' | 'setEnabled' | 'getPrompt'>

interface EnabledState {
  readonly enabled: ReadonlySet<string>
  readonly revision: number
  readonly experts: readonly ExpertView[]
}

/** 将写失败映射到 agency 词条；非冲突错误返回 null，由调用方展示原始消息。 */
export function writeErrorKey(error: unknown, options?: { readonly refreshed?: boolean }): AgencyKey | null {
  if (isExpertConflict(error)) {
    if (options?.refreshed === true) return 'error.conflict.refreshed'
    if (options?.refreshed === false) return 'error.conflict.refreshFailed'
    return 'error.conflict'
  }
  return null
}

/** 写失败时的用户可见文案。冲突场景必须显式传入 refreshed；传入 t 时按当前语言翻译。 */
export function writeErrorMessage(
  error: unknown,
  options?: { readonly refreshed?: boolean; readonly t?: (key: AgencyKey) => string },
): string {
  const key = writeErrorKey(error, options)
  if (key !== null) return (options?.t ?? ((item: AgencyKey) => zh[item]))(key)
  return error instanceof Error ? error.message : String(error)
}

export async function writeEnabled(remote: AgencyAgentsRemoteApi, cache: ExpertClientState, enabled: ReadonlySet<string>, expectedRevision: number, signal?: AbortSignal): Promise<EnabledState> {
  signal?.throwIfAborted()
  const result = signal === undefined
    ? await remote.setEnabled([...enabled], expectedRevision)
    : await remote.setEnabled([...enabled], expectedRevision, signal)
  if (!result.ok) throw result.error
  signal?.throwIfAborted()
  return cache.catalog.acceptEnabled(result.value)
}

function expertIcon(): React.ReactElement {
  return React.createElement('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    React.createElement('path', { d: 'M8 2.5l1.15 2.35 2.35 1.15-2.35 1.15L8 9.5l-1.15-2.35L4.5 6l2.35-1.15z' }),
    React.createElement('path', { d: 'M12.75 10.25l.55 1.2 1.2.55-1.2.55-.55 1.2-.55-1.2-1.2-.55 1.2-.55z' }))
}

function teamTabIcon(): React.ReactElement {
  return React.createElement('svg', { viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    React.createElement('circle', { cx: 6, cy: 5, r: 2.5 }),
    React.createElement('path', { d: 'M2 13.5v-.75A3.25 3.25 0 0 1 5.25 9.5h1.5A3.25 3.25 0 0 1 10 12.75v.75' }),
    React.createElement('circle', { cx: 11.5, cy: 5.5, r: 2 }),
    React.createElement('path', { d: 'M11 9.5a2.75 2.75 0 0 1 3 2.75v1.25' }))
}

/** 工具栏菜单不能接管焦点，否则 Lexical 无法按检测坐标插入原子引用。 */
export function keepComposerFocus(event: { preventDefault(): void }): void {
  event.preventDefault()
}

export type ExpertMenuPlacement = 'above' | 'below'

export interface ExpertMenuPosition {
  readonly placement: ExpertMenuPlacement
  readonly maxHeight: number
}

/**
 * 让浮层始终留在可视区域内。输入框通常贴近底部，因此默认向上展开；
 * 当上方空间更小时，改为向下展开并将列表限制在实际可滚动的高度内。
 */
export function resolveExpertMenuPosition(
  trigger: Pick<DOMRect, 'top' | 'bottom'>,
  viewportHeight: number,
): ExpertMenuPosition {
  const gap = 4
  const viewportInset = 12
  const above = Math.max(0, Math.floor(trigger.top - gap - viewportInset))
  const below = Math.max(0, Math.floor(viewportHeight - trigger.bottom - gap - viewportInset))
  return above >= below
    ? { placement: 'above', maxHeight: above }
    : { placement: 'below', maxHeight: below }
}

/** 输入机暴露给工具栏的最小原子引用写入面，避免依赖 slot 的非标准 owner 参数。 */
export interface ReferenceInsertionTarget {
  readonly state: {
    getSnapshot(): {
      readonly draft: string
      readonly draftRev: number
      readonly occurrences?: ReadonlyArray<{ readonly source: string; readonly offset: number; readonly length?: number }>
    }
  }
  insertReference(reference: ReferenceInsert, span: TokenSpan): boolean
  /** 正文通过宿主的带修订号插入事件写入，不重置引用和附件。 */
  insertText?(text: string, span: TokenSpan): boolean
  notify?(level: 'info' | 'error', text: string): void
}

/** 原生 Session 服务的只读定位能力，不另建兼容接口。 */
/** 全局目录入口没有 sessionId 时，按原生主视图 retain 查找目标。 */
export function resolveTargetSessionId(
  sessions: Pick<ISessions, 'list'>,
  sessionId?: SessionId,
): SessionId | undefined {
  if (sessionId !== undefined) return sessionId
  return Object.values(sessions.list.getSnapshot().byId)
    .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

export function resolveReferenceInsertionTarget(
  sessions: Pick<ISessions, 'list' | 'scope'>,
  sessionId?: SessionId,
  getInput?: (actx: NonNullable<ReturnType<ISessions['scope']>>) => ReferenceInsertionTarget | undefined,
): ReferenceInsertionTarget | undefined {
  const targetSessionId = resolveTargetSessionId(sessions, sessionId)
  if (targetSessionId === undefined) return undefined
  const actx = sessions.scope(targetSessionId)
  return actx === undefined ? undefined : getInput?.(actx)
}

/** 将宿主剪贴板草稿转换为插入接口使用的单字符引用坐标。 */
export function expertDetectText(snapshot: ReturnType<ReferenceInsertionTarget['state']['getSnapshot']>): string {
  let draft = snapshot.draft
  // 宿主公开 draft 为剪贴板文本；插入事件的坐标把每个原生引用压缩成一个字符。
  for (const occurrence of [...(snapshot.occurrences ?? [])].sort((a, b) => b.offset - a.offset)) {
    const length = occurrence.length ?? 1
    if (occurrence.offset < 0 || length < 1 || occurrence.offset + length > draft.length) continue
    draft = draft.slice(0, occurrence.offset) + '\uFFFC' + draft.slice(occurrence.offset + length)
  }
  return draft
}

function expertReferencePrefixEnd(snapshot: ReturnType<ReferenceInsertionTarget['state']['getSnapshot']>): number {
  const draft = expertDetectText(snapshot)
  let end = 0
  while (draft[end] === '\uFFFC') {
    end += 1
    if (/\s/u.test(draft[end] ?? '') && draft[end] !== '\n') end += 1
  }
  return end
}

/** 通过当前会话的输入机插入 chip；新增专家始终追加在已有专家之后。 */
export function insertExpertReference(
  target: ReferenceInsertionTarget | undefined,
  reference: ReferenceInsert,
  example?: string,
  triggerSpan?: TokenSpan,
  exampleFailureMessage?: string,
): boolean {
  if (target === undefined) return false
  const snapshot = target.state.getSnapshot()
  const offset = expertReferencePrefixEnd(snapshot)
  const span = triggerSpan ?? {
    start: offset,
    end: offset,
    draftRev: snapshot.draftRev,
  }
  const detectText = expertDetectText(snapshot)
  const remaining = detectText.slice(0, span.start) + detectText.slice(span.end)
  const inserted = target.insertReference(reference, span)
  // 已有任务正文时不追加模板；再次选专家也不会重复填入。
  if (inserted && example !== undefined && remaining.replace(/\uFFFC/gu, '').trim() === '') {
    const fillExample = (): void => {
      const next = target.state.getSnapshot()
      const nextText = expertDetectText(next)
      // A later content revision belongs to another edit, even when its body is empty.
      if (next.draftRev > snapshot.draftRev + 1) return
      // 键盘选择处于宿主编辑事务内，等引用提交后重新读取；用户新增正文优先。
      if (next.draftRev !== snapshot.draftRev && nextText.replace(/\uFFFC/gu, '').trim() !== '') return
      let applied = false
      try {
        applied = next.draftRev !== snapshot.draftRev && target.insertText?.(`\n\n${example}`, {
          start: nextText.length, end: nextText.length, draftRev: next.draftRev,
        }) === true
      } catch {
        // 引用已经插入成功，正文事件异常也只提示示例失败，避免重试造成重复标签。
        applied = false
      }
      if (!applied && exampleFailureMessage !== undefined) target.notify?.('error', exampleFailureMessage)
    }
    // Lexical 在外层键盘事务结束后才排入提交微任务，必须让出整个事件循环。
    if (target.state.getSnapshot().draftRev === snapshot.draftRev) setTimeout(fillExample, 0)
    else fillExample()
  }
  return inserted
}

/** 工具栏只能写入原生 chip；返回 false 供界面保留菜单并提示失败原因。 */
export function insertSelectedExpert(
  slug: string,
  active: 'zh' | 'en',
  insertReference: ((reference: ReferenceInsert) => boolean) | undefined,
  experts: readonly ExpertView[] = [],
): boolean {
  const expert = experts.find((item) => item.slug === slug)
  return expert !== undefined && insertReference?.(buildExpertReference(expert, active)) === true
}

type ButtonProps = PropsLocale<'agency'> & {
  readonly remote: AgencyAgentsRemoteApi
  readonly cache: ExpertClientState
  /** 由 session slot 的 inject 回调注入，永远绑定当前编辑器所属会话。 */
  readonly insertReference?: (reference: ReferenceInsert) => boolean
  /** 异步启用前锁定目标编辑器，避免切换会话后把标签插入其他草稿。 */
  readonly prepareInsertion?: () => (reference: ReferenceInsert) => boolean
  /** 当前 locale 读取器（locale 切换后框架以新 t 重渲染，名称随之刷新）。 */
  readonly prepareTeamSelection?: () => (team: ExpertTeam, example?: string) => boolean | Promise<boolean>
  readonly getActive: () => 'zh' | 'en'
}

export function AgentsButton(props: ButtonProps): React.ReactElement {
  const [mode, setMode] = React.useState<'experts' | 'teams'>('experts')
  const [open, setOpen] = React.useState(false)
  const [insertError, setInsertError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const working = React.useRef(false)
  const epoch = React.useRef(0)
  const triggerRef = React.useRef<HTMLSpanElement | null>(null)
  const menuId = React.useId()
  const [menuPosition, setMenuPosition] = React.useState<ExpertMenuPosition | undefined>()
  const [menuLeft, setMenuLeft] = React.useState(0)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const catalog = React.useSyncExternalStore(
    listener => props.cache.catalog.subscribe(listener),
    () => props.cache.catalog.getSnapshot(),
  )
  const close = (restoreFocus = false): void => {
    epoch.current++
    setOpen(false)
    if (restoreFocus) triggerRef.current?.querySelector('button')?.focus()
  }
  React.useEffect(() => () => { epoch.current++ }, [])

  React.useLayoutEffect(() => {
    if (!open) return
    const updatePosition = (): void => {
      const root = rootRef.current
      if (root === null) return
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight
      const next = resolveExpertMenuPosition(root.getBoundingClientRect(), viewportHeight)
      const rect = root.getBoundingClientRect()
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth
      const width = Math.min(340, viewportWidth - 24)
      setMenuLeft(Math.max(12 - rect.left, Math.min(0, viewportWidth - 12 - width - rect.left)))
      setMenuPosition((current) => current?.placement === next.placement && current.maxHeight === next.maxHeight ? current : next)
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    const visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', updatePosition)
    visualViewport?.addEventListener('scroll', updatePosition)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updatePosition)
    if (rootRef.current !== null) observer?.observe(rootRef.current)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      visualViewport?.removeEventListener('resize', updatePosition)
      visualViewport?.removeEventListener('scroll', updatePosition)
      observer?.disconnect()
    }
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (ev: PointerEvent): void => {
      const target = ev.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[role="dialog"], .dsh-primitives-menu, [role="menu"]')) return
      close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const load = (): void => {
    if (working.current) return
    const request = epoch.current
    setInsertError(null)
    // 名册已在缓存里时后台刷新，避免搜索框下闪「正在处理…」。
    if (catalog.experts.length === 0) setBusy(true)
    working.current = true
    void props.cache.catalog.refresh().catch((error: unknown) => {
      if (request === epoch.current) setInsertError(writeErrorMessage(error, { t: props.t }))
    }).finally(() => { working.current = false; setBusy(false) })
  }

  const onClick = (): void => {
    if (open) { close(); return }
    if (working.current) return
    epoch.current++
    setQuery('')
    setOpen(true)
    load()
  }

  const pick = async (slug: string): Promise<void> => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setInsertError(null)
    const request = epoch.current
    let newlyEnabled = false
    try {
      const insert = props.prepareInsertion?.() ?? props.insertReference
      // 使用当前快照的修订号写入；冲突后刷新并交还用户重试，不静默覆盖。
      let current: EnabledState = props.cache.catalog.getSnapshot()
      const expert = current.experts.find(item => item.slug === slug)
      if (expert === undefined || expert.conflict) throw new Error(props.t('custom.unavailable'))
      if (!current.enabled.has(slug)) {
        current = await writeEnabled(props.remote, props.cache, new Set([...current.enabled, slug]), current.revision)
        newlyEnabled = current.enabled.has(slug)
      }
      if (request !== epoch.current) return
      if (!current.enabled.has(slug) || !insertSelectedExpert(slug, props.getActive(), insert, current.experts)) {
        setInsertError(props.t(newlyEnabled ? 'discovery.enabledInsertFailed' : 'error.insertFailed'))
        return
      }
      // 宿主插入操作负责把光标交还编辑器；不要再抢回工具栏按钮焦点。
      close()
    } catch (error) {
      let refreshed = false
      try { await props.cache.catalog.refresh(); refreshed = true } catch { /* 保留原错误并明确刷新是否成功。 */ }
      if (request === epoch.current) setInsertError(writeErrorMessage(error, { refreshed, t: props.t }))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const matches = sortExpertsByEnabled(filterExperts(catalog.experts.filter(expert => !expert.teamMember), { query })
    .filter(expert => normalizeExpertQuery(query) !== '' || catalog.enabled.has(expert.slug)), catalog.enabled)
  const searching = normalizeExpertQuery(query) !== ''
  if (searching) matches.sort((a, b) => {
    const nameMatch = (expert: ExpertView): number => matchExpertQuery({ ...expert, slug: '', division: '', divisionZh: '', divisionEn: '', description: '', descriptionEn: '' }, query) ? 1 : 0
    return nameMatch(b) - nameMatch(a)
  })
  const results = searching ? matches.slice(0, 8) : groupByDivision(matches, props.getActive()).flatMap(group => group.experts)
  const menu = open
    ? React.createElement('div', {
      className: 'aag-menu aag-discovery', id: menuId, role: 'dialog', 'aria-modal': 'true', 'aria-label': props.t('settings.nav'),
      'data-placement': menuPosition?.placement,
      style: { maxHeight: `${Math.min(360, menuPosition?.maxHeight ?? 360)}px`, left: `${menuLeft}px` },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
      },
    },
      insertError === null ? null : React.createElement('div', { className: 'aag-error', role: 'alert' }, insertError,
        React.createElement('button', { type: 'button', disabled: busy, onClick: () => load() }, props.t('btn.refresh'))),
      'getTeams' in props.remote ? React.createElement(SegmentedControl, {
        id: 'aag-composer-mode', label: teamText(props.getActive(), '专家'), value: mode,
        options: [
          { value: 'experts' as const, label: teamText(props.getActive(), '专家') },
          { value: 'teams' as const, label: teamText(props.getActive(), '专家团') },
        ],
        onChange: (value) => setMode(value === 'teams' ? 'teams' : 'experts'),
      }) : null,
      mode === 'teams' && 'getTeams' in props.remote ? React.createElement(TeamLocaleContext.Provider, { value: props.getActive() }, React.createElement(TeamMenu, { remote: props.remote as TeamRemote, cache: props.cache,
        prepareSelect: props.prepareTeamSelection, onSelected: () => close() })) :
      React.createElement(ExpertDiscovery, { experts: results, enabled: catalog.enabled, locale: props.getActive(), t: props.t, avatarSrc: menuAvatar,
        query, onQuery: setQuery, busy, hasMore: searching && matches.length > results.length, onPick: slug => { void pick(slug) } }))
    : null

  return React.createElement('div', { className: 'aag-btn-wrap', ref: rootRef, onBlur: (event: React.FocusEvent) => {
    const next = event.relatedTarget
    if (next instanceof Element && (event.currentTarget.contains(next) || next.closest('[role="dialog"], .dsh-primitives-menu, [role="menu"]'))) return
    if (next instanceof Node && !event.currentTarget.contains(next)) close()
  } },
    React.createElement('span', { ref: triggerRef }, React.createElement('button', { type: 'button', className: 'aag-btn', title: props.t('button.title'), 'aria-expanded': open, 'aria-haspopup': 'dialog', 'aria-controls': open ? menuId : undefined, onMouseDown: keepComposerFocus, onClick }, expertIcon(), props.t('settings.nav'))),
    menu)
}

interface OpenPrompt {
  readonly name: string
  readonly prompt: string
  readonly returnFocus: HTMLButtonElement
}

function scrollParent(node: HTMLElement): HTMLElement | Window {
  let current = node.parentElement
  while (current !== null && current !== document.body && current !== document.documentElement) {
    const overflow = getComputedStyle(current).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return current
    current = current.parentElement
  }
  return window
}

function focusedCardIndex(node: HTMLElement): number | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !node.contains(active)) return null
  const card = active.closest('[data-expert-index]')
  if (!(card instanceof HTMLElement) || !node.contains(card)) return null
  const index = Number(card.dataset.expertIndex)
  return Number.isInteger(index) ? index : null
}

/** 只挂载视口内的专家卡片。持有焦点的卡片留在树上，避免滚动后焦点掉到页面。 */
function ExpertCardWindow(props: {
  items: readonly ExpertView[]
  resetKey: string
  render: (item: ExpertView) => React.ReactNode
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)
  const countRef = React.useRef(props.items.length)
  countRef.current = props.items.length
  const [range, setRange] = React.useState({ start: 0, end: 8, columns: 2, row: EXPERT_CARD_ROW, pin: null as number | null, key: props.resetKey })
  React.useLayoutEffect(() => {
    setRange((current) => current.key === props.resetKey ? current : { start: 0, end: 8, columns: current.columns, row: current.row, pin: null, key: props.resetKey })
  }, [props.resetKey])
  React.useLayoutEffect(() => {
    const node = ref.current
    if (node === null) return
    const scroller = scrollParent(node)
    let frame = 0
    const measure = (): void => {
      const row = EXPERT_CARD_ROW
      const section = node.closest('.aag-section')
      const width = section instanceof HTMLElement ? section.clientWidth : node.clientWidth
      const columns = width > 0 && width <= 519 ? 1 : 2
      const viewTop = scroller instanceof HTMLElement ? scroller.getBoundingClientRect().top : 0
      const viewHeight = scroller instanceof HTMLElement ? scroller.clientHeight : window.innerHeight
      const startPx = Math.max(0, viewTop - node.getBoundingClientRect().top)
      const rows = Math.ceil(countRef.current / columns)
      const start = Math.max(0, Math.floor(startPx / row) - 1)
      const end = Math.min(rows, Math.max(start + 1, Math.ceil((startPx + viewHeight) / row) + 2))
      const pin = focusedCardIndex(node)
      setRange(current => current.key === props.resetKey && current.start === start && current.end === end && current.columns === columns && current.row === row && current.pin === pin
        ? current
        : { start, end, columns, row, pin, key: props.resetKey })
    }
    measure()
    const onScroll = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const target: HTMLElement | Window = scroller instanceof HTMLElement ? scroller : window
    target.addEventListener('scroll', onScroll, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onScroll)
    observer?.observe(node)
    if (scroller instanceof HTMLElement) observer?.observe(scroller)
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(frame)
      target.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      window.removeEventListener('resize', onScroll)
    }
  }, [props.resetKey, props.items.length])
  const columns = Math.max(1, range.columns)
  const count = props.items.length
  const rows = Math.ceil(count / columns)
  const start = rows === 0 ? 0 : Math.min(range.start, rows - 1)
  const end = Math.min(rows, Math.max(start, range.end))
  const shown = new Set<number>()
  for (let index = start * columns; index < Math.min(end * columns, count); index += 1) shown.add(index)
  if (range.pin !== null && range.pin >= 0 && range.pin < count) shown.add(range.pin)
  const height = rows === 0 ? 0 : rows * range.row - EXPERT_CARD_GAP
  return React.createElement('div', { ref, className: 'aag-expert-window', role: 'list', 'aria-rowcount': rows, style: { height } },
    React.createElement('div', { className: 'aag-expert-grid', style: { top: 0, gridAutoRows: `${Math.max(range.row - EXPERT_CARD_GAP, 1)}px` } },
      [...shown].sort((left, right) => left - right).map((index) => React.createElement('div', {
        key: index,
        role: 'listitem',
        'data-expert-index': index,
        'aria-setsize': count,
        'aria-posinset': index + 1,
        style: { gridColumn: (index % columns) + 1, gridRow: Math.floor(index / columns) + 1 },
      }, props.render(props.items[index]!)))))
}

function ExpertCardsSettings(props: PropsLocale<'agency'> & {
  sharedHeader?: boolean
  active?: boolean
  startCreation?: (kind: 'expert' | 'team') => void
  source: 'custom' | 'company'
  onSourceChange: (source: 'custom' | 'company') => void
  onSummary?: (value: { source: 'custom' | 'company'; total: number; enabled: number } | null) => void
  remote: AgencyAgentsRemoteApi
  cache: ExpertClientState
  getActive: () => 'zh' | 'en'
}): React.ReactElement {
  const cached = props.cache.catalog.getSnapshot()
  const reloadEpoch = React.useRef(0)
  React.useEffect(() => () => { reloadEpoch.current++ }, [props.remote, props.cache])
  const [state, setState] = React.useState<EnabledState | null>(cached.revision < 0 ? null : cached)
  React.useEffect(() => {
    if (state === null) { props.onSummary?.(null); return }
    const mine = state.experts.filter(expert => !expert.teamMember && (props.source === 'company' ? expert.company : expert.custom)) ?? []
    props.onSummary?.({ source: props.source, total: mine.length, enabled: mine.filter(expert => state?.enabled.has(expert.slug)).length })
  }, [state?.experts, state?.enabled, props.source, props.onSummary])
  const [initialOrder, setInitialOrder] = React.useState<ReadonlyArray<string> | null>(cached.revision < 0 ? null : sortExpertsByEnabled(cached.experts, cached.enabled).map(expert => expert.slug))
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [division, setDivision] = React.useState('')
  const [status, setStatus] = React.useState('')
  const [openPrompt, setOpenPrompt] = React.useState<OpenPrompt | null>(null)
  const detailRequest = React.useRef<AbortController | null>(null)
  const cancelDetail = React.useCallback(() => { detailRequest.current?.abort(); detailRequest.current = null }, [])
  React.useEffect(() => cancelDetail, [props.remote, props.cache, props.source, props.active, cancelDetail])
  const lifetime = React.useRef<AbortController | undefined>(undefined)
  React.useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => {
      controller.abort()
      if (lifetime.current === controller) lifetime.current = undefined
    }
  }, [props.remote, props.cache])
  const saving = React.useRef(false)
  const [isSaving, setIsSaving] = React.useState(false)
  const { source, onSourceChange } = props
  const [editor, setEditor] = React.useState<{ expert?: CustomExpertInput; enabled: boolean; revision: number } | null>(null)
  const [deleting, setDeleting] = React.useState<ExpertView | null>(null)
  const [bulk, setBulk] = React.useState<{ targets: string[]; enabled: boolean } | null>(null)
  const [bulkError, setBulkError] = React.useState<string | null>(null)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const accept = (catalog: CatalogSnapshot): void => {
    const current = props.cache.catalog.accept(catalog)
    setState(current)
    setError(null)
  }
  const fresh = (): EnabledState | null => {
    if (state === null) return null
    const latest = props.cache.catalog.getSnapshot()
    return latest.revision < 0 ? null : latest.revision >= state.revision ? latest : state
  }
  const openEditor = (expert?: ExpertView): void => {
    const current = fresh()
    if (current === null || isSaving || detailRequest.current) return
    if (expert === undefined) { setEditor({ enabled: false, revision: current.revision }); return }
    const revision = current.revision
    const enabled = current.enabled.has(expert.slug)
    if (expert.custom) {
      readDetail(signal => props.remote.getCustomExpert(expert.slug, signal), (expert) => { setEditor({ expert, enabled, revision }) })
    } else {
      withPrompt(expert, prompt => {
        const original = displayName(expert, props.getActive())
        let name = `${original.slice(0, 33)} ${props.getActive() === 'zh' ? '副本' : 'copy'}`
        let index = 2
        while (current.experts.some(item => [item.name, item.nameEn].includes(name))) name = `${original.slice(0, 28)} ${props.getActive() === 'zh' ? '副本' : 'copy'} ${index++}`
        setEditor({ expert: { name, description: displayDescription(expert, props.getActive()).slice(0, 160), division: expert.division,
          emoji: expert.emoji || DEFAULT_EXPERT_EMOJI, avatar: expertAvatarIndexForDivision(expert.slug, expert.division), prompt }, enabled: false, revision })
      })
    }
  }
  const removeExpert = (slug: string): void => {
    const current = fresh()
    if (current === null || saving.current) return
    saving.current = true
    setIsSaving(true)
    setDeleteError(null)
    const signal = lifetime.current?.signal
    signal?.throwIfAborted()
    void props.remote.deleteCustomExpert(slug, current.revision, signal)
      .then(result => {
        signal?.throwIfAborted()
        if (!result.ok) throw result.error
        accept(result.value)
        setDeleting(null)
        setNotice(props.t('custom.deleted'))
      }).catch((cause: unknown) => {
        if (signal?.aborted) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setDeleteError(message)
      }).finally(() => { saving.current = false; setIsSaving(false) })
  }

  React.useEffect(() => {
    let alive = true
    const applySnapshot = (current: EnabledState): void => {
      setState(current)
      setInitialOrder((order) => order ?? sortExpertsByEnabled(current.experts, current.enabled).map((expert) => expert.slug))
    }
    const loadCatalog = (): Promise<void> => props.cache.catalog.refresh().then((current) => { if (alive) applySnapshot(current) })
    const pending = loadCatalog().then(async () => {
      const current = await props.cache.catalog.refresh(true)
      if (!alive) return
      applySnapshot(current)
      setError(null)
    })
    void pending.catch((err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : String(err))
    })
    return () => { alive = false }
  }, [props.remote, props.cache])

  React.useEffect(() => props.cache.catalog.subscribe(() => {
    const current = props.cache.catalog.getSnapshot()
    if (current.revision < 0) { cancelDetail(); setState(null); setInitialOrder(null); setDeleting(null); setBulk(null); setOpenPrompt(null); return }
    setState(current)
    setInitialOrder((order) => order ?? sortExpertsByEnabled(current.experts, current.enabled).map((expert) => expert.slug))
  }), [props.remote, props.cache, cancelDetail])

  const toggle = (slug: string): void => {
    const current = fresh()
    if (current === null || saving.current) return
    const previous = current
    const next = new Set(current.enabled)
    if (next.has(slug)) next.delete(slug)
    else next.add(slug)
    saving.current = true
    setIsSaving(true)
    setState({ ...current, enabled: next })
    const signal = lifetime.current?.signal
    signal?.throwIfAborted()
    void writeEnabled(props.remote, props.cache, next, current.revision, signal)
      .then((current) => {
        signal?.throwIfAborted()
        setState(current)
        setError(null)
      })
      .catch(async (err: unknown) => {
        if (signal?.aborted) return
        try {
          const refreshed = await props.cache.catalog.refresh()
          setState(refreshed)
          setError(writeErrorMessage(err, { refreshed: true, t: props.t }))
        } catch {
          setState(previous)
          setError(writeErrorMessage(err, { refreshed: false, t: props.t }))
        }
      })
      .finally(() => {
        saving.current = false
        setIsSaving(false)
      })
  }

  const readDetail = <T>(read: (signal: AbortSignal) => Promise<RemoteResult<T>>, accept: (value: T) => void): void => {
    if (detailRequest.current || props.active === false) return
    const controller = new AbortController()
    detailRequest.current = controller
    setError(null)
    void read(controller.signal).then((result) => {
      controller.signal.throwIfAborted()
      if (!result.ok) throw result.error
      accept(result.value)
    }).catch((err: unknown) => {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (detailRequest.current === controller) detailRequest.current = null })
  }

  const withPrompt = (expert: ExpertView, action: (prompt: string) => void): void => {
    readDetail(signal => props.remote.getPrompt(expert.slug, expert.division, signal), value => action(value.prompt))
  }

  const viewPrompt = (expert: ExpertView, returnFocus: HTMLButtonElement): void => {
    withPrompt(expert, (prompt) => { setOpenPrompt({ name: displayName(expert, props.getActive()), prompt, returnFocus }) })
  }

  const nodes: React.ReactNode[] = []
  if (error !== null) nodes.push(React.createElement('div', { key: 'error', className: 'aag-error', role: 'alert' }, error,
    React.createElement(Button, { onClick: () => {
      const request = ++reloadEpoch.current
      void props.cache.catalog.refresh(true).then(current => {
        if (request !== reloadEpoch.current) return
        setState(current); setError(null)
      }).catch((cause: unknown) => {
        if (request === reloadEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
    } }, props.t('company.retry'))))
  {
    const experts = state?.experts ?? []
    const enabled = state?.enabled ?? new Set<string>()
    const ordered = initialOrder === null
      ? sortExpertsByEnabled(experts, enabled)
      : sortExpertsByOrder(experts, initialOrder)
    const filtered = filterExperts(ordered.filter(expert => !expert.teamMember && (source === 'company' ? expert.company === true : expert.custom)), { query, division })
      .filter(expert => status === '' || enabled.has(expert.slug) === (status === 'enabled'))
    const enabledCount = enabled.size
    const total = experts.length
    if (experts.some(expert => expert.conflict)) nodes.push(React.createElement('div', { key: 'conflicts', className: 'aag-error', role: 'alert' }, props.t('custom.nameConflictHint')))
    const hasFilter = normalizeExpertQuery(query) !== '' || division !== '' || status !== ''
    const resetFilters = (): void => { setQuery(''); setDivision(''); setStatus('') }
    if (!props.sharedHeader) nodes.push(React.createElement('div', { key: 'toolbar', className: 'aag-toolbar' },
      React.createElement('div', { className: 'aag-title-row' },
        React.createElement('h2', { className: 'aag-title' }, props.t('settings.title')),
        null),
      React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        React.createElement('span', { className: 'aag-header-stat' },
          React.createElement('strong', null, state === null ? '—' : total),
          props.t(total === 1 ? 'summary.total.one' : 'summary.total.other', { count: total })),
        React.createElement('span', { className: 'aag-header-stat' },
          props.t('summary.enabledPrefix'),
          React.createElement('strong', null, state === null ? '—' : enabledCount)))))
    const bulkActions = [true, false].map(next => React.createElement(Button, { key: next ? 'enable' : 'disable', disabled: isSaving || state === null || !filtered.some(expert => !expert.conflict && enabled.has(expert.slug) !== next), onClick: () => { setBulkError(null); setBulk({ targets: filtered.filter(expert => !expert.conflict && enabled.has(expert.slug) !== next).map(expert => expert.slug), enabled: next }) } }, props.t(next ? 'bulk.enable' : 'bulk.disable')))
    const filterActions = React.createElement('div', { className: 'aag-filter-actions' }, bulkActions, source !== 'custom' ? null : React.createElement(React.Fragment, null,
      props.startCreation ? React.createElement(Button, { disabled: isSaving, onClick: () => props.startCreation?.('expert') }, props.t('creation.expert')) : null,
      React.createElement(Button, {
        variant: 'primary',
        size: 'sm',
        disabled: isSaving || state === null,
        icon: React.createElement(IconPlus, { size: 16, 'aria-hidden': true }),
        onClick: () => openEditor(),
      }, props.t('custom.new'))))
    if (notice !== null) nodes.push(React.createElement('div', { key: 'notice', className: 'aag-custom-notice', role: 'status' }, notice))
    nodes.push(React.createElement('div', { key: 'filters', className: 'aag-filters aag-card-filters' },
      React.createElement('div', { className: 'aag-field aag-field-category' },
        React.createElement(CategorySelect, {
          id: 'aag-filter-category',
          value: division,
          label: props.t('settings.filter.category'),
          onChange: setDivision,
          options: [...new Set([...expertDivisionFilterValues(), ...experts.map(expert => expert.division)])].map((value) => ({
            value,
            label: value === '' ? props.t('settings.filter.allCategories') : inputTriggerSourceName(value, props.getActive()),
          })),
        })),
      React.createElement('div', { className: 'aag-field aag-field-status' },
        React.createElement(CategorySelect, {
          id: 'aag-filter-status', value: status, label: props.t('settings.filter.status'), onChange: setStatus,
          options: [
            { value: '', label: props.t('settings.filter.allStatuses') },
            { value: 'enabled', label: props.t('settings.enabled') },
            { value: 'disabled', label: props.t('settings.disabled') },
          ],
        })),
      React.createElement('div', { className: 'aag-field aag-field-search' },
        React.createElement('div', { className: 'aag-search-wrap' },
          React.createElement(Input, {
            id: 'aag-filter-search', className: 'aag-search',
            value: query, icon: React.createElement(Search, { size: 16, strokeWidth: 1.7, 'aria-hidden': true }),
            autoComplete: 'off', spellCheck: false, placeholder: props.t('settings.search.placeholder'),
            'aria-label': props.t('settings.search'),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.currentTarget.value),
          }))),
      filterActions))
    if (state === null && error === null) {
      nodes.push(React.createElement('div', { key: 'loading', role: 'status', 'aria-label': props.t('settings.loading'), className: 'aag-read-loading' }, React.createElement(StateDot, { state: 'ongoing', size: 14 })))
    } else if (state !== null && filtered.length === 0) {
      nodes.push(React.createElement('div', { key: 'empty', className: 'aag-empty' },
        React.createElement('div', null, !hasFilter ? props.t(source === 'custom' ? 'custom.emptyTitle' : 'settings.market.empty') : props.t('settings.empty', { all: props.t('settings.filter.allCategories') })),
        source === 'custom' && !hasFilter ? React.createElement('p', { className: 'aag-note' }, props.t('custom.emptyHint')) : null,
        hasFilter ? React.createElement(Button, { onClick: resetFilters }, props.t('settings.empty.reset')) : null))
    } else if (state !== null) {
      nodes.push(React.createElement(ExpertCardWindow, {
        key: 'cards', items: filtered, resetKey: `${source}\0${division}\0${status}\0${query}`, render: (expert: ExpertView) => {
        const isEnabled = enabled.has(expert.slug)
        const avatar = EXPERT_AVATAR_URLS[expert.custom ? expert.avatar ?? 0 : expertAvatarIndexForDivision(expert.slug, expert.division)] ?? EXPERT_AVATAR_URLS[0]
        return React.createElement(LibraryCard, {
          key: expert.slug,
          name: displayName(expert, props.getActive()),
          avatar: React.createElement('img', { className: 'aag-expert-avatar', src: avatar, width: 44, height: 44, loading: 'lazy', decoding: 'async', alt: '' }),
          metadata: React.createElement(React.Fragment, null,
            React.createElement('span', { className: 'aag-division-pill' }, inputTriggerSourceName(expert.division, props.getActive())),
            expert.conflict ? React.createElement('span', { className: 'aag-custom-badge', title: props.t('custom.nameConflictHint') }, props.t('custom.nameConflict')) : null,
            expert.company ? React.createElement('span', { className: 'aag-custom-badge' }, props.t('settings.source.company')) : expert.custom ? React.createElement('span', { className: 'aag-custom-badge' }, props.t('custom.source')) : null
          ),
          description: displayDescription(expert, props.getActive()),
          enabled: isEnabled, disabled: isSaving || expert.conflict === true,
          enabledLabel: props.t('settings.enabled'), disabledLabel: props.t('settings.disabled'),
          toggle: () => toggle(expert.slug),
          moreItems: [
            { id: 'edit', label: props.t(expert.custom ? 'custom.edit' : 'custom.copy'), icon: React.createElement(expert.custom ? EditIcon : Copy, { size: 16, strokeWidth: 1.7, 'aria-hidden': true }), disabled: isSaving || state === null, onSelect: () => openEditor(expert) },
            ...(expert.custom && 'dshDesktop' in globalThis ? [{ id: 'submit-company', label: props.t('custom.submitCompany'), disabled: isSaving || state === null, onSelect: () => {
              document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { cancelable: true, detail: {
                kind: 'expert', name: expert.name, prepare: async (signal: AbortSignal) => {
                  signal.throwIfAborted()
                  const result = await props.remote.getCustomExpert(expert.slug, signal)
                  signal.throwIfAborted()
                  if (!result.ok) throw result.error
                  const value = result.value
                  const markdown = `---\nname: ${JSON.stringify(value.name)}\ndescription: ${JSON.stringify(value.description)}\n---\n${value.prompt}\n`
                  const encoded = new TextEncoder().encode(markdown)
                  return { resourceKey: 'experts/' + expert.slug, files: { ['experts/' + value.division + '/' + expert.slug + '.md']: bytesToBase64(encoded) } }
                },
              } }))
            } }] : []),
            ...(expert.custom ? [{ id: 'delete', label: props.t('custom.delete'), icon: React.createElement(TrashIcon, { size: 16, strokeWidth: 1.7, 'aria-hidden': true }), danger: true, disabled: isSaving || state === null, onSelect: () => { setDeleting(expert); setDeleteError(null) } }] : []),
          ],
          actions: React.createElement('button', { type: 'button', className: 'aag-card-action', title: props.t('settings.viewPromptTitle'), 'aria-label': props.t('settings.viewPromptTitle'), 'aria-haspopup': 'dialog', onClick: (event: React.MouseEvent<HTMLButtonElement>) => viewPrompt(expert, event.currentTarget) },
            React.createElement(Eye, { size: 18, strokeWidth: 1.7, 'aria-hidden': true }), React.createElement('span', { className: 'aag-card-action-text' }, props.t('settings.viewPrompt'))),
        })
      } }))
    }
  }
  return React.createElement('section', { className: 'aag-section', id: 'aag-expert-source-panel' }, nodes,
    bulk === null ? null : React.createElement(LibraryConfirm, { title: props.t('bulk.title'), description: props.t('bulk.description', { action: props.t(bulk.enabled ? 'bulk.enableVerb' : 'bulk.disableVerb'), count: bulk.targets.length }), confirmLabel: props.t('bulk.confirm'), cancelLabel: props.t('bulk.cancel'), busy: isSaving, error: bulkError, close: () => setBulk(null), confirm: () => {
      if (saving.current) return
      saving.current = true; setIsSaving(true); setBulkError(null)
      const signal = lifetime.current?.signal
      signal?.throwIfAborted()
      void commitBulk(props.remote, bulk.targets, bulk.enabled, signal).then(value => {
        signal?.throwIfAborted()
        const current = props.cache.catalog.acceptEnabled(value); setState(current); setBulk(null)
      })
        .catch((cause: unknown) => { if (!signal?.aborted) setBulkError(cause instanceof Error ? cause.message : String(cause)) })
        .finally(() => { saving.current = false; setIsSaving(false) })
    } }),
    editor === null ? null : React.createElement(CustomExpertEditor, {
      ...editor, remote: props.remote, t: props.t, locale: props.getActive(),
      signal: lifetime.current?.signal,
      divisions: [...new Set([...EXPERT_DIVISION_ORDER, ...(state?.experts ?? []).map(expert => expert.division)])],
      onClose: () => setEditor(null), onSaved: (catalog: CatalogSnapshot) => {
        accept(catalog); setEditor(null); onSourceChange('custom'); setQuery(''); setDivision(''); setStatus(''); setNotice(props.t('custom.saved'))
      },
    }),
    deleting === null ? null : React.createElement(CustomDeleteDialog, {
      name: deleting.name, busy: isSaving, error: deleteError, t: props.t, close: () => setDeleting(null), confirm: () => removeExpert(deleting.slug),
    }),
    openPrompt === null ? null : React.createElement(PromptDialog, {
      value: openPrompt, title: props.t('settings.promptTitle', { name: openPrompt.name }), closeLabel: props.t('settings.promptClose'), returnFocus: openPrompt.returnFocus, onClose: () => setOpenPrompt(null),
    }))
}

export function AgencySettingsPanel(props: Omit<React.ComponentProps<typeof ExpertCardsSettings>, 'source' | 'onSourceChange' | 'active'> & { prepareTeamSelection(): (team: ExpertTeam, example?: string) => boolean | Promise<boolean> }) {
  const [creationError, setCreationError] = React.useState<string | null>(null)
  const beginCreation = props.startCreation === undefined ? undefined : (kind: 'expert' | 'team'): void => {
    setCreationError(null)
    try { props.startCreation?.(kind) } catch (cause: unknown) { setCreationError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const tx = (key: string) => teamText(props.getActive(), key)
  const [source, setSource] = React.useState<'custom' | 'company'>('company')
  const [view, setView] = React.useState<'experts' | 'teams'>('experts')
  const [expertSummary, setExpertSummary] = React.useState<{ source: 'custom' | 'company'; total: number; enabled: number } | null>(null)
  const [teamSummary, setTeamSummary] = React.useState<{ source: 'custom' | 'company'; total: number; enabled: number } | null>(null)
  const tabLabel = (icon: React.ReactElement, name: string, total: number | undefined, enabled: number | undefined) => React.createElement(React.Fragment, null,
    icon,
    name,
    React.createElement('span', { className: 'aag-tab-count', 'aria-hidden': true }, React.createElement('strong', null, total ?? '—')),
    React.createElement('span', { className: 'aag-tab-count', 'aria-hidden': true }, props.t('summary.enabledPrefix'), React.createElement('strong', null, enabled ?? '—')),
  )
  const navigation = React.createElement(SegmentedTabs, {
    className: 'aag-library-tabs', label: tx('专家库类型'), value: view,
    onChange: (value) => { if (value === 'experts' || value === 'teams') setView(value) },
    items: [
      { value: 'experts' as const, id: 'aag-library-tab-experts', panelId: 'aag-library-panel-experts', label: tabLabel(expertIcon(), tx('专家'), expertSummary?.source === source ? expertSummary.total : undefined, expertSummary?.source === source ? expertSummary.enabled : undefined) },
      { value: 'teams' as const, id: 'aag-library-tab-teams', panelId: 'aag-library-panel-teams', label: tabLabel(teamTabIcon(), tx('专家团'), teamSummary?.source === source ? teamSummary.total : undefined, teamSummary?.source === source ? teamSummary.enabled : undefined) },
    ],
  })
  // 两个名册都保持挂载，切换时不丢失筛选，也不重新等待第一次加载。
  return React.createElement('section', { className: 'aag-section aag-library-shell' },
    React.createElement('header', { className: 'aag-toolbar' }, React.createElement('div', { className: 'aag-title-row' },
      React.createElement('h2', { className: 'aag-title' }, props.t('settings.title')), null)),
    React.createElement('p', { className: 'aag-note' }, props.t('settings.market.hint')),
    creationError ? React.createElement('p', { className: 'aag-error', role: 'alert' }, creationError) : null,
    React.createElement(SegmentedTabs, { className: 'aag-market-tabs', label: props.t('settings.scope'), value: source, onChange: (value) => { if (value === 'company' || value === 'custom') setSource(value) }, items: [
      { value: 'company', id: 'aag-tab-market', panelId: 'aag-catalog-panel', label: props.t('settings.source.company') },
      { value: 'custom', id: 'aag-tab-mine', panelId: 'aag-catalog-panel', label: props.t('custom.source') },
    ] }),
    React.createElement('div', { id: 'aag-catalog-panel', role: 'tabpanel', 'aria-labelledby': source === 'company' ? 'aag-tab-market' : 'aag-tab-mine' },
      React.createElement('div', { className: 'aag-library-navigation' }, navigation),
      React.createElement('div', { id: 'aag-library-panel-experts', role: 'tabpanel', 'aria-labelledby': 'aag-library-tab-experts', hidden: view !== 'experts' }, React.createElement(ExpertCardsSettings, { ...props, startCreation: beginCreation, source, active: view === 'experts', onSourceChange: (next) => { setSource(next); setView('experts') }, sharedHeader: true, onSummary: setExpertSummary })),
      React.createElement('div', { id: 'aag-library-panel-teams', role: 'tabpanel', 'aria-labelledby': 'aag-library-tab-teams', hidden: view !== 'teams' }, React.createElement(TeamLocaleContext.Provider, { value: props.getActive() }, React.createElement(TeamsPanel, {
        remote: props.remote as TeamRemote, cache: props.cache, startCreation: beginCreation ? () => beginCreation('team') : undefined, source, active: view === 'teams', onSaved: () => setSource('custom'), sharedHeader: true, onSummary: setTeamSummary, prepareSelect: props.prepareTeamSelection,
      })))))
}
export const inject = ['slots', 'inputTriggers', 'locale', 'remote', 'sessions', 'conversation', 'layout']

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // Read the mounted native Client Session service once and use its public contract.
  // Widen only the lookup boundary so the Host SessionStore declaration cannot leak
  // into this client entrypoint; no second session API is introduced.
  const getService: (name: string) => unknown = ctx.get.bind(ctx)
  const sessions = getService('sessions') as ISessions
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.textContent = CSS + CUSTOM_EDITOR_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'agency-agents: style')

  // 注册双语词条；t 为稳定引用（调用时读取当前 locale），locale 切换由
  // framework 以 (namespace, revision) 重新派生注入的 t 并触发重渲染。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agency-agents: dictionaries')
  const t = ctx.locale.bind(NS)
  const getActive = (): 'zh' | 'en' => ctx.locale.getSnapshot().active === 'en' ? 'en' : 'zh'

  // 挂载本插件的 Typert Remote：host 端由 gateway 的 SRC 自动发现（@Remote
  // markers）。namespace 是独立的 Cordis 服务，必须在挂载后通过 ctx.get()
  // 获取；直接读取 ctx.remote.agencyAgents 会要求预先注入该服务并导致死锁。
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const remote = ctx.get('remote.agencyAgents')
  if (remote === undefined) throw new Error(teamText(getActive(), 'agency-agents Remote 挂载后不可用'))

  const cache = createExpertClientState(remote)
  ctx.effect(() => () => { cache.catalog.dispose(); cache.teams.dispose() }, 'agency-agents: snapshots')

  const refreshCatalog = (): void => {
    void cache.catalog.refresh().catch((error: unknown) => console.warn('[agency-agents] 名册刷新失败：', error))
  }
  void cache.teams.refresh().catch((error: unknown) => console.warn('[agency-agents] 专家团预加载失败：', error))
  void cache.catalog.refresh().catch((error: unknown) => console.warn('[agency-agents] 初始名册读取失败，目录页可重试：', error))
  ctx.effect(() => {
    const names = installNativeTeamNames(async () => {
      if (cache.catalog.getSnapshot().revision < 0) return new Map<string, string>()
      const snapshot = cache.teams.getSnapshot() ?? await cache.teams.refresh()
      const experts = cache.catalog.getSnapshot().experts
      const active = getActive()
      const members = new Map(Object.entries(snapshot.nativeMembers ?? {}).flatMap(([identity, slug]) => {
        const expert = experts.find(item => item.slug === slug && !item.conflict)
        return expert ? [[identity, displayName(expert, active)] as const] : []
      }))
      const teams = snapshot.teams.map(team => ({
        names: [team.name],
        label: team.name,
      }))
      return { members, teams }
    }, error => console.warn('[agency-agents] 原生成员显示名读取失败：', error))
    const localeDispose = ctx.locale.subscribe(() => { void names.refresh() })
    const catalogDispose = cache.catalog.subscribe(() => { void names.refresh() })
    const teamsDispose = cache.teams.subscribe(() => { void names.refresh() })
    return () => { localeDispose(); catalogDispose(); teamsDispose(); names.dispose() }
  }, 'agency-agents: native member names')
  const resolveTarget = (sessionId?: SessionId): ReferenceInsertionTarget | undefined => resolveReferenceInsertionTarget(
    sessions, sessionId,
    (actx) => actx.conversation.input.for(actx),
  )
  const insertTask = (current: ReferenceInsertionTarget | undefined, reference: ReferenceInsert, sessionId?: SessionId, span?: TokenSpan): boolean => {
    if (current === undefined) return false
    const id = resolveTargetSessionId(sessions, sessionId)
    const actx = id === undefined ? undefined : sessions.scope(id)
    return insertExpertReference({
      state: current.state,
      insertReference: (ref, tokenSpan) => current.insertReference(ref, tokenSpan),
      insertText: (text, tokenSpan) => actx?.bail(actx, 'slash/input-insert-text', { text, span: tokenSpan }) === true,
      notify: (level, text) => current.notify?.(level, text),
    }, reference, undefined, span, t('discovery.exampleFailed'))
  }
  ctx.on('connection/reset', () => {
    cache.catalog.reset()
    cache.teams.reset()
    refreshCatalog()
    void cache.teams.refresh().catch((error: unknown) => console.warn('[agency-agents] 专家团重新加载失败：', error))
  })
  const insertTeamTask = async (current: ReferenceInsertionTarget | undefined, team: ExpertTeam, example?: string, sessionId?: SessionId, span?: TokenSpan): Promise<boolean> => {
    if (!current) return false
    const id = resolveTargetSessionId(sessions, sessionId)
    const actx = id === undefined ? undefined : sessions.scope(id)
    return insertTeamReference({ state: current.state, insertReference: (ref, tokenSpan) => current.insertReference(ref, tokenSpan),
      insertText: (text, tokenSpan) => actx?.bail(actx, 'slash/input-insert-text', { text, span: tokenSpan }) === true,
      notify: (level, text) => current.notify?.(level, text) }, team, example, span, getActive())
  }
  const bindExpertInsertion = (sessionId?: SessionId): {
    readonly insertReference: (reference: ReferenceInsert) => boolean
    readonly prepareInsertion: () => (reference: ReferenceInsert) => boolean
    readonly prepareTeamSelection: () => (team: ExpertTeam, example?: string) => boolean | Promise<boolean>
  } => {
    const target = (): ReferenceInsertionTarget | undefined => resolveTarget(sessionId)
    return {
      prepareTeamSelection: () => {
        const current = target()
        return (team, example) => current !== undefined && target() === current && insertTeamTask(current, team, example, sessionId)
      },
      insertReference: (reference) => insertTask(target(), reference, sessionId),
      prepareInsertion: () => {
        const current = target()
        return reference => current !== undefined && target() === current && insertTask(current, reference, sessionId)
      },
    }
  }

  const startCreation = (kind: 'expert' | 'team'): void => {
    const id = resolveTargetSessionId(sessions)
    const actx = id === undefined ? undefined : sessions.scope(id)
    const input = actx === undefined ? undefined : ctx.conversation.input.for(actx)
    if (!actx || !input) throw new Error(t('creation.noSession'))
    const snapshot = input.state.getSnapshot()
    const length = expertDetectText(snapshot).length
    const text = t(kind === 'expert' ? 'creation.expertPrompt' : 'creation.teamPrompt')
    if (actx.bail(actx, 'slash/input-insert-text', { text: (length ? '\n' : '') + text, span: { start: length, end: length, draftRev: snapshot.draftRev } }) !== true) {
      input.notify('error', t('creation.failed')); return
    }
    ctx.layout.selectPanel(null)
    input.focus()
  }
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of ['open_custom_expert_editor', 'open_expert_team_editor']) yield ctx.slots.register({
      name: 'tool.call.toolview', key, locale: NS,
      inject: (sessionId) => ({ remote: remote as TeamRemote, cache, getActive,
        loadCreation: async (proposalId: string, signal: AbortSignal) => {
          if (!sessionId) throw new Error(t('creation.noSession'))
          const api = ctx.get('remote.agencyAgents')
          return unwrap(api.claimCreation(sessionId, proposalId, signal))
        },
      }),
    }, CreationCard)
  })

  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: 'deepseek-harness-experts', locale: NS },
    (props) => React.createElement('div', { className: 'product-capability-page' },
      React.createElement('div', { className: 'product-capability-content' },
        React.createElement(AgencySettingsPanel, { ...props, remote, cache, getActive, startCreation, prepareTeamSelection: bindExpertInsertion().prepareTeamSelection }))),
  ))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    {
      name: 'conversation.input.left', id: 'agency-agents', order: 0, locale: NS,
      ...({ inject: bindExpertInsertion } as Record<string, unknown>),
    },
    (props) => React.createElement(AgentsButton, { ...props, remote, cache, getActive }),
  ))

  const expertDivisions = (): string[] => [...new Set([...DIVISION_ORDER, ...cache.catalog.getSnapshot().experts.map(expert => expert.division)])]
  const registerInputTriggerSources = (active: 'zh' | 'en', divisions: readonly string[]): (() => void) => {
    const disposers: Array<() => void> = []
    try {
      disposers.push(ctx.inputTriggers.registerSource({
        trigger: '@', name: TEAM_REFERENCE_SOURCE, order: 99,
        candidates: async (_session, request) => {
          const cached = cache.teams.getSnapshot()
          const snapshot = cached ?? await cache.teams.refresh()
          if (cached) void cache.teams.refresh().catch((error: unknown) => console.warn('[agency-agents] 专家团刷新失败：', error))
          return snapshot.teams.filter(team => snapshot.enabledTeams.includes(team.id) && `${team.name} ${team.description}`.toLowerCase().includes(String(request.query ?? '').toLowerCase())).map(team => ({ name: `${team.name} · ${teamText(active, '专家团')}`, hint: team.id, section: teamText(active, '专家团') }))
        },
        onPick: pick => {
          const snapshot = cache.teams.getSnapshot()
          const team = snapshot?.teams.find(team => team.id === pick.candidate.hint)
          if (!team || !snapshot?.enabledTeams.includes(team.id)) return undefined
          const target = resolveTarget(pick.session.sessionId)
          if (!target) return { insert: teamReference(team, active) }
          void insertTeamTask(target, team, undefined, pick.session.sessionId, pick.span).catch(error => target.notify?.('error', error instanceof Error ? error.message : teamText(active, '操作失败。')))
          return 'handled'
        },
        codec: {
          clipboardText: id => teamText(active, '@专家团：{0}\u00a0', [cache.teams.getSnapshot()?.teams.find(team => team.id === id)?.name ?? teamText(active, '已移除团队（请重新选择）')]),
          serialize: async id => {
            const [snapshot, catalog] = await Promise.all([cache.teams.refresh(), cache.catalog.refresh()])
            const team = snapshot.teams.find(team => team.id === id)
            if (!team || !snapshot.enabledTeams.includes(id) || team.members.some(member => !catalog.enabled.has(member.expertSlug) || !catalog.experts.some(e => e.slug === member.expertSlug && !e.conflict))) throw new Error(teamText(active, '团队已停用或成员失效，请修复后再发送。'))
            return teamText(active, '@专家团：{0}\u00a0', [team.name])
          },
        },
      }))
      for (const [i, div] of divisions.entries()) {
        const source = {
          trigger: '@',
          name: inputTriggerSourceId(div),
          order: 100 + i,
          showGroupTitle: false,
          candidates: async (_session, req) => {
            const current = await cache.catalog.refresh().catch(() => undefined)
            if (current === undefined) return []
            const enabled = current.enabled
            const q = String(req.query ?? '').toLowerCase()
            return current.experts
              .filter((e) => e.division === div && enabled.has(e.slug) && (q === '' || matchExpertQuery(e, q)))
              .map((e) => ({
                name: inputTriggerCandidateName(e, getActive()),
                hint: e.slug,
                section: inputTriggerSourceName(div, getActive()),
              }))
          },
          onPick: (pick) => {
            const slug = pick.candidate.hint ?? ''
            const expert = cache.catalog.getSnapshot().experts.find((item) => item.slug === slug && cache.catalog.getSnapshot().enabled.has(slug))
            if (expert === undefined) return undefined
            const reference = buildExpertReference(expert, getActive())
            const target = resolveTarget(pick.session.sessionId)
            if (target === undefined) return { insert: reference }
            return insertTask(target, reference, pick.session.sessionId, pick.span) ? 'handled' : undefined
          },
          ...(i === 0 ? { warm: refreshCatalog } : {}),
          lexicon: () => {
            const current = cache.catalog.getSnapshot()
            return current.revision < 0 ? undefined
              : buildExpertMentionLexicon(current.experts.filter(expert => !expert.teamMember && expert.division === div), current.enabled, getActive())
          },
          subscribeLexicon: (_session, listener) => cache.catalog.subscribe(listener),
          codec: {
            clipboardText: (slug) => expertMentionFromReference(slug, getActive(), cache.catalog.getSnapshot().experts),
            serialize: async (slug) => {
              const current = await cache.catalog.refresh()
              if (!current.experts.some(expert => expert.slug === slug) || !current.enabled.has(slug)) throw new Error(t('custom.unavailable'))
              return expertMentionFromReference(slug, getActive(), current.experts)
            },
          },
        } satisfies InputTriggerSource
        disposers.push(ctx.inputTriggers.registerSource(source))
      }
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }

  ctx.effect(() => {
    let active = getActive()
    let divisions = expertDivisions()
    let disposeSources = registerInputTriggerSources(active, divisions)
    const reconcile = (): void => {
      const next = getActive()
      const nextDivisions = expertDivisions()
      if (next === active && nextDivisions.length === divisions.length && nextDivisions.every((value, index) => value === divisions[index])) return

      disposeSources()
      try {
        disposeSources = registerInputTriggerSources(next, nextDivisions)
        active = next
        divisions = nextDivisions
      } catch (error) {
        disposeSources = registerInputTriggerSources(active, divisions)
        console.error('[agency-agents] @ 菜单来源更新失败，已恢复原来源：', error)
      }
    }
    const localeDispose = ctx.locale.subscribe(reconcile)
    const catalogDispose = cache.catalog.subscribe(reconcile)
    return () => {
      localeDispose()
      catalogDispose()
      disposeSources()
    }
  }, 'agency-agents: @ menu sources')

  return disposeRemote
}
