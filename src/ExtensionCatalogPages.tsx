import { Boxes, Check, Plus, Sparkles } from 'lucide-react'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { useMemo, useState } from 'react'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import { ExtensionCategoryBar, extensionMatches, type ExtensionFilter } from './ExtensionToolbar'
import type { ExtensionCategoryFilter } from './extensionCategories'
import { CapabilityHero } from './CapabilityHero'
import { CatalogLoading } from './CatalogLoading'
import { ExtensionEnableSwitch } from './InstalledExtensionControls'

interface CommonProps {
  loading: boolean
  error: string
  filter: ExtensionFilter
  category: ExtensionCategoryFilter
  onFilter: (value: ExtensionFilter) => void
  onCategory: (value: ExtensionCategoryFilter) => void
  onCreate?: () => void
  onChanged?: () => Promise<void> | void
  onUseSkill?: (id: string) => void
}

export function CapabilityCatalogPage(props: CommonProps & {
  expertKits: ExpertKitView[]
  visibleExpertKits: ExpertKitView[]
  skills: SkillView[]
  visibleSkills: SkillView[]
  installingKitId: string
  onOpenExpertKit: (id: string) => void
  onOpenSkill: (id: string) => void
  kind: 'skills' | 'packs'
}) {
  const { kind } = props
  return <>
    {kind === 'skills'
      ? <SkillCatalogPage {...props} all={props.skills} onOpen={props.onOpenSkill} visible={props.visibleSkills} />
      : <ExpertCatalogPage {...props} all={props.expertKits} installingId={props.installingKitId} onOpen={props.onOpenExpertKit} visible={props.visibleExpertKits} />}
  </>
}

export function ExpertCatalogPage(props: CommonProps & {
  all: ExpertKitView[]; visible: ExpertKitView[]; installingId: string; onOpen: (id: string) => void
}) {
  const [sort, setSort] = useState<'recommended' | 'name'>('recommended')
  const visible = useMemo(() => sort === 'name'
    ? [...props.visible].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    : props.visible, [props.visible, sort])
  const installedCount = props.all.filter((item) => item.installState === 'installed' || item.installState === 'update').length
  return <>
    <CapabilityHero kind="experts" />
    <CatalogHeading filter={props.filter} installedCount={installedCount} marketCount={props.all.filter((item) => extensionMatches(item, '', 'market')).length} onFilter={props.onFilter} onSort={setSort} sort={sort} />
    {props.filter === 'market' && <ExtensionCategoryBar onChange={props.onCategory} value={props.category} />}
    {props.loading && (visible.length === 0 ? <CatalogLoading kind="expert" label="正在同步公司专家套件…" /> : <p className="catalog-refresh-status" role="status">正在同步公司专家套件…</p>)}
    {!props.loading && props.all.length === 0 && <div className="kit-empty">控制中心尚未发布专家套件</div>}
    {props.error && <div className="kit-error">{props.error}</div>}
    {!props.loading && props.all.length > 0 && visible.length === 0 && <div className="kit-empty">没有匹配的专家套件</div>}
    <div className="kit-grid expert-market-grid">{visible.map((kit) => {
      const installed = kit.installState === 'installed' || kit.installState === 'update'
      const actionLabel = kit.installState === 'retired' ? '查看并卸载' : kit.installState === 'update' ? '查看更新' : installed ? '查看详情' : '查看并安装'
      return <article className="market-card" key={kit.id}>
        <div className="market-card-title"><CatalogKitIcon installPath={kit.installed?.installPath} /><div><h3><button className="market-card-name" onClick={() => props.onOpen(kit.id)} type="button">{kit.name}</button></h3><small>@{kit.author || (kit.localOnly ? '我的创作' : '小胤企业市场')}</small></div><button aria-label={`${actionLabel}：${kit.name}`} className={installed ? 'installed' : ''} disabled={props.installingId === kit.id} onClick={() => props.onOpen(kit.id)} title={actionLabel} type="button">{installed ? <Check size={18} /> : <Plus size={20} />}</button></div>
        <p>{kit.summary}</p>
        {kit.readiness === 'partial' && <div className="market-card-warning">部分依赖待配置，安装后仍可继续完善</div>}
        <footer><span>{kit.skillIds.length} 个技能{kit.commandIds.length > 0 ? ` · ${kit.commandIds.length} 个指令` : ''}</span><span>v{kit.version}</span></footer>
      </article>
    })}</div>
  </>
}

function CatalogKitIcon({ installPath }: { installPath?: string }) {
  const [failed, setFailed] = useState(false)
  const source = installPath && isTauri() ? convertFileSrc(`${installPath}/assets/icon.svg`) : ''
  return <span className="market-card-icon">{source && !failed
    ? <img alt="" aria-hidden="true" onError={() => setFailed(true)} src={source} />
    : <Boxes size={18} />}</span>
}

export function SkillCatalogPage(props: CommonProps & { all: SkillView[]; visible: SkillView[]; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<'recommended' | 'name'>('recommended')
  const visible = useMemo(() => sort === 'name'
    ? [...props.visible].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    : props.visible, [props.visible, sort])
  const installedCount = props.all.filter((item) => item.installState === 'installed' || item.installState === 'update').length
  return <>
    <CapabilityHero highlights={props.all.filter((item) => item.installState !== 'retired')} kind="skills" onOpenHighlight={props.onOpen} />
    <CatalogHeading builtIn filter={props.filter} installedCount={installedCount} marketCount={props.all.filter((item) => extensionMatches(item, '', 'market')).length} onFilter={props.onFilter} onSort={setSort} sort={sort} />
    {props.filter === 'market' && <ExtensionCategoryBar onChange={props.onCategory} value={props.category} />}
    {props.loading && (visible.length === 0 ? <CatalogLoading kind="skill" label="正在同步公司技能…" /> : <p className="catalog-refresh-status" role="status">正在同步公司技能…</p>)}
    {!props.loading && props.all.length === 0 && <div className="kit-empty">控制中心尚未发布独立技能</div>}
    {props.error && <div className="kit-error">{props.error}</div>}
    {!props.loading && props.all.length > 0 && visible.length === 0 && <div className="kit-empty">没有匹配的技能</div>}
    {visible.length > 0 && <h2 className="catalog-section-label">{props.filter === 'builtin' ? '本机技能' : props.filter === 'installed' ? '已安装技能' : '企业技能'}<span>{visible.length}</span></h2>}
    <div className={props.filter === 'market' ? 'kit-grid skill-market-grid' : 'installed-skill-list'}>{visible.map((skill) => {
      const installed = skill.installState === 'installed' || skill.installState === 'update'
      const actionLabel = skill.installState === 'retired' ? '查看并卸载' : skill.installState === 'update' ? '查看更新' : installed ? '查看详情' : '查看并安装'
      if (props.filter !== 'market') return <article className="installed-skill-row" key={skill.id}>
        <button className="installed-skill-info" onClick={() => props.onOpen(skill.id)} type="button"><span className="market-card-icon"><Sparkles size={18} /></span><span><strong>{skill.name}</strong><small>{skill.summary}</small></span></button>
        {installed && props.onUseSkill && <button className="installed-skill-use" disabled={skill.installed?.enabled === false} onClick={() => props.onUseSkill?.(skill.id)} type="button">使用</button>}
        {skill.installed && skill.installState !== 'retired' ? <ExtensionEnableSwitch extension={skill.installed} onChanged={props.onChanged} /> : <button onClick={() => props.onOpen(skill.id)} type="button">{actionLabel}</button>}
      </article>
      return <article className="market-card skill-card" key={skill.id}>
        <div className="market-card-title"><span className="market-card-icon"><Sparkles size={18} /></span><div><h3><button className="market-card-name" onClick={() => props.onOpen(skill.id)} type="button">{skill.name}</button></h3><small>{skill.id}</small></div><button aria-label={`${actionLabel}：${skill.name}`} className={installed ? 'installed' : ''} onClick={() => props.onOpen(skill.id)} title={actionLabel} type="button">{installed ? <Check size={18} /> : <Plus size={20} />}</button></div>
        <p>{skill.summary}</p>
    <footer><span>{skill.triggers.length > 0 ? skill.triggers.slice(0, 2).join(' · ') : skill.localOnly ? '本机技能' : '企业精选'}</span><span>v{skill.version}</span></footer>
      </article>
    })}</div>
  </>
}

function CatalogHeading({ filter, marketCount, installedCount, builtIn = false, sort, onFilter, onSort }: {
  filter: ExtensionFilter
  marketCount: number
  installedCount: number
  builtIn?: boolean
  sort: 'recommended' | 'name'
  onFilter: (value: ExtensionFilter) => void
  onSort: (value: 'recommended' | 'name') => void
}) {
  return <div className="catalog-heading-row"><div className="catalog-tabs" role="tablist"><button aria-selected={filter === 'market'} className={filter === 'market' ? 'active' : ''} onClick={() => onFilter('market')} role="tab" type="button">{builtIn ? '市场' : '套件广场'} <em>{marketCount}</em></button>{builtIn && <button aria-selected={filter === 'builtin'} className={filter === 'builtin' ? 'active' : ''} onClick={() => onFilter('builtin')} role="tab" type="button">本机</button>}<button aria-selected={filter === 'installed'} className={filter === 'installed' ? 'active' : ''} onClick={() => onFilter('installed')} role="tab" type="button">已安装 <em>{installedCount}</em></button></div>{filter === 'market' && <div className="catalog-sort"><button className={sort === 'recommended' ? 'active' : ''} onClick={() => onSort('recommended')} type="button">推荐</button><button className={sort === 'name' ? 'active' : ''} onClick={() => onSort('name')} type="button">名称</button></div>}</div>
}
