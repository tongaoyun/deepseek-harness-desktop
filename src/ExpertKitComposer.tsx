import { Check, Plug, Wrench } from 'lucide-react'
import { desktopToolNames } from './expertKits'
import type { SkillView } from './skills'
import type { ConnectorCatalogEntry } from './types'

interface Props {
  skills: SkillView[]
  connectors: ConnectorCatalogEntry[]
  selectedSkillIds: string[]
  selectedConnectorIds: string[]
  selectedTools: string[]
  onSkillsChange: (ids: string[]) => void
  onConnectorsChange: (ids: string[]) => void
  onToolsChange: (tools: string[]) => void
}

export interface ComposerDependencies {
  connectorIds: string[]
  tools: string[]
}

export function deriveSkillDependencies(skills: SkillView[], selectedSkillIds: string[]): ComposerDependencies {
  const selected = new Set(selectedSkillIds)
  return {
    connectorIds: unique(skills.filter((skill) => selected.has(skill.id)).flatMap((skill) => skill.connectorRefs)),
    tools: unique(skills.filter((skill) => selected.has(skill.id)).flatMap((skill) => skill.requiredTools)),
  }
}

export function composerIssues(
  skills: SkillView[],
  connectors: ConnectorCatalogEntry[],
  selectedSkillIds: string[],
  selectedConnectorIds: string[],
  selectedTools: string[],
): string[] {
  const issues: string[] = []
  const skillById = new Map(skills.map((skill) => [skill.id, skill]))
  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]))
  const selectedConnectors = new Set(selectedConnectorIds)
  const selectedToolSet = new Set(selectedTools)
  for (const id of selectedSkillIds) {
    const skill = skillById.get(id)
    if (!skill?.installed) issues.push(`${skill?.name ?? id} 尚未安装到本机`)
  }
  for (const id of selectedConnectorIds) {
    const connector = connectorById.get(id)
    if (!connector) issues.push(`${id} 不在连接器目录中`)
    else if (connector.status !== 'ready') issues.push(`${connector.name} 当前未就绪`)
  }
  const dependencies = deriveSkillDependencies(skills, selectedSkillIds)
  for (const id of dependencies.connectorIds) {
    if (!selectedConnectors.has(id)) issues.push(`所选技能依赖连接器 ${id}`)
  }
  const providedTools = new Set(
    connectors.filter((connector) => selectedConnectors.has(connector.id)).flatMap((connector) => connector.toolNames),
  )
  for (const tool of dependencies.tools) {
    if (!selectedToolSet.has(tool)) issues.push(`所选技能依赖工具 ${tool}`)
    if (!desktopToolNames.has(tool) && !providedTools.has(tool)) issues.push(`${tool} 没有可用的连接器提供`)
  }
  return unique(issues)
}

export function ExpertKitComposer(props: Props) {
  const dependencies = deriveSkillDependencies(props.skills, props.selectedSkillIds)
  const issues = composerIssues(
    props.skills, props.connectors, props.selectedSkillIds,
    props.selectedConnectorIds, props.selectedTools,
  )
  const availableTools = unique([
    ...dependencies.tools,
    ...Array.from(desktopToolNames),
    ...props.connectors
      .filter((connector) => props.selectedConnectorIds.includes(connector.id))
      .flatMap((connector) => connector.toolNames),
  ])
  return <section className="expert-composer wide">
    <header><span><strong>可视化能力编排</strong><small>选择已安装的技能，依赖的连接器和工具会自动勾选。</small></span><em className={issues.length ? 'partial' : 'ready'}>{issues.length ? `${issues.length} 项待完善` : '依赖完整'}</em></header>
    <div className="expert-composer-group">
      <h4><Check size={13} />技能 <small>{props.selectedSkillIds.length} 个已选</small></h4>
      <div className="expert-composer-options">{props.skills.map((skill) => {
        const enabled = Boolean(skill.installed)
        const selected = props.selectedSkillIds.includes(skill.id)
        return <button className={selected ? 'selected' : ''} disabled={!enabled} key={skill.id} onClick={() => enabled && props.onSkillsChange(toggle(props.selectedSkillIds, skill.id))} type="button">
          <span><strong>{skill.name}</strong><small>{skill.id} · v{skill.installedVersion ?? skill.version}</small></span><em>{enabled ? selected ? '已选择' : '选择' : '需先安装'}</em>
        </button>
      })}{props.selectedSkillIds.filter((id) => !props.skills.some((skill) => skill.id === id)).map((id) => <button className="missing" key={id} onClick={() => props.onSkillsChange(toggle(props.selectedSkillIds, id))} type="button"><span><strong>{id}</strong><small>原套件引用的技能当前不在目录中</small></span><em>移除</em></button>)}</div>
      {props.skills.length === 0 && <p>暂无可编排的技能，请先在技能页面安装或创建。</p>}
    </div>
    <div className="expert-composer-group">
      <h4><Plug size={13} />连接器 <small>{props.selectedConnectorIds.length} 个已选</small></h4>
      <div className="expert-composer-chips">{props.connectors.map((connector) => {
        const selected = props.selectedConnectorIds.includes(connector.id)
        return <button className={selected ? 'selected' : ''} key={connector.id} onClick={() => props.onConnectorsChange(toggle(props.selectedConnectorIds, connector.id))} type="button">{connector.name}<small>{connector.status === 'ready' ? `${connector.toolNames.length} tools` : '当前未就绪'}</small></button>
      })}</div>
    </div>
    <div className="expert-composer-group">
      <h4><Wrench size={13} />工具 <small>{props.selectedTools.length} 个已选</small></h4>
      <div className="expert-composer-chips tools">{availableTools.map((tool) => <button className={props.selectedTools.includes(tool) ? 'selected' : ''} key={tool} onClick={() => props.onToolsChange(toggle(props.selectedTools, tool))} type="button">{tool}</button>)}</div>
    </div>
    {issues.length > 0 && <div className="expert-composer-issues">{issues.map((issue) => <span key={issue}>{issue}</span>)}</div>}
  </section>
}

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

function unique(values: string[]) {
  return [...new Set(values)]
}
