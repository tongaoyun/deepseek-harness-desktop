import { describe, expect, it } from 'vitest'
import { mergeImStatusIntoTasks } from './imTaskSync'
import { createTaskMonitor } from './harness'
import type { LocalImStatus } from './localIm'
import type { LocalTaskRun } from './types'

describe('IM task synchronization', () => {
  it('merges DingTalk messages and structured events into the bound desktop task once', () => {
    const task: LocalTaskRun = {
      id: 'task-1', source: 'DESKTOP', name: '日报', status: 'COMPLETED',
      createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
      sessionId: 'session-1', monitor: createTaskMonitor('2026-09-02T00:00:00Z'), messages: [],
    }
    const status = { enabled: true, conversations: [{
      conversationKey: 'ding:user', boundTaskId: 'task-1', sessionId: 'session-1',
      status: 'COMPLETED', updatedAt: '2026-09-02T01:00:00Z',
      messages: [{ id: 'm1', role: 'user', text: '继续生成日报', createdAt: '2026-09-02T00:59:00Z' }],
      taskEvents: [{ id: 'e1', createdAt: '2026-09-02T01:00:00Z', event: {
        method: 'session.event', params: { event: { type: 'turn/end', time: Date.parse('2026-09-02T01:00:00Z'), data: { turn: 1, reason: { kind: 'completed' } } } },
      } }],
    }] } as LocalImStatus
    const first = mergeImStatusIntoTasks([task], status)
    expect(first.changed).toHaveLength(1)
    expect(first.tasks[0]).toMatchObject({ status: 'COMPLETED', messages: [{ id: 'm1', source: 'dingtalk' }] })
    expect(first.tasks[0]!.monitor.steps).toEqual([expect.objectContaining({ id: 'response:1', status: 'completed' })])
    expect(mergeImStatusIntoTasks(first.tasks, status).changed).toHaveLength(0)
  })
})
