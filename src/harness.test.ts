import { describe, expect, it } from 'vitest'
import { applyHarnessNotification, harnessActivityLabel } from './harness'

describe('harnessActivityLabel', () => {
  it('shows safe progress labels without exposing reasoning content', () => {
    const label = harnessActivityLabel({
      requestId: 1,
      event: {
        event: {
          method: 'session.event',
          params: { event: { type: 'tool/call', time: 1_787_981_950_440,
            data: { turn: 1, step: 1, callId: 'call-1', name: 'sales_summary', reasoning: 'private' } } },
        },
      },
    })
    expect(label).toBe('正在查询销售汇总')
    expect(label).not.toContain('private')

    expect(harnessActivityLabel({
      requestId: 1,
      event: { event: { method: 'session.status', params: { status: 'idle' } } },
    })).toBe('正在整理结果')
  })

  it('builds a safe durable timeline and correlates tool results', () => {
    const notifications = [
      event('step/start', { turn: 1, step: 1 }, 1),
      event('assistant/message', { turn: 1, step: 1, message: { reasoning: 'hidden chain' } }, 2),
      event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'inventory_risk',
        arguments: '{"sensitive":"not rendered"}' }, 3),
      event('tool/result', { turn: 1, step: 1, message: { content: [
        { type: 'tool-result', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: 'private ERP result' }] },
      ] } }, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ]
    const steps = notifications.reduce(applyHarnessNotification, [])

    expect(steps.map(({ kind, label, status, toolName }) => ({ kind, label, status, toolName }))).toEqual([
      { kind: 'analysis', label: '分析任务', status: 'completed', toolName: undefined },
      { kind: 'tool', label: '查询库存风险', status: 'completed', toolName: 'inventory_risk' },
      { kind: 'response', label: '完成回复', status: 'completed', toolName: undefined },
    ])
    expect(JSON.stringify(steps)).not.toContain('hidden chain')
    expect(JSON.stringify(steps)).not.toContain('private ERP result')
    expect(JSON.stringify(steps)).not.toContain('sensitive')
  })

  it('marks unfinished steps failed when the turn ends with an error', () => {
    const steps = [
      event('step/start', { turn: 2, step: 1 }, 1),
      event('turn/end', { turn: 2, reason: { kind: 'error' } }, 2),
    ].reduce(applyHarnessNotification, [])

    expect(steps.map((step) => step.status)).toEqual(['failed', 'failed'])
    expect(steps.at(-1)?.label).toBe('执行未完成')
  })
})

function event(type: string, data: Record<string, unknown>, time: number) {
  return {
    requestId: 1,
    event: { event: { method: 'session.event', params: { event: { type, time, data } } } },
  }
}
