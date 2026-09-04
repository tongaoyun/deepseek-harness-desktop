import {
  Check, ChevronRight, CircleAlert, FileCode2, FileInput, FolderSearch, Globe2,
  LoaderCircle, MessageSquareText, PlugZap, ShieldCheck, TerminalSquare, Users, Wrench,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TaskTimelineEntry } from './types'

interface Props {
  entries: TaskTimelineEntry[]
  finalResponse?: string
}

export function ExecutionTimeline({ entries, finalResponse = '' }: Props) {
  const visible = withoutDuplicatedFinal(entries, finalResponse)
  if (visible.length === 0) return null
  return <div aria-label="执行过程" className="execution-timeline">
    {visible.map((entry) => entry.kind === 'assistant'
      ? <div className="timeline-commentary message-markdown" key={entry.id}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text ?? ''}</ReactMarkdown>
      </div>
      : <ActivityEntry entry={entry} key={entry.id} />)}
  </div>
}

function ActivityEntry({ entry }: { entry: TaskTimelineEntry }) {
  const expandable = Boolean(entry.text || entry.detail || entry.output || entry.path || entry.secondaryPath || entry.toolName)
  return <details className={`timeline-tool timeline-${entry.kind} ${entry.status}`} open={entry.status === 'running' && expandable}>
    <summary>
      <ActivityIcon entry={entry} />
      <span>{entry.label}</span>
      {entry.itemCount !== undefined && <small>{entry.itemCount} 项</small>}
      <span className="timeline-status">
        {entry.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
        {entry.status === 'completed' && <Check size={14} />}
        {entry.status === 'failed' && <CircleAlert size={14} />}
      </span>
      {expandable && <ChevronRight className="timeline-chevron" size={14} />}
    </summary>
    {expandable && <div className="timeline-details">
      {entry.kind === 'command' && entry.text && <code className="timeline-command">{entry.text}</code>}
      {entry.detail && <p>{entry.detail}</p>}
      {entry.path && <code className="timeline-path">{entry.path}</code>}
      {entry.secondaryPath && <code className="timeline-path">→ {entry.secondaryPath}</code>}
      {entry.output && <pre className="timeline-output">{entry.output}</pre>}
      {!entry.detail && !entry.path && !entry.secondaryPath && entry.kind !== 'command' && entry.toolName && <code className="timeline-tool-name">{entry.toolName}</code>}
    </div>}
  </details>
}

function ActivityIcon({ entry }: { entry: TaskTimelineEntry }) {
  if (entry.kind === 'command') return <TerminalSquare size={16} />
  if (entry.kind === 'connector') return <PlugZap size={16} />
  if (entry.kind === 'browser') return <Globe2 size={16} />
  if (entry.kind === 'subagent') return <Users size={16} />
  if (entry.kind === 'approval') return <ShieldCheck size={16} />
  if (entry.kind === 'error' || entry.kind === 'warning') return <CircleAlert size={16} />
  if (entry.kind === 'file') {
    if (entry.toolName === 'local_files_list' || entry.toolName === 'local_files_roots') return <FolderSearch size={16} />
    if (entry.toolName === 'local_files_read_text' || entry.toolName === 'office_document_read') return <FileInput size={16} />
    return <FileCode2 size={16} />
  }
  if (entry.kind === 'tool') return <Wrench size={16} />
  return <MessageSquareText size={16} />
}

function withoutDuplicatedFinal(entries: TaskTimelineEntry[], finalResponse: string): TaskTimelineEntry[] {
  const answer = finalResponse.trim()
  if (!answer) return entries
  const lastMatchingIndex = entries.findLastIndex((entry) => entry.kind === 'assistant' && entry.text?.trim() === answer)
  return lastMatchingIndex < 0 ? entries : entries.filter((_entry, index) => index !== lastMatchingIndex)
}
