import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { JsonRpcOutput } from '../harness-host/src/protocol.js'
import { runSessionTurn } from '../harness-host/src/runtime.js'
import { HostServer } from '../harness-host/src/server.js'
import { harnessResponseUpdate, type HarnessNotification } from './harness'
import { RichMessage } from './RichMessage'
import { applyHarnessResponseToMessages } from './streamingMessages'
import type { TaskMessage } from './types'

type HostNotification = {
  method: string
  params: { sessionId: string; event?: { type: string; data: Record<string, unknown> } }
}

describe('Harness Host to rendered chat streaming', () => {
  it('renders several incremental responses before replacing them with the final answer', async () => {
    const answer = '冒泡排序会反复比较相邻元素，在顺序错误时交换它们，直到整个序列有序。'
    const hostEvents: HostNotification[] = [
      hostEvent('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      hostEvent('turn/start', { turn: 2 }),
      hostEvent('assistant/stream', { type: 'start', turn: 2, step: 1 }),
      ...Array.from(answer).map(text => hostEvent('assistant/stream', { type: 'chunk', turn: 2, step: 1, chunk: { type: 'text-delta', text } })),
      hostEvent('assistant/message', { message: { content: [{ type: 'text', text: answer }] } }),
      hostEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const output: JsonRpcOutput[] = []
    let messages: TaskMessage[] = [
      { role: 'user', text: '解释冒泡排序' },
      { role: 'assistant', text: '', pending: true },
    ]
    let responseKey = ''
    const rendered: string[] = []
    const server = new HostServer(streamingRuntime(hostEvents), (value) => {
      output.push(value)
      if (!('method' in value) || value.method !== 'session.notification') return
      const params = value.params as { requestId: number; event: unknown }
      const update = harnessResponseUpdate({ requestId: params.requestId, event: value.params } as HarnessNotification)
      if (!update) return
      const projected = applyHarnessResponseToMessages(messages, update, responseKey)
      messages = projected.messages
      responseKey = projected.responseKey
      rendered.push(renderToStaticMarkup(<RichMessage assistant text={messages.at(-1)?.text ?? ''} />))
    })

    await server.handle({
      jsonrpc: '2.0', id: 7, method: 'session.run',
      params: { prompt: '解释冒泡排序', sessionId: 'session-1' },
    })

    expect(rendered.length).toBeGreaterThan(3)
    expect(new Set(rendered).size).toBeGreaterThan(3)
    expect(messages.at(-1)?.text).toBe(answer)
    expect(rendered.at(-1)).toContain(answer)
    expect(output.at(-1)).toMatchObject({ id: 7, result: { finalResponse: answer } })
  })
})

function streamingRuntime(notifications: HostNotification[]): ConstructorParameters<typeof HostServer>[0] {
  return {
    async health() { return { status: 'ready', runtime: 'test', version: 'test' } },
    async initialize() { return { status: 'initialized', runtime: 'test' } },
    async run(input, onNotification) {
      const sessionId = input.sessionId ?? 'session-1'
      const result = await runSessionTurn(fakeClient(notifications) as never, sessionId, [{ type: 'text', text: input.prompt }], (event) => {
        onNotification(event, sessionId)
      }, 5_000)
      return result
    },
    async close() {},
  }
}

function fakeClient(notifications: HostNotification[]) {
  let index = 0
  return {
    prompt: async () => 'message-2',
    subscribeSessionTree: () => ({
      next: async () => notifications[index++]!,
      close: () => undefined,
    }),
  }
}

function hostEvent(type: string, data: Record<string, unknown>): HostNotification {
  return { method: 'session.event', params: { sessionId: 'session-1', event: { type, data } } }
}
