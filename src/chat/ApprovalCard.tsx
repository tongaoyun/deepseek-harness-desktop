import { ShieldCheck } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { ApprovalSegment } from '../conversation/types'

export type ApprovalDecisionHandler = (approvalId: string, decision: 'allow' | 'reject') => void | Promise<void>

export interface ApprovalUiState { status: 'sending' | 'sent' | 'error'; error?: string }

/** A high-risk tool call waits here for the employee's decision, in place. */
export function ApprovalCard({ segment, enabled, onDecision }: {
  segment: ApprovalSegment
  enabled: boolean
  onDecision?: ApprovalDecisionHandler
}) {
  const [state, setState] = useState<ApprovalUiState>()
  const lock = useRef(false)
  const decide = useCallback(async (decision: 'allow' | 'reject') => {
    if (!enabled || !onDecision || lock.current) return
    lock.current = true
    setState({ status: 'sending' })
    try {
      await onDecision(segment.approvalId, decision)
      setState({ status: 'sent' })
    } catch (reason) {
      lock.current = false
      setState({ status: 'error', error: reason instanceof Error ? reason.message : String(reason) })
    }
  }, [enabled, onDecision, segment.approvalId])

  const settled = segment.status !== 'running'
  const submitting = state?.status === 'sending' || state?.status === 'sent'
  return <section className={`timeline-approval approval-card ${segment.status}`} aria-label={segment.label}>
    <div className="approval-summary"><ShieldCheck size={16} /><span>{segment.label}</span></div>
    {segment.detail && <p className="approval-detail">{segment.detail}</p>}
    {!settled && <div className="timeline-approval-actions">
      <button className="reject" disabled={!enabled || submitting} onClick={() => void decide('reject')} type="button">拒绝</button>
      <button disabled={!enabled || submitting} onClick={() => void decide('allow')} type="button">允许本次操作</button>
    </div>}
    {!settled && !enabled && <p className="approval-feedback" role="status">本轮已停止或结束，不能再确认此操作。</p>}
    {!settled && enabled && submitting && <p className="approval-feedback" role="status">{state.status === 'sending' ? '正在提交确认…' : '确认已发送，等待执行结果。'}</p>}
    {!settled && enabled && state?.status === 'error' && <p className="approval-feedback error" role="alert">{state.error}</p>}
  </section>
}
