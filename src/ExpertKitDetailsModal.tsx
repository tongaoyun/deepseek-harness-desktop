import {
  BookOpenCheck,
  Boxes,
  CalendarClock,
  ArrowRight,
  PlugZap,
  Trash2,
  WandSparkles,
  MoreHorizontal,
  MessageSquare,
} from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { expertKitChanges } from './expertKitDetails'
import { ExtensionDetailLayout } from './ExtensionDetailLayout'
import { ExtensionActionMenu, InstalledExtensionControls } from './InstalledExtensionControls'
import { ExtensionContentsPanel } from './ExtensionContentsPanel'
import { extensionCategoryLabel } from './extensionCategories'
import type { ExpertKitView, ExtensionDocument } from './expertKits'
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
  onCustomizeDocument?: (document: ExtensionDocument) => void
  onExport?: () => void
  onUse?: (command?: string) => void
  onUseSkill?: (skill: ExtensionDocument) => void
  onConfigureConnectors?: () => void
  onChanged?: () => Promise<void> | void
}

export function ExpertKitDetailsModal({
  kit, skills, connectors, knowledgeBases, installing, removing, onClose, onInstall, onRemove, onSchedule, onCustomize, onCustomizeDocument, onExport, onUse, onUseSkill, onConfigureConnectors, onChanged,
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
        {(onRemove || onUse || kit.installState === 'installed') && <ExtensionActionMenu label="更多操作" icon={<MoreHorizontal size={16} />}>
          {onUse && <button onClick={() => onUse()} type="button"><MessageSquare size={14} />使用套件</button>}
          {kit.installState === 'installed' && <button onClick={onSchedule} type="button"><CalendarClock size={14} />创建定时任务</button>}
          {onRemove && <button className="danger" disabled={removing} onClick={onRemove} type="button"><Trash2 size={14} />{removing ? '正在卸载…' : '卸载套件'}</button>}
        </ExtensionActionMenu>}
        {kit.installed && kit.installState !== 'retired' && <InstalledExtensionControls extension={kit.installed} onChanged={onChanged} onCustomize={onCustomize} onExport={onExport} showLabels />}
        {kit.installState === 'retired' || kit.installState === 'installed' ? null : kit.installState === 'update' ? <>
          <button disabled={installing || !kit.sha256} onClick={onInstall} type="button">{installing ? '正在校验并安装…' : '确认更新'}</button>
        </> : <button disabled={installing || !kit.sha256} onClick={onInstall} type="button">{installing ? '正在校验并安装…' : '确认安装'}</button>}
  </>}>
      <div className="extension-profile">
        <span><Boxes size={22} /></span>
        <div><div className="extension-profile-title"><h2 id="expert-kit-title">{kit.name}</h2><span className="extension-profile-badge">v{kit.installedVersion ?? kit.version}</span><span className="extension-profile-badge">{kit.localOnly ? '本地导入' : kit.installState === 'retired' ? '已下架' : '套件市场'}</span></div><p className="extension-reader-meta">{kit.installed?.author || kit.author ? `@${kit.installed?.author || kit.author}` : `${stateLabel} · ${extensionCategoryLabel(kit.category)}`}</p></div>
      </div>
      <p className="extension-profile-summary">{kit.summary}</p>

      {issues.length > 0 && <div className="expert-dependency-state partial"><PlugZap size={15} /><span>部分能力暂不可用：{issues.join('；')}</span></div>}

      {kit.installState === 'retired' && <section className="expert-detail-section update-changes">
        <strong>该专家套件已从公司目录下架，桌面端和 IM 均不会再加载或执行它。</strong>
        <p>本地文件仅用于显示状态，可安全卸载；历史任务记录不会删除。</p>
      </section>}

      {kit.installState === 'update' && <section className="expert-detail-section update-changes">
        <h3>从 v{kit.installedVersion} 更新的变化</h3>
        <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul>
      </section>}

      {!kit.installed && commands.length > 0 && <section className="expert-detail-section">
        <h3>快捷命令 <small>({commands.length})</small></h3>
        <div className="detail-command-list">{commands.map((id) => <button disabled={!onUse} key={id} onClick={() => onUse?.(id)} type="button"><code>/{id}</code><span>{skillById.get(id)?.summary || '使用套件中的工作流程处理任务'}</span><ArrowRight size={15} /></button>)}</div>
      </section>}
      {!kit.installed && kit.skillIds.length > 0 && <section className="expert-detail-section">
        <h3>知识技能 <small>({kit.skillIds.length})</small></h3>
        <div className="detail-skill-list">{kit.skillIds.map((id) => <article key={id}><WandSparkles size={15} /><div><strong>{skillById.get(id)?.name ?? id}</strong><p>{skillById.get(id)?.summary || '随专家套件一起加载的工作方法'}</p></div></article>)}</div>
      </section>}
      {kit.installed && <ExtensionContentsPanel extension={kit.installed} onUseSkill={onUseSkill} onUseCommand={onUse} onCustomize={onCustomizeDocument} />}
      {(kit.connectorRefs.length > 0 || kit.knowledgeBaseRefs.length > 0) && <section className="expert-detail-section">
        <h3>连接器与知识库</h3>
        <div className="expert-content-groups">
          {kit.connectorRefs.length > 0 && <DetailGroup icon={<PlugZap size={14} />} title={`连接器 ${kit.connectorRefs.length}`} values={kit.connectorRefs.map((id) => connectorById.get(id)?.name ?? id)} />}
          {kit.knowledgeBaseRefs.length > 0 && <DetailGroup icon={<BookOpenCheck size={14} />} title={`知识库 ${kit.knowledgeBaseRefs.length}`} values={kit.knowledgeBaseRefs.map((reference) => knowledgeByReference.get(reference)?.name ?? reference)} />}
        </div>
      </section>}

      {kit.connectorRefs.length > 0 && onConfigureConnectors && <button className="kit-configure-link" onClick={onConfigureConnectors} type="button"><PlugZap size={14} />查看和配置连接器</button>}


  </ExtensionDetailLayout>
}

function DetailGroup({ icon, title, values }: { icon: ReactNode; title: string; values: string[] }) {
  return <div><h4>{icon}{title}</h4><p>{values.join(' · ')}</p></div>
}
