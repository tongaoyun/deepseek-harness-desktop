import {
  BookOpenCheck,
  Boxes,
  CalendarClock,
  CheckCircle2,
  Command,
  PlugZap,
  ShieldCheck,
  WandSparkles,
  Workflow,
  X,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { expertKitChanges, expertKitHasPermissionExpansion, expertKitPermissionDetails, permissionModeLabel } from './expertKitDetails'
import type { ExpertKitView } from './expertKits'
import type { ConnectorCatalogEntry, KnowledgeBaseEntry, SkillCatalogEntry } from './types'

interface ExpertKitDetailsModalProps {
  kit: ExpertKitView
  skills: SkillCatalogEntry[]
  connectors: ConnectorCatalogEntry[]
  knowledgeBases: KnowledgeBaseEntry[]
  installing: boolean
  selected: boolean
  onClose: () => void
  onInstall: () => void
  onSchedule: () => void
  onUse: () => void
}

export function ExpertKitDetailsModal({
  kit, skills, connectors, knowledgeBases, installing, selected, onClose, onInstall, onSchedule, onUse,
}: ExpertKitDetailsModalProps) {
  const skillById = new Map(skills.map((skill) => [skill.id, skill]))
  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const knowledgeByReference = new Map(knowledgeBases.map((knowledgeBase) => [knowledgeBase.reference, knowledgeBase]))
  const changes = expertKitChanges(kit)
  const stateLabel = kit.installState === 'installed' ? '已安装' : kit.installState === 'update' ? '更新确认' : '安装确认'
  const issues = [...kit.connectorIssues, ...kit.knowledgeIssues]

  return <div className="expert-modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose()
  }}>
    <section aria-labelledby="expert-kit-title" aria-modal="true" className="expert-kit-modal" role="dialog">
      <button aria-label="关闭" className="expert-modal-close" onClick={onClose} type="button"><X size={16} /></button>
      <div className="expert-modal-heading">
        <span><Boxes size={22} /></span>
        <div><small>{stateLabel} · v{kit.version}</small><h2 id="expert-kit-title">{kit.name}</h2><p>{kit.summary}</p></div>
      </div>

      <div className={`expert-dependency-state ${kit.readiness}`}>
        {kit.readiness === 'ready'
          ? <><CheckCircle2 size={15} /><span>当前员工所需的连接器、工具和知识库均已就绪</span></>
          : <><PlugZap size={15} /><span>安装后部分能力暂不可用：{issues.join('；')}</span></>}
      </div>

      {kit.installState === 'update' && <section className="expert-detail-section update-changes">
        <h3>从 v{kit.installedVersion} 更新的变化</h3>
        {expertKitHasPermissionExpansion(kit) && <strong>本次更新扩大了权限范围，请重点确认。</strong>}
        <ul>{changes.map((change) => <li key={change}>{change}</li>)}</ul>
      </section>}

      <section className="expert-detail-section">
        <h3><ShieldCheck size={15} /> 权限声明</h3>
        <div className="expert-permission-grid">{expertKitPermissionDetails(kit).map((permission) => <div key={permission.key}>
          <span><strong>{permission.label}</strong><small>{permission.description}</small></span>
          <em className={permission.mode}>{permissionModeLabel(permission.mode)}</em>
        </div>)}</div>
      </section>

      <section className="expert-detail-section">
        <h3>套件内容</h3>
        <div className="expert-content-groups">
          <DetailGroup icon={<Command size={14} />} title={`命令 ${kit.commandIds.length}`} values={kit.commandIds} empty="未声明快捷命令" />
          <DetailGroup icon={<WandSparkles size={14} />} title={`技能 ${kit.skillIds.length}`} values={kit.skillIds.map((id) => skillById.get(id)?.name ?? id)} empty="未声明技能" />
          <DetailGroup icon={<PlugZap size={14} />} title={`连接器 ${kit.connectorRefs.length}`} values={kit.connectorRefs.map((id) => connectorById.get(id)?.name ?? id)} empty="不使用连接器" />
          <DetailGroup icon={<BookOpenCheck size={14} />} title={`知识库 ${kit.knowledgeBaseRefs.length}`} values={kit.knowledgeBaseRefs.map((reference) => knowledgeByReference.get(reference)?.name ?? reference)} empty="不绑定知识库" />
          <DetailGroup icon={<Workflow size={14} />} title={`后台工作流 ${kit.serverWorkflows.length}`} values={kit.serverWorkflows.map((workflow) => workflow.name)} empty="不包含后台工作流" />
        </div>
      </section>

      <div className="expert-modal-actions">
        <button className="secondary" onClick={onClose} type="button">关闭</button>
        {kit.installState === 'installed' ? <>
          {kit.serverWorkflows.length > 0 && <button className="secondary" onClick={onSchedule} type="button"><CalendarClock size={14} /> 创建定时任务</button>}
          <button onClick={onUse} type="button">{selected ? '正在使用' : '立即使用'}</button>
        </> : <button disabled={installing || !kit.sha256} onClick={onInstall} type="button">
          {installing ? '正在校验并安装…' : kit.installState === 'update' ? '确认更新' : '确认安装'}
        </button>}
      </div>
    </section>
  </div>
}

function DetailGroup({ icon, title, values, empty }: { icon: ReactNode; title: string; values: string[]; empty: string }) {
  return <div><h4>{icon}{title}</h4><p>{values.length > 0 ? values.join(' · ') : empty}</p></div>
}
