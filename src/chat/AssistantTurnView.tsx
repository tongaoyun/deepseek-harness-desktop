import { Check, ChevronRight, CircleAlert, CircleHelp, ListChecks, ListCollapse, LoaderCircle, Square, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AssistantTurn, TurnSegment } from '../conversation/types'
import { RichMessage } from '../RichMessage'
import type { XiaoyinTaskProjection } from '../types'
import type { ApprovalDecisionHandler } from './ApprovalCard'
import { ApprovalCard } from './ApprovalCard'
import type { QuestionAnswerHandler } from './QuestionCard'
import { QuestionCard } from './QuestionCard'
import { ToolGroup } from './ToolGroup'
import { groupToolSegments, turnDurationLabel } from './toolSummary'

/**
 * One assistant turn, in event order: streamed text stays where it was written
 * and tool cards append below it, never replacing it.
 */
export function AssistantTurnView({ turn, runState, elapsedStartedAt, onApprovalDecision, onQuestionAnswer }: {
  turn: AssistantTurn
  runState?: XiaoyinTaskProjection
  elapsedStartedAt?: string
  onApprovalDecision?: ApprovalDecisionHandler
  onQuestionAnswer?: QuestionAnswerHandler
}) {
  const streaming = turn.status === 'streaming'
  const approvalsEnabled = streaming && runState?.activity !== '正在停止'
  const visibleSegments = turn.segments.filter((segment) => segment.kind !== 'thinking' && !isInternalToolSegment(segment))
  const activitySegments = visibleSegments.filter(isActivitySegment)
  const responseSegments = visibleSegments.filter((segment) => !isActivitySegment(segment))
  const groups = groupToolSegments(responseSegments)
  return <div className={`assistant-turn-body ${turn.status}`}>
    {(streaming || activitySegments.length > 0) && <TurnActivity
      approvalsEnabled={approvalsEnabled} completedAt={turn.meta.completedAt} onApprovalDecision={onApprovalDecision}
      onQuestionAnswer={onQuestionAnswer} runState={runState} segments={activitySegments}
      startedAt={elapsedStartedAt ?? turn.meta.startedAt} status={turn.status}
      waitingForFirstOutput={streaming && visibleSegments.length === 0 && runState?.executionStarted !== true}
    />}
    {groups.map((group, index) => group.kind === 'tools'
      ? <ToolGroup key={`tools:${group.tools[0]!.id}`} tools={group.tools} />
      : <SegmentView key={`${group.segment.kind}:${group.segment.id}:${index}`} segment={group.segment} streaming={streaming} approvalsEnabled={approvalsEnabled} onApprovalDecision={onApprovalDecision} onQuestionAnswer={onQuestionAnswer} />)}
    {turn.status === 'failed' && turn.meta.failure && <p className="turn-failure" role="alert">{turn.meta.failure.message}</p>}
    {!streaming && visibleSegments.length > 0 && visibleSegments.every((segment) => segment.kind === 'tool')
      && <p className="turn-silent">本轮没有文字说明，结果见上方操作与文件变更。</p>}
  </div>
}

function isActivitySegment(segment: TurnSegment): boolean {
  return segment.kind === 'tool' || segment.kind === 'commentary' || segment.kind === 'status'
    || segment.kind === 'approval' || segment.kind === 'question'
}

function isInternalToolSegment(segment: TurnSegment): boolean {
  if (segment.kind !== 'tool') return false
  if (['tool_discover', 'task_report', 'ask_user_question', 'exit_plan_mode'].includes(segment.toolName)) return true
  return segment.status === 'failed' && /Plan mode blocks mutating or unclassified tool/i.test(segment.detail ?? segment.output ?? '')
}

function SegmentView({ segment, streaming, approvalsEnabled, onApprovalDecision, onQuestionAnswer }: {
  segment: TurnSegment
  streaming: boolean
  approvalsEnabled: boolean
  onApprovalDecision?: ApprovalDecisionHandler
  onQuestionAnswer?: QuestionAnswerHandler
}) {
  if (segment.kind === 'text') return <div className={streaming && segment.streaming ? 'streaming-response' : undefined}><RichMessage text={segment.text} /></div>
  if (segment.kind === 'commentary') return <div className={`turn-commentary${streaming && segment.streaming ? ' streaming-response' : ''}`}><RichMessage text={segment.text} /></div>
  if (segment.kind === 'status') {
    const elapsed = turnDurationLabel(segment.startedAt, segment.completedAt)
    return <div className={`turn-event turn-event-${segment.status}`} role="status">
      {segment.status === 'running' ? <LoaderCircle className="turn-spinner" size={14} /> : <ListCollapse size={14} />}
      <span>{segment.label}</span>
      {elapsed && <small>{elapsed}</small>}
    </div>
  }
  if (segment.kind === 'notice') return <p className={`turn-notice ${segment.level}`} role="status">{segment.text}</p>
  if (segment.kind === 'user') return <article className="conversation-turn user-turn steer-turn">
    <div className="user-prompt"><span className="steer-badge"><Sparkles size={12} />已插入当前任务</span><RichMessage text={segment.text} /></div>
  </article>
  if (segment.kind === 'approval') return <ApprovalCard segment={segment} enabled={approvalsEnabled} onDecision={onApprovalDecision} />
  if (segment.kind === 'question') {
    const waiting = segment.status === 'running' && approvalsEnabled
    const planReview = segment.questions.some((question) => question.intent?.kind === 'plan-review' || question.id === 'plan-review')
    return <>{waiting && <div className="question-activity-status" aria-hidden="true">
      <div className="turn-event"><CircleHelp size={15} /><span>{planReview ? '正在确认计划' : '正在询问问题'}</span></div>
      <div className="turn-event"><ListChecks size={15} /><span>{planReview ? '正在等待你确认' : '正在等待你的回答'}</span></div>
    </div>}<QuestionCard segment={segment} enabled={approvalsEnabled} onAnswer={onQuestionAnswer} /></>
  }
  return null
}

/** Codex-style activity disclosure: live work stays visible, completed work folds behind duration. */
function TurnActivity({ runState, startedAt, completedAt, status, waitingForFirstOutput, segments, approvalsEnabled, onApprovalDecision, onQuestionAnswer }: {
  runState?: XiaoyinTaskProjection
  startedAt?: string
  completedAt?: string
  status: AssistantTurn['status']
  waitingForFirstOutput: boolean
  segments: TurnSegment[]
  approvalsEnabled: boolean
  onApprovalDecision?: ApprovalDecisionHandler
  onQuestionAnswer?: QuestionAnswerHandler
}) {
  const [clock, setClock] = useState(Date.now())
  const [choice, setChoice] = useState<{ attention: boolean; open: boolean }>()
  useEffect(() => {
    if (status !== 'streaming') return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [status])
  const streaming = status === 'streaming'
  const startedAtMs = Date.parse(startedAt ?? '')
  const slowFirstOutput = streaming && waitingForFirstOutput && Number.isFinite(startedAtMs) && clock - startedAtMs >= 10_000
  const duration = turnDurationLabel(startedAt, streaming ? new Date(clock).toISOString() : completedAt)
  const attention = streaming || status === 'failed'
    || segments.some((segment) => (segment.kind === 'question' || segment.kind === 'approval') && segment.status === 'running')
  const open = choice?.attention === attention ? choice.open : attention
  const processed = `已处理${duration ? ` ${duration}` : ''}`
  const activity = runState?.activity?.trim()
  const liveActivity = activity && activity !== '正在处理' ? activity : processed
  const label = streaming ? liveActivity === '正在停止' ? `正在停止 · ${processed}`
    : liveActivity === processed ? processed : `${liveActivity}${duration ? ` · ${processed}` : ''}`
    : status === 'completed' ? duration ? `用时 ${duration}` : '已完成'
    : status === 'canceled' ? `已停止${duration ? ` · ${duration}` : ''}` : `执行失败${duration ? ` · ${duration}` : ''}`
  const groups = groupToolSegments(segments)
  const content = <>{slowFirstOutput && <p className="turn-waiting-note">模型响应较慢，仍在等待</p>}
    {runState?.subagents && runState.subagents.length > 0 && <SubagentStatusList items={runState.subagents} />}
    {groups.length > 0 && <div className="turn-activity-details">{groups.map((group, index) => group.kind === 'tools'
      ? <ToolGroup key={`activity-tools:${group.tools[0]!.id}`} tools={group.tools} />
      : <SegmentView key={`activity:${group.segment.kind}:${group.segment.id}:${index}`} segment={group.segment} streaming={streaming}
        approvalsEnabled={approvalsEnabled} onApprovalDecision={onApprovalDecision} onQuestionAnswer={onQuestionAnswer} />)}</div>}</>
  if (streaming) return <section aria-label={label} className={`turn-activity turn-status-${status}`}>
    <div className="turn-status-line" role="status"><LoaderCircle aria-hidden="true" className="turn-spinner" size={14} /><span>{label}</span></div>
    {content}
  </section>
  return <details className={`turn-activity turn-status-${status}`} open={open}>
    <summary className="turn-status-line" onClick={(event) => { event.preventDefault(); setChoice({ attention, open: !open }) }}>
      <span>{label}</span><ChevronRight className="turn-activity-chevron" size={15} />
    </summary>
    {content}
  </details>
}

function SubagentStatusList({ items }: { items: NonNullable<XiaoyinTaskProjection['subagents']> }) {
  return <section aria-label="任务状态" className="task-status-list">
    {items.map((item) => <div className={`task-status-item ${item.status}`} key={item.id}>
      <span className="task-status-icon" aria-hidden="true">
        {item.status === 'running' ? <LoaderCircle className="turn-spinner" size={14} />
          : item.status === 'completed' ? <Check size={14} />
            : item.status === 'failed' ? <CircleAlert size={14} /> : <Square size={11} fill="currentColor" strokeWidth={0} />}
      </span>
      <span className="task-status-label">{item.label}</span>
      <small>{subagentStatusLabel(item.status)}</small>
    </div>)}
  </section>
}

function subagentStatusLabel(status: NonNullable<XiaoyinTaskProjection['subagents']>[number]['status']): string {
  return status === 'running' ? '执行中' : status === 'completed' ? '已完成' : status === 'failed' ? '失败' : '已停止'
}
