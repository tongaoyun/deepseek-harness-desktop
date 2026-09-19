import { Check, Copy, RotateCcw, SquarePen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AssistantTurn } from '../conversation/types'
import { modelDisplayName } from '../modelSelection'
import { formatTokens, turnDurationLabel } from './toolSummary'

/** Model · tokens · duration, plus the per-turn actions. */
export function TurnFooter({ turn, actions }: {
  turn: AssistantTurn
  actions?: { onRegenerate?: () => void; onEdit?: () => void }
}) {
  const duration = turnDurationLabel(turn.meta.startedAt, turn.meta.completedAt)
  const usage = turn.meta.tokenUsage
  const tokenLabel = usage ? `输入 ${formatTokens(usage.inputTokens)}${usage.cacheReadTokens ? ` · 缓存读取 ${formatTokens(usage.cacheReadTokens)}` : ''}${usage.cacheWriteTokens ? ` · 缓存写入 ${formatTokens(usage.cacheWriteTokens)}` : ''} · 输出 ${formatTokens(usage.outputTokens)} tokens` : ''
  const facts = [
    turn.meta.model ? modelDisplayName(turn.meta.model) : '',
    tokenLabel,
    duration,
  ].filter(Boolean)
  const showActions = turn.status !== 'streaming' && (actions?.onRegenerate || actions?.onEdit)
  if (!facts.length && !showActions) return null
  return <div className="turn-footer">
    {facts.length > 0 && <small className="turn-facts">{facts.join(' · ')}</small>}
    {showActions && <span className="turn-actions">
      <CopyTurnButton turn={turn} />
      {actions?.onRegenerate && <button aria-label="重新生成" onClick={actions.onRegenerate} title="用同样的输入重跑这一轮" type="button"><RotateCcw size={15} /></button>}
      {actions?.onEdit && <button aria-label="编辑后重发" onClick={actions.onEdit} title="把原问题和附件放回输入框，修改后发送" type="button"><SquarePen size={15} /></button>}
    </span>}
  </div>
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
