import { describe, expect, it, vi } from 'vitest'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { applyMemoryContext, DeepSeekHarnessRuntime, runSessionTurn, visibleTextChunks } from './runtime.js'
import { withTaskInstructions } from './task-instructions.js'

it('passes shared execution and delivery rules to actual runtime turns, including follow-ups', async () => {
  const runtime = new DeepSeekHarnessRuntime()
  const observedPrompts: unknown[] = []
  const client = {
    ...fakeClient([]),
    prompt: async (_sessionId: string, content: unknown) => { observedPrompts.push(content); return 'message-2' },
    subscribeSessionTree: () => fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '完成检查。' }] } }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]).subscribeSessionTree(),
  }
  Object.assign(runtime, { harness: { start: async () => {}, close: async () => {}, client } })
  await runtime.run({ sessionId: 'session-1', prompt: '只检查，不修改' }, () => {})
  await runtime.run({ sessionId: 'session-1', prompt: '把报告加上汇总行' }, () => {})
  expect(observedPrompts).toHaveLength(2)
  expect(JSON.stringify(observedPrompts[0])).toContain('只检查，不修改')
  expect(JSON.stringify(observedPrompts[1])).toContain('把报告加上汇总行')
  for (const prompt of observedPrompts) {
    expect(JSON.stringify(prompt)).toContain('local_files_publish')
    expect(JSON.stringify(prompt)).toContain('文件存在不等于内容正确')
    expect(JSON.stringify(prompt)).toContain('询问、检查和诊断不代表授权修改')
    expect(JSON.stringify(prompt)).toContain('切换工作阶段')
    expect(JSON.stringify(prompt)).toContain('简单问答不强行播报进度')
  }
  expect(withTaskInstructions('用户原文')).toMatch(/本轮任务上下文与请求：\n用户原文$/u)
  await runtime.close()
})

it('closes the underlying runtime immediately instead of waiting for the active turn', async () => {
  const runtime = new DeepSeekHarnessRuntime()
  const close = vi.fn(async () => {})
  Object.assign(runtime, { runTail: new Promise<void>(() => {}), harness: { close } })
  await runtime.close()
  await runtime.close()
  expect(close).toHaveBeenCalledOnce()
  await expect(runtime.initialize()).rejects.toThrow('本轮已停止')
})

it('rejects queued work after shutdown rather than starting another runtime', async () => {
  const runtime = new DeepSeekHarnessRuntime()
  const pending = runtime.run({ prompt: '不应执行' }, () => {})
  await runtime.close()
  await expect(pending).rejects.toThrow('本轮已停止')
})

describe('local cross-session memory', () => {
  it('adds employee guidance without replacing the current task', () => {
    expect(applyMemoryContext('分析库存', '先给结论')).toContain('先给结论')
    expect(applyMemoryContext('分析库存', '先给结论')).toContain('当前任务：\n分析库存')
    expect(applyMemoryContext('分析库存', '')).toBe('分析库存')
  })
})

describe('persisted session follow-ups', () => {
  it('preserves a waiting outcome from the root turn and never guesses completion from text', async () => {
    const outcome = { status: 'needs_input', summary: '缺少源数据', remaining: ['提供销售明细'], checks: [] }
    const report = (session: string) => [
      eventFor(session, 'tool/call', { callId: 'report', name: 'task_report' }),
      eventFor(session, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'report', isError: false, content: [{ type: 'text', text: JSON.stringify({ xiaoyinTaskOutcome: 1, outcome }) }] }] } }),
    ]
    for (const session of ['session-1', 'child-1']) {
      const result = await runSessionTurn(fakeClient([
        event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }), event('turn/start', { turn: 1 }),
        ...report(session),
        event('assistant/message', { message: { content: [{ type: 'text', text: '请提供销售明细。' }] } }),
        event('turn/end', { reason: { kind: 'completed' } }),
      ]), 'session-1', [{ type: 'text', text: '分析销售' }], () => {})
      expect(result.outcome?.status).toBe(session === 'session-1' ? 'needs_input' : 'unverified')
      expect(result.finalResponse).toBe('请提供销售明细。')
    }
  })
  it('fails a turn after partial output while still forwarding that output to the desktop', async () => {
    const observed: HarnessNotification[] = []
    const notifications = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '已读取表格，准备核对数据。' }] } }),
      event('turn/end', { reason: { kind: 'error', error: { message: 'model disconnected' } } }),
    ]
    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '处理表格' }], (value) => observed.push(value))).rejects.toThrow()
    expect(JSON.stringify(observed)).toContain('已读取表格')
  })

  it('does not treat reaching the output limit as task completion', async () => {
    await expect(runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '未写完' }] } }),
      event('turn/end', { reason: { kind: 'max-tokens' } }),
    ]), 'session-1', [{ type: 'text', text: '继续' }], () => {})).rejects.toThrow('输出上限')
  })

  it.each([
    ['aborted', '已停止'],
    ['blocked', '未进入执行'],
    ['interrupted', '意外中断'],
  ])('does not treat a %s turn as successful', async (kind, message) => {
    await expect(runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '部分结果' }] } }),
      event('turn/end', { reason: kind === 'aborted' ? { kind, reason: { kind: 'user' } } : { kind } }),
    ]), 'session-1', [{ type: 'text', text: '继续' }], () => {})).rejects.toThrow(message)
  })

  it('reports payload-less errors as failures even after a partial response', async () => {
    await expect(runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '部分结果' }] } }),
      event('turn/end', { reason: { kind: 'error' } }),
    ]), 'session-1', [{ type: 'text', text: '继续' }], () => {})).rejects.toThrow('执行失败')
  })

  it('does not accept completion while a dispatched tool has no receipt', async () => {
    await expect(runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('tool/call', { callId: 'write', name: 'order_create' }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '订单已创建' }] } }),
      event('turn/end', { reason: { kind: 'completed' } }),
    ]), 'session-1', [{ type: 'text', text: '创建订单' }], () => {})).rejects.toThrow('工具操作未取得结果')
  })

  it('stops waiting when a turn never produces activity', async () => {
    const client = {
      prompt: async () => 'message-2',
      subscribeSessionTree: () => ({ next: async () => new Promise<HarnessNotification>(() => undefined), close: () => undefined }),
    }

    await expect(runSessionTurn(client, 'session-1', [{ type: 'text', text: '继续' }], () => undefined, 10))
      .rejects.toThrow('任务执行超过 1 秒')
  })

  it('bounds prompt acknowledgement and closes the subscription when the engine stalls', async () => {
    const close = vi.fn()
    const next = vi.fn()
    const client = {
      prompt: () => new Promise<string>(() => {}),
      subscribeSessionTree: () => ({ next, close }),
    }
    await expect(runSessionTurn(client, 'session-1', [{ type: 'text', text: '继续' }], () => {}, 10))
      .rejects.toThrow('任务执行超过')
    expect(close).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
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
    expect(observed.some((item) => item.params.event?.type === 'text-chunks')).toBe(true)
  })

  it('finishes on turn/end even when the runtime does not emit a trailing idle status', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '完成。' }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]

    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined, 20))
      .resolves.toMatchObject({ finalResponse: '完成。' })
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

  it('waits for the root turn while forwarding child session activity', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      eventFor('child-1', 'turn/start', { turn: 1 }),
      eventFor('child-1', 'assistant/message', { message: { content: [{ type: 'text', text: '子 Agent 调研结果' }] } }),
      eventFor('child-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      statusFor('child-1', 'idle'),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '主 Agent 汇总结果' }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      status('idle'),
    ]
    const observed: HarnessNotification[] = []
    const result = await runSessionTurn(
      fakeClient(notifications),
      'session-1',
      [{ type: 'text', text: '并行调研' }],
      (value) => observed.push(value),
    )

    expect(result.finalResponse).toBe('主 Agent 汇总结果')
    expect(observed.some((item) => item.params.sessionId === 'child-1')).toBe(true)
  })
})

describe('visible response streaming', () => {
  it('keeps short provider chunks intact and splits large responses without losing text', () => {
    expect(visibleTextChunks('简短回复')).toEqual(['简短回复'])
    const response = '这是一个较长的模型回复，用于验证供应商只返回完整消息时，小胤仍然能够以稳定的增量展示内容，而不是等待结束后一次性全部显示。'.repeat(3)
    const chunks = visibleTextChunks(response)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(response)
    expect(chunks.every((chunk) => Array.from(chunk).length >= 1)).toBe(true)
  })

  it('smooths ordinary short answers instead of dumping one provider event', async () => {
    const answer = '冒泡排序会反复比较相邻元素，并在顺序错误时交换它们，直到整个序列有序。'
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: answer }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const observed: HarnessNotification[] = []

    await runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '冒泡排序是什么' }], (value) => observed.push(value))

    expect(observed.filter((item) => item.params.event?.type === 'text-chunks').length).toBeGreaterThan(1)
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

function eventFor(sessionId: string, type: string, data: Record<string, unknown>): HarnessNotification {
  return { method: 'session.event', params: { sessionId, event: { type, data } } }
}

function statusFor(sessionId: string, value: string): HarnessNotification {
  return { method: 'session.status', params: { sessionId, status: value } }
}
