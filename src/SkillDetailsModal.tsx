import { BookOpenCheck, CheckCircle2, PlugZap, ShieldCheck, Trash2, WandSparkles, X } from 'lucide-react'
import { expertKitPermissionDetails, permissionModeLabel } from './expertKitDetails'
import { skillPermissionExpansion, type SkillView } from './skills'
import type { ConnectorCatalogEntry, KnowledgeBaseEntry } from './types'

interface SkillDetailsModalProps {
  skill: SkillView
  connectors: ConnectorCatalogEntry[]
  knowledgeBases: KnowledgeBaseEntry[]
  installing: boolean
  removing: boolean
  selected: boolean
  onClose: () => void
  onInstall: () => void
  onRemove?: () => void
  onUse: () => void
}

export function SkillDetailsModal({
  skill, connectors, knowledgeBases, installing, removing, selected, onClose, onInstall, onRemove, onUse,
}: SkillDetailsModalProps) {
  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeByReference = new Map(knowledgeBases.map((entry) => [entry.reference, entry]))
  const issues = [...skill.connectorIssues, ...skill.knowledgeIssues]
  const state = skill.installState === 'retired' ? '已下架' : skill.installState === 'installed' ? '已安装' : skill.installState === 'update' ? '更新确认' : '安装确认'
  return <div className="expert-modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section aria-labelledby="skill-title" aria-modal="true" className="expert-kit-modal" role="dialog">
      <button aria-label="关闭" className="expert-modal-close" onClick={onClose} type="button"><X size={16} /></button>
      <div className="expert-modal-heading">
        <span><WandSparkles size={22} /></span>
        <div><small>{state} · 独立 Skill · v{skill.version}</small><h2 id="skill-title">{skill.name}</h2><p>{skill.summary}</p></div>
      </div>
      <div className={`expert-dependency-state ${skill.readiness}`}>
        {skill.readiness === 'ready'
          ? <><CheckCircle2 size={15} /><span>当前员工所需的连接器、工具和知识库均已就绪</span></>
          : <><PlugZap size={15} /><span>安装后部分能力暂不可用：{issues.join('；')}</span></>}
      </div>
      {skill.installState === 'update' && <section className="expert-detail-section update-changes">
        <h3>从 v{skill.installedVersion} 更新</h3>
        {skillPermissionExpansion(skill) && <strong>本次更新扩大了权限范围，请重点确认。</strong>}
        <p>独立 Skill 制品内容或触发场景已更新，安装后对新会话生效。</p>
      </section>}
      {skill.installState === 'retired' && <section className="expert-detail-section update-changes">
        <strong>该 Skill 已从公司目录下架，桌面端和 IM 均不会再加载或执行它。</strong>
        <p>本地文件仅用于显示状态，可安全卸载；历史任务记录不会删除。</p>
      </section>}
      <section className="expert-detail-section">
        <h3><ShieldCheck size={15} /> 权限声明</h3>
        <div className="expert-permission-grid">{expertKitPermissionDetails(skill).map((permission) => <div key={permission.key}>
          <span><strong>{permission.label}</strong><small>{permission.description}</small></span>
          <em className={permission.mode}>{permissionModeLabel(permission.mode)}</em>
        </div>)}</div>
      </section>
      <section className="expert-detail-section">
        <h3>触发场景</h3>
        <div className="connector-tools">{skill.triggers.join(' · ')}</div>
      </section>
      <section className="expert-detail-section">
        <h3>依赖能力</h3>
        <div className="expert-content-groups">
          <div><h4><PlugZap size={14} />连接器 {skill.connectorRefs.length}</h4><p>{skill.connectorRefs.map((id) => connectorById.get(id)?.name ?? id).join(' · ') || '不使用连接器'}</p></div>
          <div><h4><BookOpenCheck size={14} />知识库 {skill.knowledgeBaseRefs.length}</h4><p>{skill.knowledgeBaseRefs.map((id) => knowledgeByReference.get(id)?.name ?? id).join(' · ') || '不绑定知识库'}</p></div>
          <div><h4><WandSparkles size={14} />工具 {skill.requiredTools.length}</h4><p>{skill.requiredTools.join(' · ') || '不声明额外工具'}</p></div>
        </div>
      </section>
      <div className="expert-modal-actions">
        {onRemove && <button className="danger" disabled={removing} onClick={onRemove} type="button"><Trash2 size={14} />{removing ? '正在卸载…' : '卸载 Skill'}</button>}
        <button className="secondary" onClick={onClose} type="button">关闭</button>
        {skill.installState === 'retired' ? null : skill.installState === 'installed'
          ? <button onClick={onUse} type="button">{selected ? '正在使用' : '立即使用'}</button>
          : <button disabled={installing || !skill.sha256} onClick={onInstall} type="button">
            {installing ? '正在校验并安装…' : skill.installState === 'update' ? '确认更新' : '确认安装'}
          </button>}
      </div>
    </section>
  </div>
}
