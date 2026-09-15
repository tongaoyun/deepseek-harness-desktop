import { ChevronRight, CircleCheck, CircleHelp, CircleX, ClipboardCheck } from 'lucide-react'
import { parseTaskOutcome, taskOutcomeLabel } from './taskOutcome'
import './taskOutcome.css'

export function TaskOutcomeDetails({ outcome }: { outcome: unknown }) {
  const value = parseTaskOutcome(outcome)
  if (!value || value.status === 'completed' || value.status === 'unverified') return null
  if (!value.checks.length && !value.remaining.length) return null
  return <section className={`task-outcome-details task-outcome-${value.status}`} aria-label="任务结果">
    <div className="task-outcome-attention" role="status"><strong>{taskOutcomeLabel(value)}</strong><span>{value.summary}</span></div>
    {(value.checks.length > 0 || value.remaining.length > 0) &&
    <details><summary><ClipboardCheck size={14} /><span>验收记录</span><small>{value.checks.length} 项检查{value.remaining.length > 0 ? ` · ${value.remaining.length} 项待办` : ''}</small><ChevronRight size={14} /></summary>
      <div className="task-outcome-content">
      {value.remaining.length > 0 && <div className="task-outcome-remaining"><strong>待处理</strong><ul>{value.remaining.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      {value.checks.length > 0 && <ul className="task-outcome-checks">{value.checks.map((check, index) => {
      const Icon = check.result === 'passed' ? CircleCheck : check.result === 'failed' ? CircleX : CircleHelp
      const label = check.result === 'passed' ? '通过' : check.result === 'failed' ? '未通过' : '未执行'
      return <li key={index}><Icon size={14} aria-label={label} /><div><strong>{check.description} · {label}</strong><p>{check.evidence}</p></div></li>
    })}</ul>}
      </div>
    </details>}
  </section>
}
