import { describe, expect, it } from 'vitest'
import type { HarnessRuntime } from './runtime.js'
import type { JsonRpcOutput } from './protocol.js'
import { HostServer } from './server.js'
import { LocalImRuntime } from './im-runtime.js'

describe('HostServer', () => {
  it('returns health without starting a model turn', async () => {
    const output: JsonRpcOutput[] = []
    const server = new HostServer(fakeRuntime(), (value) => output.push(value))

    await server.handle({ jsonrpc: '2.0', id: 1, method: 'host.health' })

    expect(output).toEqual([{
      jsonrpc: '2.0',
      id: 1,
      result: { status: 'ready', runtime: 'fake', version: 'test' },
    }])
  })

  it('redacts credentials from errors at the JSON-RPC boundary', async () => {
    const output: JsonRpcOutput[] = []
    const runtime = fakeRuntime()
    runtime.health = async () => { throw new Error('provider failed with sk-1234567890abcdef') }
    const server = new HostServer(runtime, (value) => output.push(value))

    await server.handle({ jsonrpc: '2.0', id: 2, method: 'host.health' })

    expect(output).toEqual([{
      jsonrpc: '2.0', id: 2,
      error: {
        code: -32001,
        message: 'provider failed with [REDACTED]',
        data: {
          code: 'XY-HOST-ERROR', category: 'unknown', title: '任务执行失败',
          detail: 'provider failed with [REDACTED]', infrastructure: false, retryable: false,
        },
      },
    }])
  })

  it('exposes a read-only Harness session inspection endpoint', async () => {
    const output: JsonRpcOutput[] = []
    const runtime = fakeRuntime()
    runtime.inspectSession = async (sessionId) => ({ sessionId, status: 'completed', updatedAt: '2026-09-12T00:00:00.000Z', pendingTools: 0 })
    const server = new HostServer(runtime, (value) => output.push(value))
    await server.handle({ jsonrpc: '2.0', id: 3, method: 'session.inspect', params: { sessionId: 'session-1' } })
    expect(output).toEqual([{ jsonrpc: '2.0', id: 3, result: { sessionId: 'session-1', status: 'completed', updatedAt: '2026-09-12T00:00:00.000Z', pendingTools: 0 } }])
  })

  it('exposes bounded read-only Harness session search', async () => {
    const output: JsonRpcOutput[] = []
    const runtime = fakeRuntime()
    let receivedCursor: string | undefined
    runtime.searchSessions = async (sessionIds, _query, _limit, cursor) => {
      receivedCursor = cursor
      return { items: [{ sessionId: sessionIds[0]!, excerpt: '命中', updatedAt: '2026-09-12T00:00:00.000Z' }], nextCursor: 'next-page' }
    }
    const server = new HostServer(runtime, (value) => output.push(value))
    await server.handle({ jsonrpc: '2.0', id: 4, method: 'session.search', params: { sessionIds: ['session-1'], query: '库存', limit: 10, cursor: 'previous-page' } })
    expect(receivedCursor).toBe('previous-page')
    expect(output).toEqual([{ jsonrpc: '2.0', id: 4, result: { items: [{ sessionId: 'session-1', excerpt: '命中', updatedAt: '2026-09-12T00:00:00.000Z' }], nextCursor: 'next-page' } }])
  })

  it('diagnoses configured connectors without starting the model runtime', async () => {
    const output: JsonRpcOutput[] = []
    const runtime = fakeRuntime()
    const server = new HostServer(runtime, (value) => output.push(value))
    const previous = process.env.XIAOYIN_MCP_CONNECTORS
    process.env.XIAOYIN_MCP_CONNECTORS = '[]'
    try {
      await server.handle({ jsonrpc: '2.0', id: 2, method: 'connectors.diagnose' })
    } finally {
      if (previous === undefined) delete process.env.XIAOYIN_MCP_CONNECTORS
      else process.env.XIAOYIN_MCP_CONNECTORS = previous
    }

    expect(output).toEqual([{ jsonrpc: '2.0', id: 2, result: [] }])
  })

  it('streams a notification before the final result', async () => {
    const output: JsonRpcOutput[] = []
    const server = new HostServer(fakeRuntime(), (value) => output.push(value))

    await server.handle({
      jsonrpc: '2.0',
      id: 'turn-1',
      method: 'session.run',
      params: { prompt: '分析库存', sessionId: 'session-1' },
    })

    expect(output).toHaveLength(2)
    expect(output[0]).toMatchObject({
      method: 'session.notification',
      params: { requestId: 'turn-1', rootSessionId: 'session-1' },
    })
    expect(output[1]).toEqual({
      jsonrpc: '2.0',
      id: 'turn-1',
      result: { sessionId: 'session-1', finalResponse: '完成' },
    })
  })

  it('decodes desktop image attachments before starting the model turn', async () => {
    const output: JsonRpcOutput[] = []
    const runtime = fakeRuntime()
    let receivedText = ''
    runtime.run = async (input) => {
      receivedText = input.images?.[0]?.data.toString('utf8') ?? ''
      return { sessionId: 'session-image', finalResponse: '已查看图片' }
    }
    const server = new HostServer(runtime, (value) => output.push(value))

    await server.handle({
      jsonrpc: '2.0', id: 'turn-image', method: 'session.run', params: {
        prompt: '看看这张图',
        images: [{ dataBase64: Buffer.from('image-bytes').toString('base64'), mediaType: 'image/png', name: 'screen.png' }],
      },
    })

    expect(receivedText).toBe('image-bytes')
    expect(output.at(-1)).toMatchObject({ result: { finalResponse: '已查看图片' } })
  })

  it('accepts a pending approval response independently of a model turn', async () => {
    const output: JsonRpcOutput[] = []
    const server = new HostServer(fakeRuntime(), (value) => output.push(value), (id, decision) => id === 'approval-1' && decision === 'allow')
    await server.handle({
      jsonrpc: '2.0', id: 9, method: 'approval.respond',
      params: { approvalId: 'approval-1', decision: 'allow' },
    })
    expect(output).toEqual([{ jsonrpc: '2.0', id: 9, result: { status: 'accepted' } }])
  })

  it('accepts structured question answers independently of a model turn', async () => {
    const output: JsonRpcOutput[] = []
    const server = new HostServer(
      fakeRuntime(),
      (value) => output.push(value),
      undefined,
      undefined,
      (id, answer) => id === 'question-1' && answer.answers[0]?.selected[0] === '继续',
    )
    await server.handle({
      jsonrpc: '2.0', id: 10, method: 'question.respond',
      params: { questionId: 'question-1', answers: [{ id: 'action', selected: ['继续'] }] },
    })
    expect(output).toEqual([{ jsonrpc: '2.0', id: 10, result: { status: 'accepted' } }])
  })

  it('accepts image payloads between five and ten MiB without rejecting their base64 envelope', async () => {
    const output: JsonRpcOutput[] = []
    const runtime = fakeRuntime()
    let length = 0
    runtime.run = async (input) => { length = input.images![0]!.data.length; return { sessionId: 'large-image', finalResponse: '收到' } }
    const server = new HostServer(runtime, (value) => output.push(value))
    await server.handle({ jsonrpc: '2.0', id: 'large-image', method: 'session.run', params: {
      prompt: '检查图片', images: [{ dataBase64: Buffer.alloc(6 * 1024 * 1024, 1).toString('base64'), mediaType: 'image/png', name: 'large.png' }],
    } })
    expect(length).toBe(6 * 1024 * 1024)
    expect(output.at(-1)).toMatchObject({ result: { finalResponse: '收到' } })
  })

  it('binds and unbinds a DingTalk conversation to a desktop task session', async () => {
    const output: JsonRpcOutput[] = []
    const runtime = new LocalImRuntime(fakeRuntime())
    const server = new HostServer(fakeRuntime(), (value) => output.push(value), undefined, runtime)
    await server.handle({ jsonrpc: '2.0', id: 10, method: 'im.bind-task', params: {
      conversationKey: 'ding:private:user-1', taskId: 'task-1', taskName: '店铺日报', sessionId: 'session-1',
    } })
    await server.handle({ jsonrpc: '2.0', id: 11, method: 'im.unbind-task', params: {
      conversationKey: 'ding:private:user-1',
    } })
    expect(output).toHaveLength(2)
    expect(output.map((item) => 'id' in item ? item.id : undefined)).toEqual([10, 11])
  })

  it('routes manual delivery retries to IM without starting an Agent session', async () => {
    const output: JsonRpcOutput[] = []
    const runtime = new LocalImRuntime(fakeRuntime())
    const calls: string[] = []
    runtime.retryDelivery = async (key) => { calls.push(key); return runtime.status() }
    const server = new HostServer(fakeRuntime(), (value) => output.push(value), undefined, runtime)
    await server.handle({ jsonrpc: '2.0', id: 12, method: 'im.retry-delivery', params: { conversationKey: 'test:private:one' } })
    expect(calls).toEqual(['test:private:one'])
    expect(output).toHaveLength(1)
    expect(output[0]).toMatchObject({ id: 12, result: { provider: 'DINGTALK' } })
  })
})

function fakeRuntime(): HarnessRuntime {
  return {
    async health() {
      return { status: 'ready', runtime: 'fake', version: 'test' }
    },
    async initialize() {
      return { status: 'initialized', runtime: 'fake' }
    },
    async run(input, onNotification) {
      const rootSessionId = input.sessionId ?? 'new-session'
      onNotification({ method: 'session.status', params: { sessionId: rootSessionId, status: 'working' } }, rootSessionId)
      return { sessionId: rootSessionId, finalResponse: '完成' }
    },
    async close() {},
  }
}

it('steers into the running turn and interrupts it through the interactive methods', async () => {
  const output: JsonRpcOutput[] = []
  const called: string[] = []
  const runtime = fakeRuntime()
  runtime.steer = async (sessionId, text) => { called.push(sessionId); return { messageId: `steered-${text}` } }
  runtime.interrupt = async (sessionId) => { called.push(`interrupt:${sessionId}`); return { interrupted: true } }
  const server = new HostServer(runtime, (value) => output.push(value))
  await server.handle({ jsonrpc: '2.0', id: 10, method: 'session.steer', params: { sessionId: 'session-1', text: '改用方案 B' } })
  expect(output.at(-1)).toMatchObject({ id: 10, result: { messageId: 'steered-改用方案 B' } })
  await server.handle({ jsonrpc: '2.0', id: 11, method: 'session.interrupt', params: { sessionId: 'session-1' } })
  expect(output.at(-1)).toMatchObject({ id: 11, result: { interrupted: true } })
  expect(called).toEqual(['session-1', 'interrupt:session-1'])
})

it('rejects a blank steering prompt', async () => {
  const output: JsonRpcOutput[] = []
  const server = new HostServer(fakeRuntime(), (value) => output.push(value))
  await server.handle({ jsonrpc: '2.0', id: 12, method: 'session.steer', params: { sessionId: 'session-1', text: '   ' } })
  expect(output.at(-1)).toMatchObject({ id: 12, error: expect.objectContaining({ message: expect.stringContaining('non-blank') }) })
})

it('forks the session through the official session/fork command', async () => {
  const output: JsonRpcOutput[] = []
  const runtime = fakeRuntime()
  runtime.fork = async (sessionId) => ({ sessionId: `${sessionId}-r1` })
  const server = new HostServer(runtime, (value) => output.push(value))
  await server.handle({ jsonrpc: '2.0', id: 20, method: 'session.fork', params: { sessionId: 'session-1' } })
  expect(output.at(-1)).toMatchObject({ id: 20, result: { sessionId: 'session-1-r1' } })
})
