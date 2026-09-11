import { describe, expect, it } from 'vitest'
import { createTaskMonitor, type HarnessNotification } from './harness'
import {
  appendExecutionTransition,
  observeHarnessNotification,
  projectExecutionTurn,
  startExecutionTurn,
  verificationFromOutcome,
} from './executionRuntime'
import type { TaskMonitorState } from './types'

function event(type: string, data: Record<string, unknown>, sequence: number): HarnessNotification {
  return {
    taskId: 'task-1',
    requestId: 7,
    streamId: 'stream-1',
    sequence,
    event: { event: { method: 'session.event', params: { event: { type, time: 1_800_000_000_000 + sequence, data } } } },
  }
}

describe('execution runtime', () => {
  it('records ordered events, persists a source cursor and ignores duplicate delivery', () => {
    const initial: TaskMonitorState = { ...createTaskMonitor('2026-09-11T00:00:00Z'), status: 'running', activity: '正在处理' }
    let thread = startExecutionTurn('task-1', 'session-1', initial, undefined, initial.updatedAt, () => 'one')
    let monitor = initial
    const call = event('tool/call', {
      turn: 1, step: 1, callId: 'call-1', name: 'inventory_risk', arguments: '{"secret":"must-not-persist"}',
    }, 1)
    const observed = observeHarnessNotification(thread, monitor, call)
    thread = observed.thread
    monitor = observed.monitor

    const duplicate = observeHarnessNotification(thread, monitor, call)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.thread).toBe(thread)
    expect(thread.turns[0]?.sourceCursors).toEqual({ 'stream-1': 1 })
    expect(thread.turns[0]?.events.map((item) => item.sequence)).toEqual([1, 2])
    expect(thread.turns[0]?.events[1]).toMatchObject({ type: 'item.started', itemId: 'tool:call-1', correlationId: 'call-1' })
    expect(thread.turns[0]?.items).toMatchObject([{ id: 'tool:call-1', kind: 'tool-call', status: 'running' }])
    expect(JSON.stringify(thread)).not.toContain('must-not-persist')

    const restarted = observeHarnessNotification(thread, monitor, {
      ...event('tool/call', { turn: 1, step: 2, callId: 'call-2', name: 'inventory_risk' }, 1),
      streamId: 'stream-2',
    })
    expect(restarted.duplicate).toBe(false)
    expect(restarted.thread.turns[0]?.sourceCursors).toEqual({ 'stream-1': 1, 'stream-2': 1 })
  })

  it('can rebuild the monitor projection from durable turn events', () => {
    const startedAt = '2026-09-11T00:00:00Z'
    const idle = createTaskMonitor(startedAt)
    const running: TaskMonitorState = { ...idle, operationScope: 'scope', status: 'running', activity: '正在处理', startedAt }
    let thread = startExecutionTurn('task-1', 'session-1', running, undefined, startedAt, () => 'replay')
    let monitor = running
    for (const notification of [
      event('step/start', { turn: 1, step: 1 }, 1),
      event('tool/call', { turn: 1, step: 1, callId: 'read', name: 'local_files_read_text' }, 2),
      event('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'read', content: [{ type: 'text', text: 'private file body' }] }] } }, 3),
    ]) {
      const observed = observeHarnessNotification(thread, monitor, notification)
      thread = observed.thread
      monitor = observed.monitor
    }
    const replayed = projectExecutionTurn(createTaskMonitor(startedAt), thread.turns[0]!)
    expect(replayed).toEqual(monitor)
    expect(replayed.steps.map((step) => step.status)).toEqual(['completed', 'completed'])
    expect(JSON.stringify(thread)).not.toContain('private file body')
  })

  it('keeps turns under one thread and records verification separately from completion', () => {
    const firstMonitor = { ...createTaskMonitor('2026-09-11T00:00:00Z'), status: 'running' as const, activity: '正在处理' }
    let thread = startExecutionTurn('task-1', 'session-1', firstMonitor, undefined, firstMonitor.updatedAt, () => 'first')
    const completed = { ...firstMonitor, status: 'completed' as const, activity: '已完成', updatedAt: '2026-09-11T00:01:00Z', completedAt: '2026-09-11T00:01:00Z' }
    const outcome = { status: 'completed' as const, summary: '文件已生成', remaining: [], checks: [{ description: '文件存在', result: 'passed' as const, evidence: 'report.xlsx' }] }
    thread = appendExecutionTransition(thread, firstMonitor, { ...completed, outcome }, 'verification.recorded', { outcome })
    thread = appendExecutionTransition(thread, completed, completed, 'turn.completed')
    thread = startExecutionTurn('task-1', 'session-1', firstMonitor, thread, '2026-09-11T00:02:00Z', () => 'second')

    expect(thread.turns).toHaveLength(2)
    expect(thread.turns[0]).toMatchObject({ id: 'turn-first', status: 'completed' })
    expect(thread.turns[0]?.events.at(-2)?.verification?.status).toBe('verified')
    expect(thread.activeTurnId).toBe('turn-second')
    expect(verificationFromOutcome({ status: 'unverified', summary: '待核对', remaining: ['核对'], checks: [] }).status).toBe('uncertain')
  })
})
