import { describe, expect, it } from 'vitest'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import type { TaskMessage } from './types'

describe('harnessPromptWithConversationReplay', () => {
  it('replays visible conversation when a fresh Harness session is required', () => {
    const messages: TaskMessage[] = [
      { role: 'user', text: '查看下载目录' },
      { role: 'assistant', text: '目录里有 report.xlsx。' },
    ]

    const prompt = harnessPromptWithConversationReplay('打开它', messages, true)

    expect(prompt).toContain('用户：查看下载目录')
    expect(prompt).toContain('小胤：目录里有 report.xlsx。')
    expect(prompt).toContain('当前任务：\n\n打开它')
  })

  it('does not replay failed assistant output or duplicate healthy sessions', () => {
    const messages: TaskMessage[] = [
      { role: 'user', text: '继续' },
      { role: 'assistant', text: '模型服务未能完成本轮请求', monitor: {
        status: 'failed', activity: '失败', updatedAt: '2026-09-04T00:00:00Z', steps: [], artifacts: [],
      } },
    ]

    expect(harnessPromptWithConversationReplay('重试', messages, true)).not.toContain('模型服务未能完成')
    expect(harnessPromptWithConversationReplay('重试', messages, false)).toBe('重试')
  })
})
