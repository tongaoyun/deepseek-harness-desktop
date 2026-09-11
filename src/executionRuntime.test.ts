import { describe, expect, it } from 'vitest'
import { createTaskMonitor, type HarnessNotification } from './harness'
import {
  beginExecutionTurn,
  completeExecutionTurn,
  failExecutionInterruptRequest,
  failExecutionTurn,
  observeHarnessNotification,
  projectExecutionTurn,
  projectExecutionThread,
  recordExecutionFileChanges,
  requestExecutionInterrupt,
  retryExecutionTurn,
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
    const started = beginExecutionTurn({ taskId: 'task-1', sessionId: 'session-1', operationScope: 'scope', now: initial.updatedAt, createId: () => 'one' })
    let { thread, monitor } = started
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
    const started = beginExecutionTurn({ taskId: 'task-1', sessionId: 'session-1', operationScope: 'scope', now: startedAt, createId: () => 'replay' })
    let { thread, monitor } = started
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

  it('coalesces consecutive streaming deltas without losing the latest cursor or text', () => {
    const started = beginExecutionTurn({
      taskId: 'stream', sessionId: 'session', operationScope: 'scope', now: '2026-09-11T00:00:00Z', createId: () => 'stream',
    })
    const first = observeHarnessNotification(started.thread, started.monitor, event('text-chunks', { turn: 1, step: 1, texts: ['第一段'] }, 1))
    const second = observeHarnessNotification(first.thread, first.monitor, event('text-chunks', { turn: 1, step: 1, texts: ['第二段'] }, 2))
    const turn = second.thread.turns[0]!
    expect(turn.events).toHaveLength(2)
    expect(turn.nextSequence).toBe(3)
    expect(turn.sourceCursors).toEqual({ 'stream-1': 2 })
    expect(second.monitor.timeline?.[0]?.text).toBe('第一段第二段')
    expect(projectExecutionTurn(createTaskMonitor(turn.startedAt), turn)).toEqual(second.monitor)
  })

  it('keeps turns under one thread and records verification separately from completion', () => {
    const firstMonitor = { ...createTaskMonitor('2026-09-11T00:00:00Z'), status: 'running' as const, activity: '正在处理' }
    const first = beginExecutionTurn({ taskId: 'task-1', sessionId: 'session-1', operationScope: 'scope', now: firstMonitor.updatedAt, createId: () => 'first' })
    let { thread } = first
    const outcome = { status: 'completed' as const, summary: '文件已生成', remaining: [], checks: [{ description: '文件存在', result: 'passed' as const, evidence: 'report.xlsx' }] }
    const completed = completeExecutionTurn(thread, first.monitor, outcome, '2026-09-11T00:01:00Z')
    expect(projectExecutionTurn(createTaskMonitor(first.monitor.startedAt), completed.thread.turns[0]!)).toEqual(completed.monitor)
    thread = beginExecutionTurn({ taskId: 'task-1', sessionId: 'session-1', operationScope: 'scope-2', previous: completed.thread, now: '2026-09-11T00:02:00Z', createId: () => 'second' }).thread

    expect(thread.turns).toHaveLength(2)
    expect(thread.turns[0]).toMatchObject({ id: 'turn-first', status: 'completed' })
    expect(thread.turns[0]?.events.at(-2)?.verification?.status).toBe('verified')
    expect(thread.activeTurnId).toBe('turn-second')
    expect(verificationFromOutcome({ status: 'unverified', summary: '待核对', remaining: ['核对'], checks: [] }).status).toBe('uncertain')
  })

  it('updates a selected historical turn without changing its terminal state or the latest projection', () => {
    const first = beginExecutionTurn({
      taskId: 'files', sessionId: 'session', operationScope: 'shared', now: '2026-09-11T01:00:00Z', createId: () => 'first',
    })
    const outcome = { status: 'completed' as const, summary: '完成', remaining: [], checks: [] }
    const firstCompleted = completeExecutionTurn(first.thread, first.monitor, outcome, '2026-09-11T01:01:00Z')
    const second = beginExecutionTurn({
      taskId: 'files', sessionId: 'session', operationScope: 'shared', previous: firstCompleted.thread,
      now: '2026-09-11T01:02:00Z', createId: () => 'second',
    })
    const secondCompleted = completeExecutionTurn(second.thread, second.monitor, outcome, '2026-09-11T01:03:00Z')
    const latestBefore = projectExecutionThread(secondCompleted.thread)
    const updated = recordExecutionFileChanges(secondCompleted.thread, firstCompleted.monitor, [{
      id: 'change', rootId: 'root', rootName: '工作区', path: 'report.csv', name: 'report.csv',
      sourceTool: 'local_files_write_text', action: 'created', changedAt: '2026-09-11T01:00:30Z', undoneAt: '2026-09-11T01:04:00Z',
    }], { targetTurnId: 'turn-first', now: '2026-09-11T01:04:00Z' })

    expect(updated.thread.turns[0]).toMatchObject({ status: 'completed', completedAt: '2026-09-11T01:01:00Z' })
    expect(updated.thread.turns[0]?.events.at(-1)?.type).toBe('file.changes.updated')
    expect(projectExecutionThread(updated.thread)).toEqual(latestBefore)
    expect(updated.monitor.changes?.[0]?.undoneAt).toBe('2026-09-11T01:04:00Z')
  })

  it('derives retry, interrupt and failure projections only from lifecycle events', () => {
    const started = beginExecutionTurn({
      taskId: 'lifecycle', sessionId: 'session', operationScope: 'scope', now: '2026-09-11T02:00:00Z', createId: () => 'lifecycle',
    })
    const retry = retryExecutionTurn(started.thread, started.monitor, 'session-2', '2026-09-11T02:00:01Z')
    expect(retry.monitor.activity).toContain('自动重试')
    expect(retry.thread.turns[0]?.events.at(-1)?.type).toBe('turn.retry.started')
    const stopping = requestExecutionInterrupt(retry.thread, retry.monitor, '2026-09-11T02:00:02Z')
    const stopFailed = failExecutionInterruptRequest(stopping.thread, stopping.monitor, '2026-09-11T02:00:03Z')
    expect(stopFailed.monitor.activity).toBe('停止失败，可重试')
    const failed = failExecutionTurn(stopFailed.thread, stopFailed.monitor, {
      cause: 'failure', failure: { code: 'XY-TEST', category: 'unknown', message: '失败详情' }, now: '2026-09-11T02:00:04Z',
    })
    expect(failed.monitor).toMatchObject({ status: 'failed', failure: { code: 'XY-TEST', detail: '失败详情' } })
    expect(projectExecutionTurn(createTaskMonitor(started.monitor.startedAt), failed.thread.turns[0]!)).toEqual(failed.monitor)
    expect(failed.thread.activeTurnId).toBeUndefined()
  })
})
