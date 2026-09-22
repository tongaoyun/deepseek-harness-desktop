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
  ChevronRight,
} from 'lucide-react'
import { convertFileSrc, isTauri } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { ExtensionDetailLayout } from './ExtensionDetailLayout'
import { ExtensionActionMenu, InstalledExtensionControls } from './InstalledExtensionControls'
import { ExtensionContentsPanel } from './ExtensionContentsPanel'
import { ExtensionReadmeSection } from './ExtensionReadmeSection'
import { extensionCategoryLabel } from './extensionCategories'
import { versionRequirement } from './extensionVersion'
import { extensionCommandSlashLabel } from './extensionInvocations'
import type { ExpertKitView } from './expertKits'
import type { ConnectorRuntimeDefinition, KnowledgeBaseEntry, SkillCatalogEntry } from './types'

interface ExpertKitDetailsModalProps {
  kit: ExpertKitView
  skills: SkillCatalogEntry[]
  connectors: ConnectorRuntimeDefinition[]
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
  onLoadReadme?: (id: string) => Promise<string>
  onConfigureConnectors?: () => void
  onConfigureKnowledge?: () => void
  onToggleConnector?: (connector: ConnectorRuntimeDefinition, enabled: boolean) => void
  onChanged?: () => Promise<void> | void
}

export function ExpertKitDetailsModal({
  kit, skills, connectors, knowledgeBases, installing, removing, onClose, onInstall, onRemove, onSchedule, onCustomize, onExport, onUse, onLoadReadme, onConfigureConnectors, onConfigureKnowledge, onToggleConnector, onChanged,
}: ExpertKitDetailsModalProps) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])

  const skillById = new Map(skills.map((skill) => [skill.id, skill]))
  const kitSkillById = new Map((kit.skillDetails ?? []).map((skill) => [skill.id, skill]))
  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeByReference = new Map(knowledgeBases.map((knowledgeBase) => [knowledgeBase.reference, knowledgeBase]))
  const stateLabel = kit.localOnly ? '本地专家套件' : kit.installState === 'retired' ? '已下架' : kit.installState === 'incompatible' ? '需要升级桌面端' : kit.installState === 'installed' ? '已安装' : '安装确认'
  const issues = [...kit.connectorIssues, ...kit.knowledgeIssues]
  // An installed kit reads its guide from disk; before that the catalog serves it on demand.
  const [catalogReadme, setCatalogReadme] = useState('')
  const readmeSource = kit.installed || !onLoadReadme ? '' : kit.id
  useEffect(() => {
    if (!readmeSource) return setCatalogReadme('')
    let current = true
    onLoadReadme?.(readmeSource).then((value) => { if (current) setCatalogReadme(value) }, () => undefined)
    return () => { current = false }
  }, [onLoadReadme, readmeSource])
  const commands: Array<{ id: string; skillId?: string }> = kit.installed?.manifest.commands ?? kit.commandIds.map((id) => ({ id }))
  return <ExtensionDetailLayout titleId="expert-kit-title" onClose={onClose} actions={<>
        {(onRemove || onUse || kit.installState === 'installed') && <ExtensionActionMenu label="更多操作" icon={<MoreHorizontal size={16} />}>
          {onUse && <button onClick={() => onUse()} type="button"><MessageSquare size={14} />使用套件</button>}
          {kit.installState === 'installed' && <button onClick={onSchedule} type="button"><CalendarClock size={14} />创建定时任务</button>}
          {onRemove && <button className="danger" disabled={removing} onClick={onRemove} type="button"><Trash2 size={14} />{removing ? '正在卸载…' : '卸载套件'}</button>}
        </ExtensionActionMenu>}
        {kit.installed && kit.installState === 'installed' && <InstalledExtensionControls extension={kit.installed} onChanged={onChanged} onCustomize={onCustomize} onExport={onExport} showLabels />}
        {kit.installState === 'available' && <button disabled={installing || !kit.sha256} onClick={onInstall} type="button">{installing ? '正在校验并安装…' : '确认安装'}</button>}
  </>}>
      <div className="extension-profile">
        <ExtensionIcon installPath={kit.installed?.installPath} name={kit.name} />
        <div><div className="extension-profile-title"><h2 id="expert-kit-title">{kit.name}</h2><span className="extension-profile-badge">{kit.localOnly ? '本地导入' : kit.installState === 'retired' ? '已下架' : kit.installState === 'incompatible' ? '需要升级' : '套件市场'}</span></div><p className="extension-reader-meta">{stateLabel} · {extensionCategoryLabel(kit.category)}</p></div>
      </div>
      <p className="extension-profile-summary">{kit.summary}</p>

      {issues.length > 0 && <div className="expert-dependency-state partial"><PlugZap size={15} /><span>部分能力暂不可用：{issues.join('；')}</span></div>}

      {kit.installState === 'retired' && <section className="expert-detail-section update-changes">
        <strong>该专家套件已从公司目录下架，桌面端和 IM 均不会再加载或执行它。</strong>
        <p>本地文件仅用于显示状态，可安全卸载；历史任务记录不会删除。</p>
      </section>}
      {kit.installState === 'incompatible' && <section className="expert-detail-section update-changes">
        <strong>当前桌面端版本不支持此专家套件。</strong>
        <p>{versionRequirement(kit.minimumDesktopVersion)}。升级后再安装，避免加载不兼容的扩展 Schema。</p>
      </section>}
      {kit.updateRequiresDesktopUpgrade && kit.installState === 'installed' && <section className="expert-detail-section update-changes">
        <strong>已安装版本 {kit.installed?.manifest.version} 仍可使用；市场新版本暂不可更新。</strong>
        <p>{versionRequirement(kit.minimumDesktopVersion)}，升级桌面端后可更新到 {kit.version}。</p>
      </section>}

      {!kit.installed && commands.length > 0 && <section className="expert-detail-section">
        <h3>快捷命令 <small>({commands.length})</small></h3>
        <div className="detail-command-list">
          {commands.map((command, index) => <button disabled={!onUse} key={`command:${command.id}`} onClick={() => onUse?.(command.id)} type="button"><code>{slashCommand(extensionCommandSlashLabel(command.id, index))}</code><span>{kitSkillById.get(command.skillId ?? command.id)?.summary || skillById.get(command.skillId ?? command.id)?.summary || '使用套件中的工作流程处理任务'}</span><ArrowRight size={15} /></button>)}
        </div>
      </section>}
      {!kit.installed && kit.skillIds.length > 0 && <section className="expert-detail-section">
        <h3>技能 <small>({kit.skillIds.length})</small></h3>
        <div className="detail-skill-list">{kit.skillIds.map((id) => {
          const bundledSkill = kitSkillById.get(id)
          const skill = bundledSkill ?? skillById.get(id)
          return <article key={id}><WandSparkles size={15} /><div><strong>{skill?.name ?? id}</strong><p>{bundledSkill?.argumentHint || skill?.summary || '随专家套件一起加载的工作方法'}</p></div></article>
        })}</div>
      </section>}
      {kit.installed && <ExtensionContentsPanel extension={kit.installed} onUseCommand={onUse} afterSkills={<CapabilitySections
        connectorRefs={kit.connectorRefs}
        connectorById={connectorById}
        knowledgeBaseRefs={kit.knowledgeBaseRefs}
        knowledgeByReference={knowledgeByReference}
        onConfigureConnectors={onConfigureConnectors}
        onConfigureKnowledge={onConfigureKnowledge}
        onToggleConnector={onToggleConnector}
      />} />}
      {!kit.installed && <CapabilitySections
        connectorRefs={kit.connectorRefs}
        connectorById={connectorById}
        knowledgeBaseRefs={kit.knowledgeBaseRefs}
        knowledgeByReference={knowledgeByReference}
        onConfigureConnectors={onConfigureConnectors}
        onConfigureKnowledge={onConfigureKnowledge}
        onToggleConnector={onToggleConnector}
      />}
      {!kit.installed && <ExtensionReadmeSection readme={catalogReadme} />}


  </ExtensionDetailLayout>
}

function slashCommand(name: string): string {
  return `/${name.replace(/^\/+/, '')}`
}

function ExtensionIcon({ installPath, name }: { installPath?: string; name: string }) {
  const [failed, setFailed] = useState(false)
  const source = installPath && isTauri() ? convertFileSrc(`${installPath}/assets/icon.svg`) : ''
  return <span className="extension-profile-icon">{source && !failed
    ? <img alt="" aria-hidden="true" onError={() => setFailed(true)} src={source} />
    : <Boxes aria-label={`${name}套件图标`} size={22} />}</span>
}

function CapabilitySections({ connectorRefs, connectorById, knowledgeBaseRefs, knowledgeByReference, onConfigureConnectors, onConfigureKnowledge, onToggleConnector }: {
  connectorRefs: string[]
  connectorById: Map<string, ConnectorRuntimeDefinition>
  knowledgeBaseRefs: string[]
  knowledgeByReference: Map<string, KnowledgeBaseEntry>
  onConfigureConnectors?: () => void
  onConfigureKnowledge?: () => void
  onToggleConnector?: (connector: ConnectorRuntimeDefinition, enabled: boolean) => void
}) {
  return <>
    {connectorRefs.length > 0 && <section className="expert-detail-section">
      <h3>数据连接 <small>({connectorRefs.length})</small></h3>
      <div className="extension-capability-list">{connectorRefs.map((id) => {
        const connector = connectorById.get(id)
        const enabled = connector?.enabled === true
        const ready = connector?.status === 'ready'
        const status = !connector ? '未安装' : !enabled ? '未启用' : ready ? '已启用 · 使用时检查' : connector.status === 'needs-configuration' ? '待配置' : '当前不可用'
        return <div className="extension-capability-row" key={id}>
          <span className={`extension-capability-status ${enabled && ready ? 'ready' : ''}`} />
          <div><strong>{connector?.name ?? id}</strong><small>{connector ? `${status}${connector.toolNames.length > 0 ? ` · ${connector.toolNames.length} 个工具` : ''}` : '套件所需连接器尚未安装'}</small></div>
          {connector && <button aria-label={`${enabled ? '关闭' : '启用'} ${connector.name}`} aria-checked={enabled} className="extension-capability-switch" disabled={!onToggleConnector} onClick={() => onToggleConnector?.(connector, !enabled)} role="switch" type="button"><span /></button>}
          {!connector && onConfigureConnectors && <button aria-label="配置连接器" className="extension-capability-open" onClick={onConfigureConnectors} type="button"><ChevronRight size={16} /></button>}
        </div>
      })}</div>
    </section>}
    {knowledgeBaseRefs.length > 0 && <section className="expert-detail-section">
      <h3>知识库 <small>({knowledgeBaseRefs.length})</small></h3>
      <div className="extension-capability-list">{knowledgeBaseRefs.map((reference) => {
        const knowledgeBase = knowledgeByReference.get(reference)
        return <button className="extension-capability-row extension-capability-link" disabled={!onConfigureKnowledge} key={reference} onClick={onConfigureKnowledge} type="button">
          <BookOpenCheck size={16} />
          <div><strong>{knowledgeBase?.name ?? reference}</strong><small>{knowledgeBase ? `${scopeLabel(knowledgeBase.scope)} · 可用于检索` : '不存在或无访问权限'}</small></div>
          <ChevronRight size={16} />
        </button>
      })}</div>
    </section>}
  </>
}

function scopeLabel(scope: KnowledgeBaseEntry['scope']) {
  return scope === 'PERSONAL' ? '个人知识库' : scope === 'TEAM' ? '团队知识库' : '组织知识库'
}
