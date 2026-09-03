import { describe, expect, it } from 'vitest'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { applyMemoryContext, runSessionTurn } from './runtime.js'

describe('local cross-session memory', () => {
  it('adds employee guidance without replacing the current task', () => {
    expect(applyMemoryContext('分析库存', '先给结论')).toContain('先给结论')
    expect(applyMemoryContext('分析库存', '先给结论')).toContain('当前任务：\n分析库存')
    expect(applyMemoryContext('分析库存', '')).toBe('分析库存')
  })
})

describe('persisted session follow-ups', () => {
  it('stops waiting when a turn never produces activity', async () => {
    const client = {
      prompt: async () => 'message-2',
      subscribeSessionTree: () => ({ next: async () => new Promise<HarnessNotification>(() => undefined), close: () => undefined }),
    }

    await expect(runSessionTurn(client, 'session-1', [{ type: 'text', text: '继续' }], () => undefined, 10))
      .rejects.toThrow('任务执行超过 1 秒')
  })

  it('ignores a stale idle status until the new turn has actually started', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      status('idle'),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '冒泡排序会重复比较相邻元素。' }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      status('idle'),
    ]
    const observed: HarnessNotification[] = []
    const result = await runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '解释下冒泡' }], (value) => observed.push(value))

    expect(result.finalResponse).toBe('冒泡排序会重复比较相邻元素。')
    expect(observed).toHaveLength(6)
  })

  it('does not report a textless model turn as successful', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      status('idle'),
    ]
    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined))
      .rejects.toThrow('没有返回可显示文本')
  })

  it('surfaces a safe provider failure instead of misreporting an empty answer', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('turn/end', { turn: 2, reason: { kind: 'error', error: {
        message: "Invalid 'tools[24].function.name': expected ^[a-zA-Z0-9_-]+$",
      } } }),
      status('idle'),
    ]
    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined))
      .rejects.toThrow('模型工具配置不兼容')
  })

  it('keeps the last visible assistant text when a later tool-only message arrives', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '我先检查文件。' }] } }),
      event('assistant/message', { message: { content: [{ type: 'tool-call', name: 'local_files_list' }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      status('idle'),
    ]
    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined))
      .resolves.toMatchObject({ finalResponse: '我先检查文件。' })
  })
})

function fakeClient(notifications: HarnessNotification[]) {
  let index = 0
  return {
    prompt: async () => 'message-2',
    subscribeSessionTree: () => ({
      next: async () => notifications[index++]!,
      close: () => undefined,
    }),
  }
}

function event(type: string, data: Record<string, unknown>): HarnessNotification {
  return { method: 'session.event', params: { sessionId: 'session-1', event: { type, data } } }
}

function status(value: string): HarnessNotification {
  return { method: 'session.status', params: { sessionId: 'session-1', status: value } }
}
