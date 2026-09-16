import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { JsonRpcOutput } from '../harness-host/src/protocol.js'
import { runSessionTurn } from '../harness-host/src/runtime.js'
import { HostServer } from '../harness-host/src/server.js'
import { harnessLiveEvent, type HarnessNotification } from './harness'
import { applyLiveEvent } from './conversation/liveText'
import { assistantEntry, lastEntryText, userEntry } from './conversation/testing'
import type { ConversationEntry } from './conversation/types'
import { RichMessage } from './RichMessage'

type HostNotification = {
  method: string
  params: { sessionId: string; event?: { type: string; data: Record<string, unknown> } }
}

describe('Harness Host to rendered chat streaming', () => {
  it('renders several incremental responses before settling on the final answer', async () => {
    const answer = '冒泡排序会反复比较相邻元素，在顺序错误时交换它们，直到整个序列有序。'
    const hostEvents: HostNotification[] = [
      hostEvent('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      hostEvent('turn/start', { turn: 2 }),
      hostEvent('assistant/stream', { type: 'start', turn: 2, step: 1 }),
      ...Array.from(answer).map((text) => hostEvent('assistant/stream', { type: 'chunk', turn: 2, step: 1, chunk: { type: 'text-delta', text } })),
      hostEvent('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: answer }] } }),
      hostEvent('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const output: JsonRpcOutput[] = []
    let entries: ConversationEntry[] = [userEntry('u1', '解释冒泡排序'), assistantEntry('pending', [], {}, 'streaming')]
    const rendered: string[] = []
    const server = new HostServer(streamingRuntime(hostEvents), (value) => {
      output.push(value)
      if (!('method' in value) || value.method !== 'session.notification') return
      const params = value.params as { requestId: number; event: unknown }
      const live = harnessLiveEvent({ requestId: params.requestId, event: value.params } as HarnessNotification)
      if (!live) return
      const next = applyLiveEvent(entries, live)
      if (next === entries) return
      entries = next
      rendered.push(renderToStaticMarkup(<RichMessage text={lastEntryText(entries)} />))
    })

    await server.handle({
      jsonrpc: '2.0', id: 7, method: 'session.run',
      params: { prompt: '解释冒泡排序', sessionId: 'session-1' },
    })

    expect(rendered.length).toBeGreaterThan(3)
    expect(new Set(rendered).size).toBeGreaterThan(3)
    expect(lastEntryText(entries)).toBe(answer)
    expect(rendered.at(-1)).toContain(answer)
    expect(output.at(-1)).toMatchObject({ id: 7, result: { finalResponse: answer } })
  })

  it('keeps every text segment when a tool call lands between them', async () => {
    const hostEvents: HostNotification[] = [
      hostEvent('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      hostEvent('turn/start', { turn: 1 }),
      hostEvent('text-chunks', { turn: 1, step: 1, texts: ['我先读取数据。'] }),
      hostEvent('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我先读取数据。' }] } }),
      hostEvent('tool/call', { turn: 1, step: 2, callId: 'call-1', name: 'local_files_read_text', arguments: '{"path":"a.md"}' }),
      hostEvent('tool/result', { turn: 1, step: 2, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '{}' }] }] } }),
      hostEvent('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: '整理完成。' }] } }),
      hostEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    let entries: ConversationEntry[] = [userEntry('u1', '整理周报'), assistantEntry('pending', [], {}, 'streaming')]
    const output: JsonRpcOutput[] = []
    const server = new HostServer(streamingRuntime(hostEvents), (value) => {
      output.push(value)
      if (!('method' in value) || value.method !== 'session.notification') return
      const params = value.params as { requestId: number; event: unknown }
      const live = harnessLiveEvent({ requestId: params.requestId, event: value.params } as HarnessNotification)
      if (live) entries = applyLiveEvent(entries, live)
    })

    await server.handle({
      jsonrpc: '2.0', id: 8, method: 'session.run',
      params: { prompt: '整理周报', sessionId: 'session-1' },
    })

    const turn = entries.at(-1)
    if (turn?.role !== 'assistant') throw new Error('expected assistant turn')
    expect(turn.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text))
      .toEqual(['我先读取数据。', '整理完成。'])
    expect(turn.status).toBe('completed')
    expect(output.at(-1)).toMatchObject({ id: 8, result: { finalResponse: '整理完成。' } })
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
