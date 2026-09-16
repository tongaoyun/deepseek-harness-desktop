import { LoaderCircle, Sparkles } from 'lucide-react'
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
import { TurnFooter } from './TurnFooter'

/**
 * One assistant turn, in event order: streamed text stays where it was written
 * and tool cards append below it, never replacing it.
 */
export function AssistantTurnView({ turn, runState, actions, onApprovalDecision, onQuestionAnswer }: {
  turn: AssistantTurn
  runState?: XiaoyinTaskProjection
  actions?: { onRegenerate?: () => void; onEdit?: () => void }
  onApprovalDecision?: ApprovalDecisionHandler
  onQuestionAnswer?: QuestionAnswerHandler
}) {
  const streaming = turn.status === 'streaming'
  const approvalsEnabled = streaming && runState?.activity !== '正在停止'
  const groups = groupToolSegments(turn.segments)
  return <div className={`assistant-turn-body ${turn.status}`}>
    {streaming && <TurnStatusLine runState={runState} startedAt={turn.meta.startedAt} />}
    {groups.map((group, index) => group.kind === 'tools'
      ? <ToolGroup key={`tools:${group.tools[0]!.id}`} tools={group.tools} />
      : <SegmentView key={`${group.segment.kind}:${group.segment.id}:${index}`} segment={group.segment} streaming={streaming} approvalsEnabled={approvalsEnabled} onApprovalDecision={onApprovalDecision} onQuestionAnswer={onQuestionAnswer} />)}
    {turn.status === 'failed' && turn.meta.failure && <p className="turn-failure" role="alert">{turn.meta.failure.message}</p>}
    {!streaming && turn.segments.every((segment) => segment.kind === 'tool') && turn.segments.length > 0
      && <p className="turn-silent">本轮没有文字说明，结果见上方操作与文件变更。</p>}
    <TurnFooter turn={turn} actions={actions} />
  </div>
}

function SegmentView({ segment, streaming, approvalsEnabled, onApprovalDecision, onQuestionAnswer }: {
  segment: TurnSegment
  streaming: boolean
  approvalsEnabled: boolean
  onApprovalDecision?: ApprovalDecisionHandler
  onQuestionAnswer?: QuestionAnswerHandler
}) {
  if (segment.kind === 'text') {
    return <div className={streaming && segment.streaming ? 'streaming-response' : undefined}><RichMessage assistant={!streaming} text={segment.text} /></div>
  }
  if (segment.kind === 'user') return <article className="conversation-turn user-turn steer-turn">
    <div className="user-prompt"><span className="steer-badge"><Sparkles size={12} />已插入当前任务</span><RichMessage assistant={false} text={segment.text} /></div>
  </article>
  if (segment.kind === 'approval') return <ApprovalCard segment={segment} enabled={approvalsEnabled} onDecision={onApprovalDecision} />
  if (segment.kind === 'question') return <QuestionCard segment={segment} enabled={approvalsEnabled} onAnswer={onQuestionAnswer} />
  return null
}

/** What the agent is doing right now, with elapsed time and context pressure. */
function TurnStatusLine({ runState, startedAt }: { runState?: XiaoyinTaskProjection; startedAt?: string }) {
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])
  const activity = runState?.activity && !/启动|初始化/.test(runState.activity) ? runState.activity : '正在处理'
  const duration = turnDurationLabel(startedAt, new Date(clock).toISOString())
  const pressure = runState?.contextPressure
  const ratio = pressure?.contextWindow && pressure.projectedTokens !== undefined
    ? Math.max(0, Math.min(100, Math.round((pressure.projectedTokens / pressure.contextWindow) * 100)))
    : undefined
  const pruned = runState?.outputRetention?.prunedResults
  return <div className="turn-status-line">
    <LoaderCircle className="turn-spinner" size={14} />
    <span>{activity}</span>
    {duration && <small>{duration}</small>}
    {ratio !== undefined && <small aria-label="上下文占用">上下文 {ratio}%</small>}
    {pruned ? <small aria-label="工具结果裁剪">已裁剪 {pruned} 项</small> : null}
  </div>
}
