import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../conversation/types'
import { activeRunStartedAt } from './turnElapsed'

describe('activeRunStartedAt', () => {
  it('continues counting across model turns and an in-flight steer', () => {
    const entries: ConversationEntry[] = [
      { id: 'user:1', role: 'user', text: '整理报表' },
      { id: 'turn:1', role: 'assistant', status: 'completed', segments: [], meta: { startedAt: '2026-09-16T10:00:00Z' } },
      { id: 'steer:1', role: 'user', text: '再检查合计', source: 'steer' },
      { id: 'turn:2', role: 'assistant', status: 'streaming', segments: [], meta: { startedAt: '2026-09-16T10:01:00Z' } },
    ]
    expect(activeRunStartedAt(entries, 3)).toBe('2026-09-16T10:00:00Z')
  })

  it('starts again for a newly submitted message in the same task', () => {
    const entries: ConversationEntry[] = [
      { id: 'turn:1', role: 'assistant', status: 'completed', segments: [], meta: { startedAt: '2026-09-16T10:00:00Z' } },
      { id: 'user:2', role: 'user', text: '继续' },
      { id: 'turn:2', role: 'assistant', status: 'streaming', segments: [], meta: { startedAt: '2026-09-16T11:00:00Z' } },
    ]
    expect(activeRunStartedAt(entries, 2)).toBe('2026-09-16T11:00:00Z')
  })
})
