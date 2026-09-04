import {
  ChevronRight, CircleAlert, FileCode2, FileInput, FolderSearch, Globe2,
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
  const summary = <>
    <ActivityIcon entry={entry} />
    <span className="timeline-title">{activityTitle(entry)}</span>
    {entry.itemCount !== undefined && <small>{entry.itemCount} 项</small>}
    <span className="timeline-status">
      {entry.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
      {entry.status === 'failed' && <CircleAlert size={14} />}
    </span>
    {expandable && <ChevronRight className="timeline-chevron" size={14} />}
  </>
  if (!expandable) return <div className={`timeline-tool timeline-tool-row timeline-${entry.kind} ${entry.status}`}>{summary}</div>
  return <details className={`timeline-tool timeline-${entry.kind} ${entry.status}`} open={entry.status === 'running'}>
    <summary>{summary}</summary>
    <div className="timeline-details">
      {entry.kind === 'command' && entry.text && <code className="timeline-command">{entry.text}</code>}
      {entry.detail && <p>{entry.detail}</p>}
      {entry.path && <code className="timeline-path">{entry.path}</code>}
      {entry.secondaryPath && <code className="timeline-path">→ {entry.secondaryPath}</code>}
      {entry.output && <pre className="timeline-output">{entry.output}</pre>}
      {!entry.detail && !entry.path && !entry.secondaryPath && entry.kind !== 'command' && entry.toolName && <code className="timeline-tool-name">{entry.toolName}</code>}
    </div>
  </details>
}

function activityTitle(entry: TaskTimelineEntry): string {
  if (entry.kind === 'command') return entry.status === 'running' ? '正在运行命令' : entry.status === 'failed' ? '命令运行失败' : '运行了命令'
  if (entry.kind === 'subagent') return `${entry.label}${entry.status === 'running' ? '开始工作' : entry.status === 'failed' ? '未完成' : '已完成'}`
  if (entry.kind === 'file') return fileActivityTitle(entry)
  if (entry.kind === 'connector') return `${entry.status === 'running' ? '正在' : entry.status === 'failed' ? '未能' : '已'}${entry.label}`
  if (entry.kind === 'browser') return `${entry.status === 'running' ? '正在' : entry.status === 'failed' ? '未能' : '已'}${entry.label}`
  return entry.label
}

function fileActivityTitle(entry: TaskTimelineEntry): string {
  const path = entry.path ?? entry.secondaryPath
  const target = path ? ` ${path}` : ''
  const tool = entry.toolName ?? ''
  if (entry.status === 'failed') return `${entry.label}失败`
  if (entry.status === 'running') return entry.label
  if (tool === 'local_files_read_text' || tool === 'office_document_read' || tool === 'office.document.read') return `已读取${target || '文件'}`
  if (tool === 'local_files_list' || tool === 'local_files_roots') return `已查看${target || '目录'}`
  if (tool === 'local_files_search') return `已搜索${target || '文件'}`
  if (tool === 'local_files_write_text' || tool === 'office_xlsx_update_cells') return `已编辑${target || '文件'}`
  if (tool === 'local_files_delete') return `已删除${target || '文件'}`
  if (tool === 'local_files_move') return `已移动${target || '文件'}`
  if (tool === 'local_files_copy') return `已复制${target || '文件'}`
  if (tool === 'local_files_create_directory') return `已创建${target || '目录'}`
  if (tool.includes('create')) return `已生成${target || '文件'}`
  return entry.label
}

function ActivityIcon({ entry }: { entry: TaskTimelineEntry }) {
  if (entry.kind === 'command') return <TerminalSquare size={17} />
  if (entry.kind === 'connector') return <PlugZap size={17} />
  if (entry.kind === 'browser') return <Globe2 size={17} />
  if (entry.kind === 'subagent') return <Users size={17} />
  if (entry.kind === 'approval') return <ShieldCheck size={17} />
  if (entry.kind === 'error' || entry.kind === 'warning') return <CircleAlert size={17} />
  if (entry.kind === 'file') {
    if (entry.toolName === 'local_files_list' || entry.toolName === 'local_files_roots') return <FolderSearch size={17} />
    if (entry.toolName === 'local_files_read_text' || entry.toolName === 'office_document_read') return <FileInput size={17} />
    return <FileCode2 size={17} />
  }
  if (entry.kind === 'tool') return <Wrench size={17} />
  return <MessageSquareText size={17} />
}

function withoutDuplicatedFinal(entries: TaskTimelineEntry[], finalResponse: string): TaskTimelineEntry[] {
  const answer = finalResponse.trim()
  if (!answer) return entries
  const lastMatchingIndex = entries.findLastIndex((entry) => entry.kind === 'assistant' && entry.text?.trim() === answer)
  return lastMatchingIndex < 0 ? entries : entries.filter((_entry, index) => index !== lastMatchingIndex)
}
