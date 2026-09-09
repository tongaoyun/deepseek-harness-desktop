import { ChevronRight, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExecutionTimeline, visibleExecutionEntries, type ApprovalDecisionHandler, type ApprovalUiState } from './ExecutionTimeline'
import { taskDurationLabel } from './taskTiming'
import type { TaskMonitorState } from './types'
import { isUnverifiedTaskOutcome } from './taskOutcome'

export function InlineTaskActivity({ monitor, finalResponse = '', onApprovalDecision }: {
  monitor: TaskMonitorState
  finalResponse?: string
  onApprovalDecision?: ApprovalDecisionHandler
}) {
  const [clock, setClock] = useState(Date.now())
  const approvalsEnabled = monitor.status === 'running' && monitor.activity !== '正在停止'
  const pendingApproval = approvalsEnabled ? (monitor.timeline ?? []).filter((entry) => entry.kind === 'approval' && entry.status === 'running').map((entry) => entry.id).join(':') : ''
  const [approvalStates, setApprovalStates] = useState<Record<string, ApprovalUiState>>({})
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
  const collapsedEntries = useMemo(() => {
    if (monitor.status !== 'running') return []
    const entries = monitor.timeline ?? []
    const latest = entries.findLast((entry) => entry.kind === 'assistant')
    return entries.filter((entry) => (entry.kind === 'approval' && entry.status === 'running')
      || entry.kind === 'warning' || entry.kind === 'error' || entry.status === 'failed'
      || (entry === latest && entry.kind === 'assistant'))
  }, [monitor.timeline, monitor.status])
  // Resolve disclosure in the same render as the new status. An effect would
  // briefly paint completed content expanded before collapsing it a frame later.
  const scope = `${monitor.status}:${pendingApproval}`
  const [choice, setChoice] = useState<{ scope: string; open: boolean }>()
  const open = choice?.scope === scope ? choice.open : monitor.status === 'running' || monitor.status === 'failed' || Boolean(pendingApproval)

  useEffect(() => {
    if (monitor.status !== 'running') return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [monitor.status])

  const executionEntries = visibleExecutionEntries(monitor.timeline ?? [], finalResponse)
  const hasDetails = executionEntries.length > 0
  const unverified = monitor.status === 'completed' && isUnverifiedTaskOutcome(monitor.outcome)
  if ((monitor.status === 'idle' || unverified) && executionEntries.length === 0 && monitor.steps.length === 0
    && monitor.artifacts.length === 0 && (monitor.changes?.length ?? 0) === 0) return null
  if (monitor.status === 'completed' && !hasDetails) return null
  const duration = taskDurationLabel(monitor, clock)
  const activity = /启动|初始化/.test(monitor.activity) ? '正在处理' : monitor.activity
  const interrupted = monitor.status === 'failed' && monitor.failure?.code === 'XY-INTERRUPTED'
  const summary = monitor.status === 'running'
    ? activity
    : interrupted ? '上次运行已中断'
    : monitor.status === 'completed' ? `执行过程${duration ? ` · 用时 ${duration}` : ''}`
    : duration ? `${monitor.status === 'failed' ? '处理失败 · 用时' : monitor.status === 'canceled' ? '已停止 · 用时' : '用时'} ${duration}` : statusLabel(monitor.status)

  return <section className={`inline-task-activity ${monitor.status}`}>
    <button aria-expanded={hasDetails ? open : undefined} className="inline-task-summary" disabled={!hasDetails} onClick={() => setChoice({ scope, open: !open })} type="button">
      {monitor.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
      <span>{pendingApproval ? '等待你确认' : summary}</span>
      {monitor.status === 'running' && duration && <small>{duration}</small>}
      {hasDetails && <ChevronRight className={open ? 'open' : ''} size={15} />}
    </button>
    {hasDetails && <ExecutionTimeline entries={open ? monitor.timeline ?? [] : collapsedEntries} finalResponse={finalResponse} onApprovalDecision={onApprovalDecision ? decide : undefined} approvalStates={approvalStates} approvalsEnabled={approvalsEnabled} />}
  </section>
}

function statusLabel(status: TaskMonitorState['status']): string {
  if (status === 'running') return '执行中'
  if (status === 'completed') return '本轮已结束'
  if (status === 'failed') return '失败'
  if (status === 'canceled') return '已停止'
  return '待开始'
}
