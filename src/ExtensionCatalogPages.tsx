import { PackagePlus } from 'lucide-react'
import type { ExpertKitView } from './expertKits'
import type { SkillView } from './skills'
import { extensionCategoryLabel, type ExtensionCategoryFilter } from './extensionCategories'
import { ExtensionCategoryBar, ExtensionToolbar, type ExtensionFilter } from './ExtensionToolbar'

interface CommonProps {
  loading: boolean
  error: string
  filter: ExtensionFilter
  query: string
  category: ExtensionCategoryFilter
  onFilter: (value: ExtensionFilter) => void
  onQuery: (value: string) => void
  onCategory: (value: ExtensionCategoryFilter) => void
}

export function ExpertCatalogPage(props: CommonProps & {
  all: ExpertKitView[]; visible: ExpertKitView[]; installingId: string; developerMode: boolean; developerBusy: boolean
  onCreate: () => void; onImport: () => void; onOpen: (id: string) => void
}) {
  return <>
    {props.loading && <div className="kit-empty">正在同步公司专家套件…</div>}
    {!props.loading && props.all.length === 0 && <div className="kit-empty">控制中心尚未发布专家套件</div>}
    {props.error && <div className="kit-error">{props.error}</div>}
    {props.developerMode && <div className="developer-kit-bar"><span><strong>专家套件工作台</strong><small>可新建模板或导入 ZIP / tar.gz；本地套件不会上传到公司目录。</small></span><button onClick={props.onCreate} type="button">新建套件</button><button disabled={props.developerBusy} onClick={props.onImport} type="button"><PackagePlus size={14} />{props.developerBusy ? '正在处理…' : '导入本地套件'}</button></div>}
    <ExtensionToolbar filter={props.filter} query={props.query} onFilter={props.onFilter} onQuery={props.onQuery} />
    <ExtensionCategoryBar onChange={props.onCategory} value={props.category} />
    {!props.loading && props.all.length > 0 && props.visible.length === 0 && <div className="kit-empty">没有匹配的专家套件</div>}
    <div className="kit-grid">{props.visible.map((kit) => {
      const installing = props.installingId === kit.id
      const stateLabel = kit.localOnly ? '本地验收' : kit.installState === 'retired' ? '已下架' : kit.installState === 'installed' ? '已安装' : kit.installState === 'update' ? '可更新' : '可安装'
      return <article key={kit.id}><div className="kit-card-head"><span className={`kit-state ${kit.installState}`}>{stateLabel}</span><small>{extensionCategoryLabel(kit.category)} · v{kit.version}</small></div><h3>{kit.name}</h3><p>{kit.summary}</p><div className="kit-capabilities"><small>{kit.skillIds.length} 个技能</small><small>{kit.connectorRefs.length} 个连接器</small><small>{kit.knowledgeBaseRefs.length} 个知识库</small><small>{kit.requiredTools.length} 个工具依赖</small></div><div className={`kit-readiness ${kit.readiness}`}>{kit.readiness === 'ready' ? '连接器、工具和知识库已就绪' : `部分能力待启用：${[...kit.connectorIssues, ...kit.knowledgeIssues].join('；')}`}</div>{kit.installState === 'update' && <div className="kit-version-note">已安装 v{kit.installedVersion}</div>}{kit.installState === 'retired' && <div className="kit-version-note">已停止加载，可卸载本地文件</div>}<button className="kit-install" disabled={installing || (!kit.sha256 && !['installed', 'retired'].includes(kit.installState))} onClick={() => props.onOpen(kit.id)} type="button">{installing ? '正在校验并安装…' : kit.installState === 'retired' ? '查看并卸载' : kit.installState === 'installed' ? '查看详情' : kit.installState === 'update' ? '查看更新' : '查看并安装'}</button></article>
    })}</div>
  </>
}

export function SkillCatalogPage(props: CommonProps & { all: SkillView[]; visible: SkillView[]; onOpen: (id: string) => void }) {
  return <>
    {props.loading && <div className="kit-empty">正在同步公司技能…</div>}
    {!props.loading && props.all.length === 0 && <div className="kit-empty">控制中心尚未发布独立技能</div>}
    {props.error && <div className="kit-error">{props.error}</div>}
    <ExtensionToolbar filter={props.filter} query={props.query} onFilter={props.onFilter} onQuery={props.onQuery} />
    <ExtensionCategoryBar onChange={props.onCategory} value={props.category} />
    {!props.loading && props.all.length > 0 && props.visible.length === 0 && <div className="kit-empty">没有匹配的 Skill</div>}
    <div className="kit-grid">{props.visible.map((skill) => {
      const installed = skill.installState === 'installed'
      const stateLabel = skill.localOnly ? '个人创作' : skill.installState === 'retired' ? '已下架' : installed ? '已安装' : skill.installState === 'update' ? '可更新' : '可安装'
      return <article key={skill.id}><div className="kit-card-head"><span className={`kit-state ${skill.installState}`}>{stateLabel}</span><small>{extensionCategoryLabel(skill.category)} · v{skill.version}</small></div><h3>{skill.name}</h3><p>{skill.summary}</p><div className="kit-capabilities">{skill.triggers.slice(0, 3).map((trigger) => <small key={trigger}>{trigger}</small>)}</div><div className={`kit-readiness ${skill.readiness}`}>{skill.readiness === 'ready' ? '所需能力已就绪' : '部分依赖暂不可用'}</div>{skill.installState === 'update' && <div className="kit-version-note">已安装 v{skill.installedVersion}</div>}{skill.installState === 'retired' && <div className="kit-version-note">已停止加载，可卸载本地文件</div>}<button className="kit-install" onClick={() => props.onOpen(skill.id)} type="button">{skill.installState === 'retired' ? '查看并卸载' : installed ? '查看详情' : skill.installState === 'update' ? '查看更新' : '查看并安装'}</button></article>
    })}</div>
  </>
}
