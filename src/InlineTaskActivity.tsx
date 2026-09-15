import { ChevronRight, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExecutionTimeline, visibleExecutionEntries, type ApprovalDecisionHandler, type ApprovalUiState, type QuestionAnswerHandler } from './ExecutionTimeline'
import { taskDurationLabel } from './taskTiming'
import type { XiaoyinTaskProjection } from './types'
import { isUnverifiedTaskOutcome } from './taskOutcome'

export function InlineTaskActivity({ projection, finalResponse = '', onApprovalDecision, onQuestionAnswer }: {
  projection: XiaoyinTaskProjection
  finalResponse?: string
  onApprovalDecision?: ApprovalDecisionHandler
  onQuestionAnswer?: QuestionAnswerHandler
}) {
  const [clock, setClock] = useState(Date.now())
  const approvalsEnabled = projection.status === 'running' && projection.activity !== '正在停止'
  const pendingApproval = approvalsEnabled ? (projection.timeline ?? []).filter((entry) => entry.kind === 'approval' && entry.status === 'running').map((entry) => entry.id).join(':') : ''
  const pendingQuestion = approvalsEnabled ? (projection.timeline ?? []).filter((entry) => entry.kind === 'question' && entry.status === 'running').map((entry) => entry.id).join(':') : ''
  const [approvalStates, setApprovalStates] = useState<Record<string, ApprovalUiState>>({})
  const lastTimeline = useRef(projection.timeline ?? [])
  if ((projection.timeline?.length ?? 0) > 0) lastTimeline.current = projection.timeline ?? []
  const approvalLocks = useRef(new Set<string>())
  const decide = useCallback(async (id: string, decision: 'allow' | 'reject') => {
    if (!approvalsEnabled || !onApprovalDecision || approvalLocks.current.has(id)) return
    approvalLocks.current.add(id)
    setApprovalStates((value) => ({ ...value, [id]: { status: 'sending' } }))
    try {
      await onApprovalDecision(id, decision)
      setApprovalStates((value) => ({ ...value, [id]: { status: 'sent' } }))
    } catch (reason) {
      approvalLocks.current.delete(id)
      setApprovalStates((value) => ({ ...value, [id]: { status: 'error', error: reason instanceof Error ? reason.message : String(reason) } }))
    }
  }, [approvalsEnabled, onApprovalDecision])
  const timeline = projection.timeline?.length ? projection.timeline : (projection.status === 'running' ? lastTimeline.current : [])
  const collapsedEntries = useMemo(() => {
    if (projection.status !== 'running') return []
    const entries = timeline
    const latest = entries.findLast((entry) => entry.kind === 'assistant')
    return entries.filter((entry) => ((entry.kind === 'approval' || entry.kind === 'question') && entry.status === 'running')
      || entry.kind === 'warning' || entry.kind === 'error' || entry.status === 'failed'
      || (entry === latest && entry.kind === 'assistant'))
  }, [timeline, projection.status])
  // Resolve disclosure in the same render as the new status. An effect would
  // briefly paint completed content expanded before collapsing it a frame later.
  const scope = `${projection.status}:${pendingApproval}:${pendingQuestion}`
  const [choice, setChoice] = useState<{ scope: string; open: boolean }>()
  const open = choice?.scope === scope ? choice.open : projection.status === 'running' || projection.status === 'failed' || Boolean(pendingApproval) || Boolean(pendingQuestion)

  useEffect(() => {
    if (projection.status !== 'running') return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [projection.status])

  const executionEntries = visibleExecutionEntries(timeline, finalResponse)
  const hasDetails = executionEntries.length > 0
  const unverified = projection.status === 'completed' && isUnverifiedTaskOutcome(projection.outcome)
  if ((projection.status === 'idle' || unverified) && executionEntries.length === 0 && projection.steps.length === 0
    && projection.artifacts.length === 0 && (projection.changes?.length ?? 0) === 0) return null
  // Keep the compact completion row when the harness actually started an
  // execution, even if it emitted no tool details.
  if (projection.status === 'completed' && !hasDetails && projection.executionStarted !== true) return null
  const duration = taskDurationLabel(projection, clock)
  const activity = /启动|初始化/.test(projection.activity) ? '正在处理' : projection.activity
  const contextLabel = contextPressureLabel(projection)
  const retentionLabel = outputRetentionLabel(projection)
  const interrupted = projection.status === 'failed' && projection.failure?.code === 'XY-INTERRUPTED'
  const summary = projection.status === 'running'
    ? activity
    : interrupted ? '上次运行已中断'
    : projection.status === 'completed' ? `执行过程${duration ? ` · 用时 ${duration}` : ''}`
    : duration ? `${projection.status === 'failed' ? '处理失败 · 用时' : projection.status === 'canceled' ? '已停止 · 用时' : '用时'} ${duration}` : statusLabel(projection.status)

  return <section className={`inline-task-activity ${projection.status}`}>
    <button aria-expanded={hasDetails ? open : undefined} className="inline-task-summary" disabled={!hasDetails} onClick={() => setChoice({ scope, open: !open })} type="button">
      {projection.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
      <span>{pendingQuestion ? '等待你回答' : pendingApproval ? '等待你确认' : summary}</span>
      {projection.status === 'running' && duration && <small>{duration}</small>}
      {contextLabel && <small aria-label="上下文占用">{contextLabel}</small>}
      {retentionLabel && <small aria-label="工具结果裁剪">{retentionLabel}</small>}
      {hasDetails && <ChevronRight className={open ? 'open' : ''} size={15} />}
    </button>
    {hasDetails && <ExecutionTimeline entries={open ? timeline : collapsedEntries} finalResponse={finalResponse} onApprovalDecision={onApprovalDecision ? decide : undefined} onQuestionAnswer={onQuestionAnswer} approvalStates={approvalStates} approvalsEnabled={approvalsEnabled} />}
    {projection.status === 'running' && !hasDetails && <p className="task-starting-hint"><LoaderCircle className="turn-spinner" size={14} />正在分析任务…</p>}
  </section>
}

function contextPressureLabel(projection: XiaoyinTaskProjection): string | undefined {
  const pressure = projection.contextPressure
  if (!pressure?.contextWindow || pressure.projectedTokens === undefined) return undefined
  const ratio = Math.max(0, Math.min(100, Math.round((pressure.projectedTokens / pressure.contextWindow) * 100)))
  return `上下文 ${ratio}%`
}

function outputRetentionLabel(projection: XiaoyinTaskProjection): string | undefined {
  const retention = projection.outputRetention
  if (!retention?.prunedResults) return undefined
  return `已裁剪 ${retention.prunedResults} 项`
}

function statusLabel(status: XiaoyinTaskProjection['status']): string {
  if (status === 'running') return '执行中'
  if (status === 'completed') return '本轮已结束'
  if (status === 'failed') return '失败'
  if (status === 'canceled') return '已停止'
  return '待开始'
}
