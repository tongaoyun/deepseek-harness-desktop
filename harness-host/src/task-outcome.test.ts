import { describe, expect, it } from 'vitest'
import { parseTaskOutcome, TaskOutcomeTracker, type TaskOutcome } from './task-outcome.js'
import { apply } from './task-outcome-plugin.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const completed: TaskOutcome = { status: 'completed', summary: '已完成核对', remaining: [], checks: [{ description: '金额合计', result: 'passed', evidence: '读取结果合计为 120.00' }] }
const call = (callId: string, name = 'task_report') => ({ type: 'tool/call', data: { callId, name } })
const result = (toolCallId: string, outcome: unknown = completed, isError = false) => ({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId, isError, content: [{ type: 'text', text: JSON.stringify({ xiaoyinTaskOutcome: 1, outcome }) }] }] } } })

describe('task outcome contract', () => {
  it('rejects contradictory completion and incomplete reports without a next step', () => {
    expect(parseTaskOutcome(completed)).toEqual(completed)
    expect(parseTaskOutcome({ ...completed, remaining: ['等待源文件'] })).toBeUndefined()
    for (const status of ['partial', 'needs_input', 'needs_confirmation', 'blocked', 'unverified']) {
      expect(parseTaskOutcome({ ...completed, status })).toBeUndefined()
      expect(parseTaskOutcome({ ...completed, status, remaining: ['补充源文件'] })?.status).toBe(status)
    }
    for (const checkResult of ['failed', 'not_run']) expect(parseTaskOutcome({ ...completed, checks: [{ ...completed.checks[0], result: checkResult }] })).toBeUndefined()
    expect(parseTaskOutcome({ ...completed, checks: [{ ...completed.checks[0], evidence: '' }] })).toBeUndefined()
    expect(parseTaskOutcome({ status: 'partial', summary: '待核对', remaining: ['核对结果'], checks: [{ ...completed.checks[0], result: ['passed'] }] })).toBeUndefined()
  })

  it('validates and renders the registered tool result for the runtime tracker', async () => {
    let tool!: ToolDefinition
    apply({ tools: { register: (value: ToolDefinition) => { tool = value; return () => {} } }, effect: () => {} } as unknown as Context)
    const output = await tool.execute(completed, {} as never)
    expect(output).toEqual({ xiaoyinTaskOutcome: 1, outcome: completed })
    await expect(tool.execute({ ...completed, remaining: ['未完成'] }, {} as never)).rejects.toThrow('任务结果无效')
  })

  it('requires a matching successful report instead of trusting arbitrary tool text', () => {
    const tracker = new TaskOutcomeTracker()
    tracker.observe(result('missing'))
    tracker.observe(call('read', 'local_files_read_text'))
    tracker.observe(result('read'))
    expect(tracker.result().status).toBe('unverified')
    tracker.observe(call('report'))
    tracker.observe(result('report', completed, true))
    expect(tracker.result().status).toBe('unverified')
    tracker.observe(call('report2'))
    tracker.observe(result('report2'))
    expect(tracker.result()).toEqual(completed)
  })

  it('invalidates a report when later work starts, including a failed replacement report', () => {
    const tracker = new TaskOutcomeTracker()
    tracker.observe(call('report')); tracker.observe(result('report'))
    tracker.observe(call('write', 'local_files_write_text'))
    expect(tracker.result().status).toBe('unverified')
    tracker.observe(result('write'))
    tracker.observe(call('new-report')); tracker.observe(result('new-report', completed, true))
    expect(tracker.result().status).toBe('unverified')
  })

  it('does not accept completion while an earlier tool is still running', () => {
    const tracker = new TaskOutcomeTracker()
    tracker.observe(call('write', 'local_files_write_text'))
    tracker.observe(call('report')); tracker.observe(result('report'))
    tracker.observe(result('write'))
    expect(tracker.result().status).toBe('unverified')
    tracker.observe(call('final')); tracker.observe(result('final'))
    expect(tracker.result().status).toBe('completed')
  })
})
