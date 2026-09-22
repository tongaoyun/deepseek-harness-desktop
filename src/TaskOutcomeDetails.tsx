import { parseTaskOutcome, taskOutcomeLabel } from './taskOutcome'
import './taskOutcome.css'

export function TaskOutcomeDetails({ outcome }: { outcome: unknown }) {
  const value = parseTaskOutcome(outcome)
  if (!value || value.status === 'completed' || value.status === 'answered' || value.status === 'unverified') return null
  return <section className={`task-outcome-details task-outcome-${value.status}`} aria-label="任务状态">
    <div className="task-outcome-attention" role="status"><strong>{taskOutcomeLabel(value)}</strong><span>{value.summary}</span></div>
  </section>
}
