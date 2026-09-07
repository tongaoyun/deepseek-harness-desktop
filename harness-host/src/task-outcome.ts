export const taskOutcomeStatuses = ['completed', 'partial', 'needs_input', 'needs_confirmation', 'blocked', 'unverified'] as const
export type TaskOutcomeStatus = typeof taskOutcomeStatuses[number]
export interface TaskOutcome {
  status: TaskOutcomeStatus
  summary: string
  remaining: string[]
  checks: Array<{ description: string; result: 'passed' | 'failed' | 'not_run'; evidence: string }>
}

export function parseTaskOutcome(value: unknown): TaskOutcome | undefined {
  if (!record(value) || !taskOutcomeStatuses.includes(value.status as TaskOutcomeStatus)
    || !boundedText(value.summary, 2000) || !Array.isArray(value.remaining) || value.remaining.length > 20
    || !value.remaining.every((item) => boundedText(item, 1000))
    || !Array.isArray(value.checks) || value.checks.length > 20) return undefined
  const checks: TaskOutcome['checks'] = []
  for (const check of value.checks) {
    if (!record(check) || !boundedText(check.description, 500) || !boundedText(check.evidence, 2000)
      || typeof check.result !== 'string' || !['passed', 'failed', 'not_run'].includes(check.result)) return undefined
    checks.push({ description: check.description.trim(), evidence: check.evidence.trim(), result: check.result as TaskOutcome['checks'][number]['result'] })
  }
  if (value.status === 'completed' && (value.remaining.length > 0 || checks.some((check) => check.result !== 'passed'))) return undefined
  if (value.status !== 'completed' && value.remaining.length === 0) return undefined
  return { status: value.status as TaskOutcomeStatus, summary: value.summary.trim(), remaining: value.remaining.map((item: string) => item.trim()), checks }
}

export function unverifiedTaskOutcome(): TaskOutcome {
  return { status: 'unverified', summary: '本轮已结束，任务完成情况待核对。', remaining: ['核对当前成果和未完成事项后继续。'], checks: [] }
}

// Only a successful report from this root turn counts. Other tools and child
// sessions cannot publish an outcome, and subsequent work makes a report stale.
export class TaskOutcomeTracker {
  private calls = new Map<string, string>()
  private pending = new Set<string>()
  private outcome: TaskOutcome | undefined

  observe(event: Record<string, unknown> | undefined): void {
    if (!event || !record(event.data)) return
    const data = event.data
    if (event.type === 'tool/call' && typeof data.callId === 'string' && typeof data.name === 'string') {
      this.calls.set(data.callId, data.name)
      this.pending.add(data.callId)
      this.outcome = undefined
    }
    if (event.type !== 'tool/result' || !record(data.message) || !Array.isArray(data.message.content)) return
    for (const block of data.message.content) {
      if (!record(block) || block.type !== 'tool-result' || typeof block.toolCallId !== 'string') continue
      const tool = this.calls.get(block.toolCallId)
      if (!tool || !this.pending.delete(block.toolCallId)) continue
      this.outcome = undefined
      if (tool !== 'task_report' || block.isError === true || this.pending.size > 0 || !Array.isArray(block.content)) continue
      for (const content of block.content) {
        if (!record(content) || content.type !== 'text' || typeof content.text !== 'string') continue
        try {
          const result: unknown = JSON.parse(content.text)
          if (record(result) && result.xiaoyinTaskOutcome === 1) this.outcome = parseTaskOutcome(result.outcome)
        } catch { /* Non-JSON tool output cannot establish task completion. */ }
      }
    }
  }

  result(): TaskOutcome { return this.outcome ?? unverifiedTaskOutcome() }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function boundedText(value: unknown, max: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max }
