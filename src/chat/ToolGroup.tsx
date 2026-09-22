import { ChevronRight, CircleAlert, FileCode2, FileInput, FolderSearch, Globe2, LoaderCircle, PlugZap, TerminalSquare, Users, Wrench } from 'lucide-react'
import { useState } from 'react'
import type { ToolSegment } from '../conversation/types'
import { formatDuration, toolCategory, toolDisplayLabel, toolGroupLabel, toolGroupStatus } from './toolSummary'

export function ToolGroup({ tools }: { tools: ToolSegment[] }) {
  if (tools.length < 2) return <div className="tool-group tool-group-list">{tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}</div>
  return <GroupedTools tools={tools} />
}

function GroupedTools({ tools }: { tools: ToolSegment[] }) {
  const attention = tools.some((tool) => tool.status === 'failed')
  const [choice, setChoice] = useState<{ attention: boolean; open: boolean }>()
  const open = choice?.attention === attention ? choice.open : attention
  const representative = tools.find((tool) => tool.status === 'running') ?? tools[0]!
  return <details className="tool-group tool-group-collapsible" open={open}>
    <summary className="tool-group-summary" onClick={(event) => { event.preventDefault(); setChoice({ attention, open: !open }) }} title={toolGroupStatus(tools)}>
      <ToolIcon tool={representative} />
      <span>{toolGroupLabel(tools).replaceAll(' · ', ' ')}</span>
      <ChevronRight className="tool-group-chevron" size={14} />
    </summary>
    <div className="tool-group-items">{tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}</div>
  </details>
}

function ToolCard({ tool }: { tool: ToolSegment }) {
  const continuedPlanning = tool.toolName === 'exit_plan_mode' && tool.status === 'failed'
    && /user chose to keep planning|继续规划/i.test(tool.detail ?? tool.output ?? '')
  const displayTool: ToolSegment = continuedPlanning ? { ...tool, status: 'completed', detail: undefined, output: undefined } : tool
  const routineRead = displayTool.status === 'completed' && ['local_files_roots', 'local_files_list', 'local_files_search']
    .includes(displayTool.toolName.replaceAll('.', '_'))
  const expandable = !routineRead && Boolean(displayTool.detail || displayTool.command || displayTool.output || displayTool.path || displayTool.secondaryPath)
  const attention = displayTool.status === 'running' || displayTool.status === 'failed'
  const [choice, setChoice] = useState<{ attention: boolean; open: boolean }>()
  const open = choice?.attention === attention ? choice.open : attention
  const elapsed = displayTool.completedAt && displayTool.startedAt ? duration(displayTool) : ''
  const summary = <>
    <ToolIcon tool={displayTool} />
    <span className="timeline-title">{toolDisplayLabel(displayTool)}</span>
    {displayTool.itemCount !== undefined && <small>{displayTool.itemCount} 项</small>}
    {elapsed && <small className="timeline-duration">{elapsed}</small>}
    <span className="timeline-status">
      {displayTool.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
      {displayTool.status === 'failed' && <CircleAlert size={14} />}
    </span>
    {expandable && <ChevronRight className="timeline-chevron" size={14} />}
  </>
  const className = `timeline-tool cat-${toolCategory(displayTool.toolName)} timeline-${displayTool.status}`
  if (!expandable) return <div className={className}>{summary}</div>
  return <details className={className} open={open}>
    <summary onClick={(event) => { event.preventDefault(); setChoice({ attention, open: !open }) }}>{summary}</summary>
    <div className="timeline-details">
      {displayTool.command && <code className="timeline-command">{displayTool.command}</code>}
      {displayTool.detail && <p>{displayTool.detail}</p>}
      {displayTool.path && <code className="timeline-path">{displayTool.path}</code>}
      {displayTool.secondaryPath && <code className="timeline-path">→ {displayTool.secondaryPath}</code>}
      {displayTool.output && <pre className="timeline-output">{displayTool.output}</pre>}
    </div>
  </details>
}

function duration(tool: ToolSegment): string {
  const elapsed = Date.parse(tool.completedAt ?? '') - Date.parse(tool.startedAt)
  if (!Number.isFinite(elapsed) || elapsed < 0) return ''
  const seconds = Math.floor(elapsed / 1_000)
  if (seconds === 0) return ''
  return formatDuration(seconds)
}

function ToolIcon({ tool }: { tool: ToolSegment }) {
  const name = tool.toolName
  if (name === 'bash' || name === 'pwsh' || name.startsWith('terminal_')) return <TerminalSquare size={17} />
  if (name.startsWith('mcp_')) return <PlugZap size={17} />
  if (name.startsWith('browser_') || name === 'web_search' || name === 'web_fetch') return <Globe2 size={17} />
  if (name.startsWith('subagent')) return <Users size={17} />
  if (name === 'glob' || name === 'grep' || name === 'read') return name === 'read' ? <FileInput size={17} /> : <FolderSearch size={17} />
  if (name.startsWith('local_files_') || name.startsWith('office_')) {
    if (name === 'local_files_list' || name === 'local_files_roots') return <FolderSearch size={17} />
    if (name === 'local_files_read_text' || name === 'office_document_read') return <FileInput size={17} />
    return <FileCode2 size={17} />
  }
  return <Wrench size={17} />
}
