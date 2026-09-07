import { BookOpenCheck, CheckCircle2, PlugZap, Trash2, WandSparkles } from 'lucide-react'
import { useEffect } from 'react'
import { ExtensionDetailLayout } from './ExtensionDetailLayout'
import { InstalledExtensionControls } from './InstalledExtensionControls'
import { ExtensionContentsPanel } from './ExtensionContentsPanel'
import { extensionCategoryLabel } from './extensionCategories'
import type { SkillView } from './skills'
import type { ConnectorCatalogEntry, KnowledgeBaseEntry } from './types'

interface SkillDetailsModalProps {
  skill: SkillView
  connectors: ConnectorCatalogEntry[]
  knowledgeBases: KnowledgeBaseEntry[]
  installing: boolean
  removing: boolean
  onClose: () => void
  onInstall: () => void
  onRemove?: () => void
  onUse?: () => void
  onCustomize?: () => void
  onExport?: () => void
  onChanged?: () => Promise<void> | void
}

export function SkillDetailsModal({
  skill, connectors, knowledgeBases, installing, removing, onClose, onInstall, onRemove, onUse, onCustomize, onExport, onChanged,
}: SkillDetailsModalProps) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])

  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeByReference = new Map(knowledgeBases.map((entry) => [entry.reference, entry]))
  const issues = [...skill.connectorIssues, ...skill.knowledgeIssues]
  const state = skill.installState === 'retired' ? '已下架' : skill.installState === 'installed' ? '已安装' : skill.installState === 'update' ? '更新确认' : '安装确认'
  return <ExtensionDetailLayout titleId="skill-title" onClose={onClose} actions={<>
        {skill.installed && skill.installState !== 'retired' && <InstalledExtensionControls extension={skill.installed} onChanged={onChanged} onCustomize={onCustomize} onExport={onExport} />}

        {onRemove && <button className="danger" disabled={removing} onClick={onRemove} type="button"><Trash2 size={14} />{removing ? '正在卸载…' : '卸载技能'}</button>}
        {onUse && <button onClick={onUse} type="button">在对话中使用</button>}
        {skill.installState === 'retired' ? null : skill.installState === 'installed'
          ? null
          : skill.installState === 'update'
            ? <button disabled={installing || !skill.sha256} onClick={onInstall} type="button">{installing ? '正在校验并安装…' : '确认更新'}</button>
            : <button disabled={installing || !skill.sha256} onClick={onInstall} type="button">{installing ? '正在校验并安装…' : '确认安装'}</button>}
  </>}>
      <div className="expert-modal-heading">
        <span><WandSparkles size={22} /></span>
        <div><small>{state} · 独立技能 · {extensionCategoryLabel(skill.category)} · v{skill.version}</small><h2 id="skill-title">{skill.name}</h2><p>{skill.summary}</p></div>
      </div>
      <div className={`expert-dependency-state ${skill.readiness}`}>
        {skill.readiness === 'ready'
          ? <><CheckCircle2 size={15} /><span>当前员工所需的连接器、工具和知识库均已就绪</span></>
          : <><PlugZap size={15} /><span>安装后部分能力暂不可用：{issues.join('；')}</span></>}
      </div>
      {skill.installState === 'update' && <section className="expert-detail-section update-changes">
        <h3>从 v{skill.installedVersion} 更新</h3>
        <p>独立技能制品内容或触发场景已更新，安装后对新会话生效。</p>
      </section>}
      {skill.installState === 'retired' && <section className="expert-detail-section update-changes">
        <strong>该技能已从公司目录下架，桌面端和 IM 均不会再加载或执行它。</strong>
        <p>本地文件仅用于显示状态，可安全卸载；历史任务记录不会删除。</p>
      </section>}
      <section className="expert-detail-section">
        <h3>触发场景</h3>
        <div className="connector-tools">{skill.triggers.join(' · ') || '未设置关键词，由小胤按任务语义自动匹配'}</div>
      </section>
      {skill.installed && <ExtensionContentsPanel extension={skill.installed} />}
      <section className="expert-detail-section">
        <h3>依赖能力</h3>
        <div className="expert-content-groups">
          <div><h4><PlugZap size={14} />连接器 {skill.connectorRefs.length}</h4><p>{skill.connectorRefs.map((id) => connectorById.get(id)?.name ?? id).join(' · ') || '不使用连接器'}</p></div>
          <div><h4><BookOpenCheck size={14} />知识库 {skill.knowledgeBaseRefs.length}</h4><p>{skill.knowledgeBaseRefs.map((id) => knowledgeByReference.get(id)?.name ?? id).join(' · ') || '不绑定知识库'}</p></div>
          <div><h4><WandSparkles size={14} />工具 {skill.requiredTools.length}</h4><p>{skill.requiredTools.join(' · ') || '不声明额外工具'}</p></div>
        </div>
      </section>

  </ExtensionDetailLayout>
}
