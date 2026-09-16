import { describe, expect, it } from 'vitest'
import { applyLiveEvent } from './liveText'
import { assistantEntry, userEntry } from './testing'
import type { ConversationEntry } from './types'

describe('live transcript overlay', () => {
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
