import {
  ChevronRight, CircleAlert, FileCode2, FileInput, FolderSearch, Globe2,
  LoaderCircle, MessageSquareText, PlugZap, ShieldCheck, TerminalSquare, Users, Wrench,
} from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TaskTimelineEntry } from './types'
import { groupExecutionEntries, executionGroupLabel, executionGroupStatus } from './executionGroups'

export type ApprovalDecisionHandler = (approvalId: string, decision: 'allow' | 'reject') => void | Promise<void>
export interface ApprovalUiState { status: 'sending' | 'sent' | 'error'; error?: string }
interface Props {
  entries: TaskTimelineEntry[]
  finalResponse?: string
  onApprovalDecision?: ApprovalDecisionHandler
  approvalStates?: Record<string, ApprovalUiState>
  approvalsEnabled?: boolean
}

export const ExecutionTimeline = memo(function ExecutionTimeline({ entries, finalResponse = '', onApprovalDecision, approvalStates, approvalsEnabled = true }: Props) {
  const visible = visibleExecutionEntries(entries, finalResponse)
  if (visible.length === 0) return null
  return <div aria-label="执行过程" className="execution-timeline">
    {groupExecutionEntries(visible).map((group) => group.kind === 'message'
      ? <TimelineCommentary key={group.id} text={group.entries[0].text ?? ''} />
      : group.kind === 'notice'
        ? <ActivityEntry entry={group.entries[0]} key={group.id} onApprovalDecision={onApprovalDecision} approvalState={approvalStates?.[group.entries[0].approvalId ?? '']} approvalsEnabled={approvalsEnabled} />
        : <StableDetails className="execution-step-group" key={group.id} attention={group.entries.some((entry) => entry.status === 'failed')} summary={<><ChevronRight size={14} /><span title={executionGroupStatus(group.entries)}>{executionGroupLabel(group.entries)}</span>{group.entries.some((entry) => entry.status === 'running') && <LoaderCircle className="turn-spinner" size={13} />}</>}><div><small className="execution-group-count">{executionGroupStatus(group.entries)}</small>{group.entries.map((entry) => <ActivityEntry entry={entry} key={entry.id} />)}</div></StableDetails>)}
  </div>
})

const TimelineCommentary = memo(function TimelineCommentary({ text }: { text: string }) {
  return <div className="timeline-commentary message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
})

const ActivityEntry = memo(function ActivityEntry({ entry, onApprovalDecision, approvalState, approvalsEnabled = true }: {
  entry: TaskTimelineEntry
  onApprovalDecision?: ApprovalDecisionHandler
  approvalState?: ApprovalUiState
  approvalsEnabled?: boolean
}) {
  const expandable = Boolean(entry.text || entry.detail || entry.output || entry.path || entry.secondaryPath || entry.toolName || entry.approvalId)
  const summary = <>
    <ActivityIcon entry={entry} />
    <span className="timeline-title">{activityTitle(entry)}</span>
    {entry.itemCount !== undefined && <small>{entry.itemCount} 项</small>}
    {entry.completedAt && <small className="timeline-duration">{executionDuration(entry)}</small>}
    <span className="timeline-status">
      {entry.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
      {entry.status === 'failed' && <CircleAlert size={14} />}
    </span>
    {expandable && <ChevronRight className="timeline-chevron" size={14} />}
  </>
  if (!expandable) return <div className={`timeline-tool timeline-tool-row timeline-${entry.kind} ${entry.status}`}>{summary}</div>
  const details = <StableDetails className={`timeline-tool timeline-${entry.kind} ${entry.status}`} attention={entry.status === 'failed' || entry.kind === 'warning' || entry.kind === 'error' || (entry.kind === 'approval' && entry.status === 'running')} summary={summary}>
    <div className="timeline-details">
      {entry.kind === 'command' && entry.text && <code className="timeline-command">{entry.text}</code>}
      {entry.kind !== 'command' && entry.text && entry.text !== entry.detail && <p>{entry.text}</p>}
      {entry.detail && <p>{entry.detail}</p>}
      {entry.path && <code className="timeline-path">{entry.path}</code>}
      {entry.secondaryPath && <code className="timeline-path">→ {entry.secondaryPath}</code>}
      {entry.output && <pre className="timeline-output">{entry.output}</pre>}
      {!entry.detail && !entry.path && !entry.secondaryPath && entry.kind !== 'command' && entry.toolName && <code className="timeline-tool-name">{entry.toolName}</code>}
    </div>
  </StableDetails>
  if (entry.kind !== 'approval' || entry.status !== 'running' || !entry.approvalId || !onApprovalDecision) return details
  const submitting = approvalState?.status === 'sending' || approvalState?.status === 'sent'
  return <div className="timeline-approval">{details}
    <div className="timeline-approval-actions">
      <button className="reject" disabled={!approvalsEnabled || submitting} onClick={() => void onApprovalDecision(entry.approvalId!, 'reject')} type="button">拒绝</button>
      <button disabled={!approvalsEnabled || submitting} onClick={() => void onApprovalDecision(entry.approvalId!, 'allow')} type="button">允许本次操作</button>
    </div>
    {!approvalsEnabled && <p className="approval-feedback" role="status">本轮已停止或结束，不能再确认此操作。</p>}
    {approvalsEnabled && submitting && <p className="approval-feedback" role="status">{approvalState.status === 'sending' ? '正在提交确认…' : '确认已发送，等待执行结果。'}</p>}
    {approvalsEnabled && approvalState?.status === 'error' && <p className="approval-feedback error" role="alert">{approvalState.error}</p>}
  </div>
})

/** Tool results update the summary, never toggle the reader's disclosure choice. */
function StableDetails({ attention, className, summary, children }: { attention: boolean; className: string; summary: ReactNode; children: ReactNode }) {
  const [choice, setChoice] = useState<{ attention: boolean; open: boolean }>()
  const open = choice?.attention === attention ? choice.open : attention
  return <details className={className} open={open}><summary onClick={(event) => {
    event.preventDefault()
    setChoice({ attention, open: !open })
  }}>{summary}</summary>{children}</details>
}

function executionDuration(entry: TaskTimelineEntry): string {
  const elapsed = Date.parse(entry.completedAt ?? '') - Date.parse(entry.occurredAt)
  if (!Number.isFinite(elapsed) || elapsed < 0) return ''
  const seconds = Math.floor(elapsed / 1_000)
  return seconds < 60 ? `${seconds}秒` : `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

function activityTitle(entry: TaskTimelineEntry): string {
  if (entry.status === 'canceled') return `${entry.label} · 已停止`
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
  if (tool === 'local_files_publish') return `已准备交付${target || '文件'}`
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

export function visibleExecutionEntries(entries: TaskTimelineEntry[], finalResponse: string): TaskTimelineEntry[] {
  const answer = finalResponse.trim()
  if (!answer) return entries
  const lastMatchingIndex = entries.findLastIndex((entry) => entry.kind === 'assistant' && entry.text?.trim() === answer)
  return lastMatchingIndex < 0 ? entries : entries.filter((_entry, index) => index !== lastMatchingIndex)
}
