import { ChevronRight, CircleAlert, FileCode2, FileInput, FolderSearch, Globe2, LoaderCircle, PlugZap, TerminalSquare, Users, Wrench } from 'lucide-react'
import { useState } from 'react'
import type { ToolSegment } from '../conversation/types'
import { toolCategory } from './toolSummary'

export function ToolGroup({ tools }: { tools: ToolSegment[] }) {
  return <div className="tool-group">{tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}</div>
}

function ToolCard({ tool }: { tool: ToolSegment }) {
  const expandable = Boolean(tool.detail || tool.command || tool.output || tool.path || tool.secondaryPath)
  const attention = tool.status === 'running' || tool.status === 'failed'
  const [choice, setChoice] = useState<{ attention: boolean; open: boolean }>()
  const open = choice?.attention === attention ? choice.open : attention
  const elapsed = tool.completedAt && tool.startedAt ? duration(tool) : ''
  const summary = <>
    <ToolIcon tool={tool} />
    <span className="timeline-title">{tool.label}</span>
    {tool.itemCount !== undefined && <small>{tool.itemCount} 项</small>}
    {elapsed && <small className="timeline-duration">{elapsed}</small>}
    <span className="timeline-status">
      {tool.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
      {tool.status === 'failed' && <CircleAlert size={14} />}
    </span>
    {expandable && <ChevronRight className="timeline-chevron" size={14} />}
  </>
  const className = `timeline-tool cat-${toolCategory(tool.toolName)} timeline-${tool.status}`
  if (!expandable) return <div className={className}>{summary}</div>
  return <details className={className} open={open}>
    <summary onClick={(event) => { event.preventDefault(); setChoice({ attention, open: !open }) }}>{summary}</summary>
    <div className="timeline-details">
      {tool.command && <code className="timeline-command">{tool.command}</code>}
      {tool.detail && <p>{tool.detail}</p>}
      {tool.path && <code className="timeline-path">{tool.path}</code>}
      {tool.secondaryPath && <code className="timeline-path">→ {tool.secondaryPath}</code>}
      {tool.output && <pre className="timeline-output">{tool.output}</pre>}
    </div>
  </details>
}

function duration(tool: ToolSegment): string {
  const elapsed = Date.parse(tool.completedAt ?? '') - Date.parse(tool.startedAt)
  if (!Number.isFinite(elapsed) || elapsed < 0) return ''
  const seconds = Math.floor(elapsed / 1_000)
  if (seconds === 0) return ''
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

function ToolIcon({ tool }: { tool: ToolSegment }) {
  const name = tool.toolName
  if (name === 'bash' || name === 'pwsh' || name.startsWith('terminal_')) return <TerminalSquare size={17} />
  if (name.startsWith('mcp_')) return <PlugZap size={17} />
  if (name.startsWith('browser_') || name === 'web_search' || name === 'web_fetch') return <Globe2 size={17} />
  if (name.startsWith('subagent')) return <Users size={17} />
  if (name.startsWith('local_files_') || name.startsWith('office_')) {
    if (name === 'local_files_list' || name === 'local_files_roots') return <FolderSearch size={17} />
    if (name === 'local_files_read_text' || name === 'office_document_read') return <FileInput size={17} />
    return <FileCode2 size={17} />
  }
  return <Wrench size={17} />
}
