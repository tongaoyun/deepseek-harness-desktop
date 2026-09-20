import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import type { ApprovalSegment } from '../conversation/types'

export type ApprovalDecisionHandler = (approvalId: string, decision: 'allow' | 'reject') => void | Promise<void>

export interface ApprovalUiState { status: 'sending' | 'sent' | 'error'; error?: string }

interface ApprovalPresentation {
  connector?: string
  toolName: string
  fullToolName: string
  description?: string
  arguments?: string
}

function approvalPresentation(segment: ApprovalSegment): ApprovalPresentation {
  const lines = segment.detail?.split('\n').map((line) => line.trim()).filter(Boolean) ?? []
  const call = lines[0]?.match(/^调用「(.+?)」修改工具：(.+)$/u)
  const argumentIndex = lines.findIndex((line) => line.startsWith('参数：'))
  const fullToolName = call?.[2]?.trim() || segment.toolName
  const connector = call?.[1]?.trim()
  const prefix = connector ? `mcp_${connector}_` : ''
  const toolName = prefix && fullToolName.startsWith(prefix) ? fullToolName.slice(prefix.length) : fullToolName
  const description = lines.filter((_, index) => index !== argumentIndex && (!call || index !== 0)).join('\n')
  const rawArguments = argumentIndex >= 0 ? lines[argumentIndex]!.slice('参数：'.length).trim() : ''
  let arguments_: string | undefined
  if (rawArguments) {
    try { arguments_ = JSON.stringify(JSON.parse(rawArguments), null, 2) }
    catch { arguments_ = rawArguments }
  }
  return { connector, toolName, fullToolName, ...(description ? { description } : {}), ...(arguments_ ? { arguments: arguments_ } : {}) }
}

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
  const presentation = approvalPresentation(segment)
  if (settled) return <section className={`timeline-approval approval-card settled ${segment.status}`} aria-label={segment.label}>
    {segment.status === 'completed' ? <ShieldCheck size={15} /> : <ShieldX size={15} />}
    <span>{segment.status === 'completed' ? '已允许本次操作' : '已拒绝本次操作'}</span>
    <code title={presentation.fullToolName}>{presentation.toolName}</code>
  </section>
  return <section className={`timeline-approval approval-card ${segment.status}`} aria-label={segment.label}>
    <header className="approval-header">
      <span className="approval-icon"><ShieldAlert size={17} /></span>
      <div><small>操作确认</small><strong>允许执行此操作？</strong></div>
    </header>
    <div className="approval-body">
      <div className="approval-operation">
        <small>{presentation.connector ? `${presentation.connector} · 修改操作` : '修改操作'}</small>
        <code title={presentation.fullToolName}>{presentation.toolName}</code>
      </div>
      {presentation.description && <p className="approval-description">{presentation.description}</p>}
      {presentation.arguments && <div className="approval-arguments"><small>参数</small><pre>{presentation.arguments}</pre></div>}
    </div>
    <footer className="approval-footer">
      <div className="timeline-approval-actions">
        <button className="reject" disabled={!enabled || submitting} onClick={() => void decide('reject')} type="button">拒绝</button>
        <button disabled={!enabled || submitting} onClick={() => void decide('allow')} type="button">允许一次</button>
      </div>
      {!enabled && <p className="approval-feedback" role="status">本轮已停止或结束，不能再确认此操作。</p>}
      {enabled && submitting && <p className="approval-feedback" role="status">{state.status === 'sending' ? '正在提交…' : '已允许，等待执行。'}</p>}
      {enabled && state?.status === 'error' && <p className="approval-feedback error" role="alert">{state.error}</p>}
    </footer>
  </section>
}
