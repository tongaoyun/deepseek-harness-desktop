import { CircleCheck, CircleHelp, CircleX } from 'lucide-react'
import { parseTaskOutcome } from './taskOutcome'

export function TaskOutcomeDetails({ outcome }: { outcome: unknown }) {
  const value = parseTaskOutcome(outcome)
  if (!value) return null
  return <section className="task-outcome-details" aria-label="任务结果">
    {value.status !== 'completed' && <><p>{value.summary}</p><ul>{value.remaining.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
    {value.checks.length > 0 && <details><summary>检查依据（{value.checks.length}）</summary><ul>{value.checks.map((check, index) => {
      const Icon = check.result === 'passed' ? CircleCheck : check.result === 'failed' ? CircleX : CircleHelp
      const label = check.result === 'passed' ? '通过' : check.result === 'failed' ? '未通过' : '未执行'
      return <li key={index}><Icon size={14} aria-label={label} /><div><strong>{check.description} · {label}</strong><p>{check.evidence}</p></div></li>
    })}</ul></details>}
  </section>
}
