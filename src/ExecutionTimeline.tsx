import { CheckCircle2, ChevronRight, CircleAlert, LoaderCircle, ShieldCheck, TerminalSquare } from 'lucide-react'
import type { TaskTimelineEntry } from './types'

interface Props {
  entries: TaskTimelineEntry[]
  finalResponse?: string
}

export function ExecutionTimeline({ entries, finalResponse = '' }: Props) {
  const visible = withoutDuplicatedFinal(entries, finalResponse)
  if (visible.length === 0) return null
  return <div aria-label="执行时间线" className="execution-timeline">
    {visible.map((entry) => entry.kind === 'assistant'
      ? <p className="timeline-commentary" key={entry.id}>{entry.text}</p>
      : <details className={`timeline-tool ${entry.status}`} key={entry.id}>
        <summary>
          {entry.kind === 'approval' ? <ShieldCheck size={15} /> : <TerminalSquare size={15} />}
          <span>{entry.label}</span>
          {entry.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
          {entry.status === 'completed' && <CheckCircle2 size={14} />}
          {entry.status === 'failed' && <CircleAlert size={14} />}
          <ChevronRight className="timeline-chevron" size={14} />
        </summary>
        {entry.toolName && <code>{entry.toolName}</code>}
      </details>) }
  </div>
}

function withoutDuplicatedFinal(entries: TaskTimelineEntry[], finalResponse: string): TaskTimelineEntry[] {
  const answer = finalResponse.trim()
  if (!answer) return entries
  const lastMatchingIndex = entries.findLastIndex((entry) => entry.kind === 'assistant' && entry.text?.trim() === answer)
  return lastMatchingIndex < 0 ? entries : entries.filter((_entry, index) => index !== lastMatchingIndex)
}
