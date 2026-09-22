import { BookOpenCheck, PlugZap, Trash2, WandSparkles, MoreHorizontal, MessageSquare } from 'lucide-react'
import { ExtensionReaderDialog } from './ExtensionReaderDialog'
import { ExtensionActionMenu, InstalledExtensionControls } from './InstalledExtensionControls'
import { ExtensionContentsPanel } from './ExtensionContentsPanel'
import { extensionCategoryLabel } from './extensionCategories'
import { versionRequirement } from './extensionVersion'
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
  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeByReference = new Map(knowledgeBases.map((entry) => [entry.reference, entry]))
  const issues = [...skill.connectorIssues, ...skill.knowledgeIssues]
  const state = skill.installState === 'retired' ? '已下架' : skill.installState === 'incompatible' ? '需要升级桌面端' : skill.installState === 'installed' ? '已安装' : '安装确认'
  return <ExtensionReaderDialog title={skill.name} onClose={onClose} heading={<>
      <div className="extension-profile"><span><WandSparkles size={22} /></span><div><h2>{skill.name}</h2><p className="extension-reader-meta">{skill.localOnly ? '本地技能' : state} · {extensionCategoryLabel(skill.category)}</p></div></div>
      <p className="extension-reader-summary">{skill.summary}</p>
    </>} actions={<>
        {skill.installed && skill.installState === 'installed' && <InstalledExtensionControls extension={skill.installed} onChanged={onChanged} onCustomize={onCustomize} onExport={onExport} />}

        {onRemove && <ExtensionActionMenu label="更多操作" icon={<MoreHorizontal size={16} />}><button className="danger" disabled={removing} onClick={onRemove} type="button"><Trash2 size={14} />{removing ? '正在卸载…' : '卸载技能'}</button></ExtensionActionMenu>}
        {onUse && <button onClick={onUse} type="button"><MessageSquare size={14} />使用</button>}
        {skill.installState === 'available' && <button disabled={installing || !skill.sha256} onClick={onInstall} type="button">{installing ? '正在校验并安装…' : '确认安装'}</button>}
  </>}>
      {issues.length > 0 && <div className="expert-dependency-state partial"><PlugZap size={15} /><span>部分能力暂不可用：{issues.join('；')}</span></div>}
      {skill.installState === 'retired' && <section className="expert-detail-section update-changes">
        <strong>该技能已从公司目录下架，桌面端和 IM 均不会再加载或执行它。</strong>
        <p>本地文件仅用于显示状态，可安全卸载；历史任务记录不会删除。</p>
      </section>}
      {skill.installState === 'incompatible' && <section className="expert-detail-section update-changes">
        <strong>当前桌面端版本不支持此技能。</strong>
        <p>{versionRequirement(skill.minimumDesktopVersion)}。升级后再安装，避免加载不兼容的扩展 Schema。</p>
      </section>}
      {skill.updateRequiresDesktopUpgrade && skill.installState === 'installed' && <section className="expert-detail-section update-changes">
        <strong>已安装版本 {skill.installedVersion} 仍可使用；市场新版本暂不可更新。</strong>
        <p>{versionRequirement(skill.minimumDesktopVersion)}，升级桌面端后可更新到 {skill.version}。</p>
      </section>}
      {skill.triggers.length > 0 && <section className="expert-detail-section">
        <h3>触发场景</h3>
        <div className="connector-tools">{skill.triggers.join(' · ')}</div>
      </section>}
      {skill.installed && <ExtensionContentsPanel extension={skill.installed} />}
      {(skill.connectorRefs.length > 0 || skill.knowledgeBaseRefs.length > 0 || skill.requiredTools.length > 0) && <section className="expert-detail-section">
        <h3>依赖能力</h3>
        <div className="expert-content-groups">
          {skill.connectorRefs.length > 0 && <div><h4><PlugZap size={14} />连接器 {skill.connectorRefs.length}</h4><p>{skill.connectorRefs.map((id) => connectorById.get(id)?.name ?? id).join(' · ')}</p></div>}
          {skill.knowledgeBaseRefs.length > 0 && <div><h4><BookOpenCheck size={14} />知识库 {skill.knowledgeBaseRefs.length}</h4><p>{skill.knowledgeBaseRefs.map((id) => knowledgeByReference.get(id)?.name ?? id).join(' · ')}</p></div>}
          {skill.requiredTools.length > 0 && <div><h4><WandSparkles size={14} />工具 {skill.requiredTools.length}</h4><p>{skill.requiredTools.join(' · ')}</p></div>}
        </div>
      </section>}

  </ExtensionReaderDialog>
}
