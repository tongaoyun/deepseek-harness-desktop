import { describe, expect, it } from 'vitest'
import { userEntry } from './conversation/testing'
import { mergeImStatusIntoTasks } from './imTaskSync'
import { createXiaoyinTaskProjection } from './harness'
import type { LocalImStatus } from './localIm'
import type { LocalTaskRun } from './types'

describe('IM task synchronization', () => {
  it('imports missing old messages without overwriting a newer desktop execution', () => {
    const task: LocalTaskRun = {
      id: 'task-1', source: 'DESKTOP', name: '日报', status: 'RUNNING',
      createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T02:00:00Z',
      sessionId: 'new-session', projection: { ...createXiaoyinTaskProjection(), status: 'running', activity: '正在修改日报' },
      entries: [userEntry('desktop-new', '修改一下')],
    }
    const conversation = {
      boundTaskId: task.id, sessionId: 'old-session', status: 'COMPLETED', updatedAt: '2026-09-02T01:00:00Z',
      messages: [{ id: 'im-old', role: 'assistant', text: '旧结果', createdAt: '2026-09-02T01:00:00Z' }],
    }
    const status = { enabled: true, conversations: [conversation, conversation] } as unknown as LocalImStatus
    const merged = mergeImStatusIntoTasks([task], status)
    expect(merged.tasks[0]).toMatchObject({ status: 'RUNNING', sessionId: 'new-session', projection: task.projection })
    expect(merged.tasks[0]!.entries.map((entry) => entry.id)).toEqual(['desktop-new', 'im-old'])
    expect(merged.tasks[0]!.entries.at(-1)).toMatchObject({ role: 'assistant', status: 'completed', meta: {} })
    expect(mergeImStatusIntoTasks(merged.tasks, status).changed).toHaveLength(0)
  })
  it('merges DingTalk messages and structured events into the bound desktop task once', () => {
    const task: LocalTaskRun = {
      id: 'task-1', source: 'DESKTOP', name: '日报', status: 'COMPLETED',
      createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
      sessionId: 'session-1', projection: createXiaoyinTaskProjection('2026-09-02T00:00:00Z'), entries: [],
    }
    const status = { enabled: true, conversations: [{
      conversationKey: 'ding:user', boundTaskId: 'task-1', sessionId: 'session-1',
      status: 'COMPLETED', updatedAt: '2026-09-02T01:00:00Z',
      messages: [{ id: 'm1', role: 'user', text: '继续生成日报', createdAt: '2026-09-02T00:59:00Z' }],
      taskProjection: { status: 'completed', activity: '已完成', updatedAt: '2026-09-02T01:00:00Z', steps: [{ id: 'read', kind: 'tool', label: '读取文件', toolName: 'local_files_read_text', status: 'completed' }], artifacts: [] },
    }] } as unknown as LocalImStatus
    const first = mergeImStatusIntoTasks([task], status)
    expect(first.changed).toHaveLength(1)
    expect(first.tasks[0]).toMatchObject({ status: 'COMPLETED', entries: [{ id: 'm1', source: 'dingtalk' }] })
    expect(first.tasks[0]!.projection.steps).toHaveLength(1)
    expect(mergeImStatusIntoTasks(first.tasks, status).changed).toHaveLength(0)
  })
})
