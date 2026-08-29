import type { TaskExecutionStep } from './types'

export function ExecutionTrace({ steps }: { steps: TaskExecutionStep[] }) {
  if (steps.length === 0) return null
  return <ol aria-label="执行步骤" className="execution-trace">
    {steps.map((step) => <li className={step.status} key={step.id}>
      <i aria-hidden="true" />
      <span>{step.label}</span>
      {step.toolName && <code>{step.toolName}</code>}
      <small>{statusLabel(step.status)}</small>
    </li>)}
  </ol>
}

function statusLabel(status: TaskExecutionStep['status']): string {
  if (status === 'running') return '执行中'
  if (status === 'failed') return '失败'
  return '完成'
}
