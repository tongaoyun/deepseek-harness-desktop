import { describe, expect, it } from 'vitest'
import { applyHarnessResponseToMessages } from './streamingMessages'
import type { TaskMessage } from './types'

describe('applyHarnessResponseToMessages', () => {
  const pending: TaskMessage[] = [
    { role: 'user', text: '查看目录' },
    { role: 'assistant', text: '', pending: true },
  ]

  it('appends chunks from the same assistant step and replaces finalized text', () => {
    const first = applyHarnessResponseToMessages(pending, { key: 'assistant:1:1', mode: 'append', text: '正在' }, '')
    const second = applyHarnessResponseToMessages(first.messages, { key: 'assistant:1:1', mode: 'append', text: '查看' }, first.responseKey)
    const final = applyHarnessResponseToMessages(second.messages, { key: 'assistant:1:1', mode: 'replace', text: '查看完成' }, second.responseKey)

    expect(second.messages.at(-1)?.text).toBe('正在查看')
    expect(final.messages.at(-1)?.text).toBe('查看完成')
  })

  it('clears commentary before a tool call without touching prior turns', () => {
    const current = [{ role: 'assistant' as const, text: '旧回答' }, ...pending]
    const result = applyHarnessResponseToMessages(current, { key: '', mode: 'clear', text: '' }, 'assistant:1:1')

    expect(result.messages[0]?.text).toBe('旧回答')
    expect(result.messages.at(-1)?.text).toBe('')
    expect(result.responseKey).toBe('')
  })
})
