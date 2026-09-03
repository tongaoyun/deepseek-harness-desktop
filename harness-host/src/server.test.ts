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
      params: { requestId: 'turn-1' },
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
      onNotification({ method: 'session.status', params: { status: 'working' } })
      return { sessionId: input.sessionId ?? 'new-session', finalResponse: '完成' }
    },
    async close() {},
  }
}
