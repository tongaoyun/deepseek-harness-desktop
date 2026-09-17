import { describe, expect, it } from 'vitest'
import { applyLiveEvent, mergeSettledTurn } from './liveText'
import { assistantEntry, userEntry } from './testing'
import type { ConversationEntry } from './types'

describe('live transcript overlay', () => {
  it('keeps the clock monotonic when the settled projection arrives', () => {
    const sent = '2026-09-16T10:00:00.000Z'
    const entries: ConversationEntry[] = [
      userEntry('u1', '整理报表'),
      { id: 'turn:1', role: 'assistant', status: 'streaming', segments: [{ kind: 'text', id: '1:1', text: '处理中', streaming: true }], meta: { startedAt: sent } },
    ]
    // The harness opens the turn a few seconds after the employee sent it.
    const settled = applyLiveEvent(entries, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '处理中' }] } },
    })
    const merged = mergeSettledTurn(settled, {
      id: 'turn:1', role: 'assistant', status: 'completed',
      segments: [{ kind: 'text', id: '1:1', text: '处理中' }],
      meta: { startedAt: '2026-09-16T10:00:04.000Z', completedAt: '2026-09-16T10:00:09.000Z' },
    })
    const turn = merged.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.meta.startedAt).toBe(sent)
    expect(turn.meta.completedAt).toBe('2026-09-16T10:00:09.000Z')
  })

  it('never puts reasoning content into the visible reply', () => {
    const entries: ConversationEntry[] = [userEntry('u1', '下载目录里有啥'), assistantEntry('pending', [], {}, 'streaming')]
    const settled = applyLiveEvent(entries, {
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        message: { content: [
          { type: 'reasoning', text: 'The user wants to list the files in their Downloads directory.' },
          { type: 'text', text: '你的下载目录里有 20 个顶层项目。' },
        ] },
      },
    })
    const turn = settled.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments.map((segment) => segment.kind === 'text' ? segment.text : '')).toEqual(['你的下载目录里有 20 个顶层项目。'])
    expect(JSON.stringify(turn)).not.toContain('The user wants to list')
  })
})
