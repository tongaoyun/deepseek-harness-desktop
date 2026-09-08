import {
  BookOpenCheck,
  Boxes,
  CalendarClock,
  CheckCircle2,
  ArrowRight,
  PlugZap,
  Trash2,
  WandSparkles,
} from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { expertKitChanges } from './expertKitDetails'
import { ExtensionDetailLayout } from './ExtensionDetailLayout'
import { InstalledExtensionControls } from './InstalledExtensionControls'
import { ExtensionContentsPanel } from './ExtensionContentsPanel'
import { extensionCategoryLabel } from './extensionCategories'
import type { ExpertKitView } from './expertKits'
import type { ConnectorCatalogEntry, KnowledgeBaseEntry, SkillCatalogEntry } from './types'

interface ExpertKitDetailsModalProps {
  kit: ExpertKitView
  skills: SkillCatalogEntry[]
  connectors: ConnectorCatalogEntry[]
  knowledgeBases: KnowledgeBaseEntry[]
  installing: boolean
  removing: boolean
  onClose: () => void
  onInstall: () => void
  onRemove?: () => void
  onSchedule: () => void
  onCustomize?: () => void
  onExport?: () => void
  onUse?: (command?: string) => void
  onConfigureConnectors?: () => void
  onChanged?: () => Promise<void> | void
}

export function ExpertKitDetailsModal({
  kit, skills, connectors, knowledgeBases, installing, removing, onClose, onInstall, onRemove, onSchedule, onCustomize, onExport, onUse, onConfigureConnectors, onChanged,
}: ExpertKitDetailsModalProps) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])

  const skillById = new Map(skills.map((skill) => [skill.id, skill]))
  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeByReference = new Map(knowledgeBases.map((knowledgeBase) => [knowledgeBase.reference, knowledgeBase]))
  const changes = expertKitChanges(kit)
  const stateLabel = kit.localOnly ? '本地专家套件' : kit.installState === 'retired' ? '已下架' : kit.installState === 'installed' ? '已安装' : kit.installState === 'update' ? '更新确认' : '安装确认'
  const issues = [...kit.connectorIssues, ...kit.knowledgeIssues]
  const commands = kit.installed?.manifest.commands.map((command) => command.id) ?? kit.commandIds

  return <ExtensionDetailLayout titleId="expert-kit-title" onClose={onClose} actions={<>
        {kit.installed && kit.installState !== 'retired' && <InstalledExtensionControls extension={kit.installed} onChanged={onChanged} onCustomize={onCustomize} onExport={onExport} />}
        {onUse && <button onClick={() => onUse()} type="button">在对话中使用</button>}
        {onRemove && <button className="danger" disabled={removing} onClick={onRemove} type="button"><Trash2 size={14} />{removing ? '正在卸载…' : kit.localOnly ? '移除本地套件' : '卸载套件'}</button>}
        {kit.installState === 'retired' ? null : kit.installState === 'installed' ? <>
          <button className="secondary" onClick={onSchedule} type="button"><CalendarClock size={14} /> 创建定时任务</button>
        </> : kit.installState === 'update' ? <>
          <button disabled={installing || !kit.sha256} onClick={onInstall} type="button">{installing ? '正在校验并安装…' : '确认更新'}</button>
        </> : <button disabled={installing || !kit.sha256} onClick={onInstall} type="button">{installing ? '正在校验并安装…' : '确认安装'}</button>}
  </>}>
      <div className="expert-modal-heading">
        <span><Boxes size={22} /></span>
        <div><small>{stateLabel} · {extensionCategoryLabel(kit.category)} · v{kit.version}</small><h2 id="expert-kit-title">{kit.name}</h2><p>{kit.summary}</p></div>
      </div>

      <div className={`expert-dependency-state ${kit.readiness}`}>
        {kit.readiness === 'ready'
          ? <><CheckCircle2 size={15} /><span>{kit.connectorRefs.length > 0 ? '依赖配置完整 · 连接与授权状态待检测' : '依赖配置完整'}</span></>
          : <><PlugZap size={15} /><span>安装后部分能力暂不可用：{issues.join('；')}</span></>}
      </div>

      {kit.installState === 'retired' && <section className="expert-detail-section update-changes">
        <strong>该专家套件已从公司目录下架，桌面端和 IM 均不会再加载或执行它。</strong>
        <p>本地文件仅用于显示状态，可安全卸载；历史任务记录不会删除。</p>
      </section>}

      {kit.installState === 'update' && <section className="expert-detail-section update-changes">
        <h3>从 v{kit.installedVersion} 更新的变化</h3>
        <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul>
      </section>}

      <section className="expert-detail-section">
        <h3>快捷命令 <small>({commands.length})</small></h3>
        {!onUse && commands.length > 0 && <p>{kit.installed?.enabled === false ? '在聊天中启用套件后，即可使用命令。' : '安装套件后可点击命令，带入新对话继续工作。'}</p>}
        <div className="detail-command-list">{commands.map((id) => <button disabled={!onUse} key={id} onClick={() => onUse?.(id)} type="button"><code>/{id}</code><span>{skillById.get(id)?.summary || '使用套件中的工作流程处理任务'}</span><ArrowRight size={15} /></button>)}</div>
        {commands.length === 0 && <p>没有单独的快捷命令，可直接在对话中使用整个套件。</p>}
      </section>
      {!kit.installed && <section className="expert-detail-section">
        <h3>知识技能 <small>({kit.skillIds.length})</small></h3>
        <div className="detail-skill-list">{kit.skillIds.map((id) => <article key={id}><WandSparkles size={15} /><div><strong>{skillById.get(id)?.name ?? id}</strong><p>{skillById.get(id)?.summary || '随专家套件一起加载的工作方法'}</p></div></article>)}</div>
      </section>}
      {kit.installed && <ExtensionContentsPanel extension={kit.installed} />}
      <section className="expert-detail-section">
        <h3>连接器与知识库</h3>
        <div className="expert-content-groups">
          <DetailGroup icon={<PlugZap size={14} />} title={`连接器 ${kit.connectorRefs.length}`} values={kit.connectorRefs.map((id) => connectorById.get(id)?.name ?? id)} empty="不使用连接器" />
          <DetailGroup icon={<BookOpenCheck size={14} />} title={`知识库 ${kit.knowledgeBaseRefs.length}`} values={kit.knowledgeBaseRefs.map((reference) => knowledgeByReference.get(reference)?.name ?? reference)} empty="不绑定知识库" />
        </div>
      </section>

      {kit.connectorRefs.length > 0 && onConfigureConnectors && <button className="kit-configure-link" onClick={onConfigureConnectors} type="button"><PlugZap size={14} />查看和配置连接器</button>}


  </ExtensionDetailLayout>
}

function DetailGroup({ icon, title, values, empty }: { icon: ReactNode; title: string; values: string[]; empty: string }) {
  return <div><h4>{icon}{title}</h4><p>{values.length > 0 ? values.join(' · ') : empty}</p></div>
}
