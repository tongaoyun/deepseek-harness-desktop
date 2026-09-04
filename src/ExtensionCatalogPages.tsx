import { Boxes, Check, Plus, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import { ExtensionCategoryBar, type ExtensionFilter } from './ExtensionToolbar'
import type { ExtensionCategoryFilter } from './extensionCategories'
import { XiaoyinMascot } from './XiaoyinMascot'

interface CommonProps {
  loading: boolean
  error: string
  filter: ExtensionFilter
  category: ExtensionCategoryFilter
  onFilter: (value: ExtensionFilter) => void
  onCategory: (value: ExtensionCategoryFilter) => void
}

export function ExpertCatalogPage(props: CommonProps & {
  all: ExpertKitView[]; visible: ExpertKitView[]; installingId: string; onOpen: (id: string) => void
}) {
  const [sort, setSort] = useState<'popular' | 'latest'>('popular')
  const visible = useMemo(() => sort === 'latest'
    ? [...props.visible].sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
    : props.visible, [props.visible, sort])
  const installedCount = props.all.filter((item) => item.installState === 'installed' || item.installState === 'update').length
  return <>
    <CatalogHero kind="experts" />
    <CatalogHeading filter={props.filter} installedCount={installedCount} marketCount={props.all.filter((item) => item.installState !== 'retired').length} onFilter={props.onFilter} onSort={setSort} sort={sort} />
    <ExtensionCategoryBar onChange={props.onCategory} value={props.category} />
    {props.loading && <div className="kit-empty">正在同步公司专家套件…</div>}
    {!props.loading && props.all.length === 0 && <div className="kit-empty">控制中心尚未发布专家套件</div>}
    {props.error && <div className="kit-error">{props.error}</div>}
    {!props.loading && props.all.length > 0 && visible.length === 0 && <div className="kit-empty">没有匹配的专家套件</div>}
    <div className="kit-grid expert-market-grid">{visible.map((kit) => {
      const installed = kit.installState === 'installed' || kit.installState === 'update'
      const actionLabel = kit.installState === 'retired' ? '查看并卸载' : installed ? '查看详情' : kit.installState === 'update' ? '查看更新' : '查看并安装'
      return <article className="market-card" key={kit.id}>
        <div className="market-card-title"><span className="market-card-icon"><Boxes size={18} /></span><div><h3>{kit.name}</h3><small>@{kit.localOnly ? '我的创作' : '小胤企业市场'}</small></div><button aria-label={actionLabel} className={installed ? 'installed' : ''} disabled={props.installingId === kit.id} onClick={() => props.onOpen(kit.id)} title={actionLabel} type="button">{installed ? <Check size={18} /> : <Plus size={20} />}</button></div>
        <p>{kit.summary}</p>
        {kit.readiness === 'partial' && <div className="market-card-warning">部分依赖待配置，安装后仍可继续完善</div>}
        <footer><span>{kit.skillIds.length} 个技能{kit.commandIds.length > 0 ? ` · ${kit.commandIds.length} 个指令` : ''}</span><span>v{kit.version}</span></footer>
      </article>
    })}</div>
  </>
}

export function SkillCatalogPage(props: CommonProps & { all: SkillView[]; visible: SkillView[]; onOpen: (id: string) => void }) {
  const [sort, setSort] = useState<'popular' | 'latest'>('popular')
  const visible = useMemo(() => sort === 'latest'
    ? [...props.visible].sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
    : props.visible, [props.visible, sort])
  const installedCount = props.all.filter((item) => item.installState === 'installed' || item.installState === 'update').length
  return <>
    <CatalogHero kind="skills" />
    <CatalogHeading builtIn filter={props.filter} installedCount={installedCount} marketCount={props.all.filter((item) => !item.localOnly && item.installState !== 'retired').length} onFilter={props.onFilter} onSort={setSort} sort={sort} />
    <ExtensionCategoryBar onChange={props.onCategory} value={props.category} />
    {props.loading && <div className="kit-empty">正在同步公司技能…</div>}
    {!props.loading && props.all.length === 0 && <div className="kit-empty">控制中心尚未发布独立技能</div>}
    {props.error && <div className="kit-error">{props.error}</div>}
    {!props.loading && props.all.length > 0 && visible.length === 0 && <div className="kit-empty">没有匹配的技能</div>}
    <div className="kit-grid skill-market-grid">{visible.map((skill) => {
      const installed = skill.installState === 'installed' || skill.installState === 'update'
      const actionLabel = skill.installState === 'retired' ? '查看并卸载' : installed ? '查看详情' : skill.installState === 'update' ? '查看更新' : '查看并安装'
      return <article className="market-card skill-card" key={skill.id}>
        <div className="market-card-title"><span className="market-card-icon"><Sparkles size={18} /></span><div><h3>{skill.name}</h3><small>{skill.id}</small></div><button aria-label={actionLabel} className={installed ? 'installed' : ''} onClick={() => props.onOpen(skill.id)} title={actionLabel} type="button">{installed ? <Check size={18} /> : <Plus size={20} />}</button></div>
        <p>{skill.summary}</p>
        <footer><span>{skill.triggers.length > 0 ? skill.triggers.slice(0, 2).join(' · ') : skill.localOnly ? '内置技能' : '企业精选'}</span><span>v{skill.version}</span></footer>
      </article>
    })}</div>
  </>
}

function CatalogHero({ kind }: { kind: 'experts' | 'skills' }) {
  return <section className={`catalog-hero ${kind}`}><div><strong>{kind === 'experts' ? '为每个岗位准备一套成熟工作方法' : '为你精选的职场技能'}</strong><p>{kind === 'experts' ? '把常用技能、数据源和工作流组合起来，一键加入对话。' : '涵盖写作、效率、设计、数据分析等多种场景，一键安装。'}</p></div><div className="catalog-hero-art"><span>效率</span><span>分析</span><span>创作</span><XiaoyinMascot size={82} variant={kind === 'experts' ? 'expert' : 'skill'} /></div></section>
}

function CatalogHeading({ filter, marketCount, installedCount, builtIn = false, sort, onFilter, onSort }: {
  filter: ExtensionFilter
  marketCount: number
  installedCount: number
  builtIn?: boolean
  sort: 'popular' | 'latest'
  onFilter: (value: ExtensionFilter) => void
  onSort: (value: 'popular' | 'latest') => void
}) {
  return <div className="catalog-heading-row"><div className="catalog-tabs" role="tablist"><button aria-selected={filter === 'market'} className={filter === 'market' ? 'active' : ''} onClick={() => onFilter('market')} role="tab" type="button">{builtIn ? '市场' : '套件广场'} <em>{marketCount}</em></button>{builtIn && <button aria-selected={filter === 'builtin'} className={filter === 'builtin' ? 'active' : ''} onClick={() => onFilter('builtin')} role="tab" type="button">内置</button>}<button aria-selected={filter === 'installed'} className={filter === 'installed' ? 'active' : ''} onClick={() => onFilter('installed')} role="tab" type="button">已安装 <em>{installedCount}</em></button></div><div className="catalog-sort"><button className={sort === 'popular' ? 'active' : ''} onClick={() => onSort('popular')} type="button">热门</button><button className={sort === 'latest' ? 'active' : ''} onClick={() => onSort('latest')} type="button">最新</button></div></div>
}
