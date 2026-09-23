import { Check, Copy, RotateCcw, SquarePen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AssistantTurn } from '../conversation/types'

/** Codex-style quiet footer: completion time and actions, without billing telemetry in the transcript. */
export function TurnFooter({ turn, actions }: {
  turn: AssistantTurn
  actions?: { onRegenerate?: () => void; onEdit?: () => void; completedAt?: string; latest?: boolean }
}) {
  const completedAtValue = turn.meta.completedAt ?? actions?.completedAt
  const completedAt = completionTime(completedAtValue)
  const hasText = turn.segments.some((segment) => segment.kind === 'text' && segment.text.trim())
  const showActions = turn.status !== 'streaming' && (hasText || actions?.onRegenerate || actions?.onEdit)
  if (!completedAt && !showActions) return null
  return <div className={`turn-footer${actions?.latest ? ' latest' : ''}`}>
    {showActions && <span className="turn-actions">
      <CopyTurnButton turn={turn} />
      {actions?.onRegenerate && <button aria-label="重新生成" onClick={actions.onRegenerate} title="用同样的输入重跑这一轮" type="button"><RotateCcw size={15} /></button>}
      {actions?.onEdit && <button aria-label="编辑后重发" onClick={actions.onEdit} title="把原问题和附件放回输入框，修改后发送" type="button"><SquarePen size={15} /></button>}
    </span>}
    {completedAt && <time className="turn-time" dateTime={completedAtValue}>{completedAt}</time>}
  </div>
}

function completionTime(value?: string): string {
  const date = new Date(value ?? '')
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function CopyTurnButton({ turn }: { turn: AssistantTurn }) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const text = turn.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('\n\n')
  const copy = async () => {
    window.clearTimeout(timer.current)
    try { await navigator.clipboard.writeText(text); setState('copied') }
    catch { setState('error') }
    timer.current = window.setTimeout(() => setState('idle'), 2_000)
  }
  const title = state === 'copied' ? '已复制' : state === 'error' ? '复制失败，请重试' : '复制回答'
  return <button aria-label={title} onClick={() => void copy()} title={title} type="button">{state === 'copied' ? <Check size={15} /> : <Copy size={15} />}</button>
}
