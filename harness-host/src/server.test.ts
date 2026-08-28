import { describe, expect, it } from 'vitest'
import type { HarnessRuntime } from './runtime.js'
import type { JsonRpcOutput } from './protocol.js'
import { HostServer } from './server.js'

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

  it('accepts a pending approval response independently of a model turn', async () => {
    const output: JsonRpcOutput[] = []
    const server = new HostServer(fakeRuntime(), (value) => output.push(value), (id, decision) => id === 'approval-1' && decision === 'allow')
    await server.handle({
      jsonrpc: '2.0', id: 9, method: 'approval.respond',
      params: { approvalId: 'approval-1', decision: 'allow' },
    })
    expect(output).toEqual([{ jsonrpc: '2.0', id: 9, result: { status: 'accepted' } }])
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
