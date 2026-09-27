import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalImRuntime } from './im-runtime.js'
import type { HarnessRuntime } from './runtime.js'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function fixture(statePath = '', run = vi.fn<HarnessRuntime['run']>().mockResolvedValue({ sessionId: 'root', finalResponse: '报表已生成' })) {
  const runtime = new LocalImRuntime({ run, close: async () => {}, health: async () => ({ status: 'ready', runtime: 'test', version: '1' }), initialize: async () => ({ status: 'ready', runtime: 'test' }) }, statePath)
  const internals = runtime as unknown as {
    processQueuedEvent(queued: ReturnType<typeof queuedEvent>): Promise<void>
    loadSessions(): Promise<void>
    pendingEvents: Map<string, ReturnType<typeof queuedEvent>>
    conversationWork: Map<string, Promise<void>>
    conversations: Map<string, { status: string; lastResponse: string; messages: Array<{ text: string }> }>
  }
  const reply = vi.fn().mockResolvedValue(undefined)
  const sendGeneratedFile = vi.fn().mockResolvedValue(undefined)
  Object.assign(runtime, {
    configuration: { clientId: 'test-client', accessPolicy: 'open' }, connected: true,
    loadAttachmentContext: async () => ({ context: '' }), reply, sendGeneratedFile,
  })
  return { ...internals, internals, run, reply, sendGeneratedFile, runtime }
}

function queuedEvent() {
  return { event: { eventId: 'event-1', text: '生成报表', senderStaffId: 'employee', senderNick: '员工', conversationType: 'private' as const,
    conversationId: 'conversation', conversationTitle: '会话', sessionWebhook: 'test', sessionWebhookExpiredTime: 0 }, attempts: 0 }
}

it('retries a failed text delivery without running the task again', async () => {
  const test = fixture(); const queued = queuedEvent()
  test.internals.pendingEvents.set(queued.event.eventId, queued)
  test.reply.mockRejectedValueOnce(new Error('发送失败'))
  await test.internals.processQueuedEvent(queued)
  expect(test.run).toHaveBeenCalledOnce()
  expect([...test.internals.conversations.values()][0]?.lastResponse).toBe('报表已生成')
  expect(test.runtime.status().conversations[0]).toMatchObject({ status: 'COMPLETED', deliveryStatus: 'SENDING' })
  await test.internals.processQueuedEvent(queued)
  expect(test.run).toHaveBeenCalledOnce()
  expect(test.reply).toHaveBeenCalledTimes(2)
  expect([...test.internals.conversations.values()][0]?.status).toBe('COMPLETED')
  expect(test.internals.pendingEvents.size).toBe(0)
})

it('resumes only unsent files after a restart and retains the generated answer on partial delivery failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-delivery-'))
  try {
    vi.stubEnv('XIAOYIN_LOCAL_FILE_ROOTS', JSON.stringify([{ id: 'local-im-workspace', path: directory }]))
    const run = vi.fn<HarnessRuntime['run']>().mockImplementation(async (_input, notify) => {
      for (const file of ['first.csv', 'second.csv']) {
        notify({ method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/call', data: { callId: file, name: 'local_files_publish' } } } }, 'root')
        notify({ method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/result', data: { message: { content: [{
          type: 'tool-result', toolCallId: file, content: [{ type: 'text', text: JSON.stringify({ rootId: 'local-im-workspace', path: file }) }],
        }] } } } } }, 'root')
      }
      return { sessionId: 'root', finalResponse: '两份报表已生成' }
    })
    const test = fixture(join(directory, 'state.json'), run); const queued = queuedEvent()
    test.internals.pendingEvents.set(queued.event.eventId, queued)
    test.sendGeneratedFile.mockImplementation(async (_target, path) => { if (basename(path) === 'first.csv') throw new Error('上传失败') })
    await test.internals.processQueuedEvent(queued)
    const conversation = [...test.internals.conversations.values()][0]!
    expect(conversation.status).toBe('COMPLETED')
    expect(conversation.lastResponse).toBe('两份报表已生成')
    expect(conversation.messages.some((message) => message.text.includes('first.csv'))).toBe(true)
    expect(conversation.messages.some((message) => message.text === '两份报表已生成')).toBe(true)
    const restored = fixture(join(directory, 'state.json'))
    await restored.internals.loadSessions()
    await restored.internals.processQueuedEvent([...restored.internals.pendingEvents.values()][0]!)
    expect(restored.run).not.toHaveBeenCalled()
    expect(restored.reply).not.toHaveBeenCalled()
    expect(restored.sendGeneratedFile).toHaveBeenCalledOnce()
    expect(restored.sendGeneratedFile.mock.calls[0]![1]).toBe(join(directory, 'first.csv'))
    expect([...restored.internals.conversations.values()][0]?.status).toBe('COMPLETED')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('does not automatically rerun an execution that may already have changed files or external systems', async () => {
  const test = fixture(); const queued = queuedEvent()
  test.run.mockRejectedValue(new Error('执行连接中断'))
  test.internals.pendingEvents.set(queued.event.eventId, queued)
  await test.internals.processQueuedEvent(queued)
  expect(test.run).toHaveBeenCalledOnce()
  expect(test.internals.pendingEvents.size).toBe(0)
  expect([...test.internals.conversations.values()][0]?.lastResponse).toContain('已暂停')
  await test.internals.processQueuedEvent(queued)
  expect(test.run).toHaveBeenCalledOnce()
})

it('retains exhausted deliveries across restart and resumes only sending on explicit retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-exhausted-'))
  try {
    const test = fixture(join(directory, 'state.json')); const queued = queuedEvent()
    test.internals.pendingEvents.set(queued.event.eventId, queued)
    test.reply.mockRejectedValue(new Error('网络不可用'))
    for (let i = 0; i < 3; i++) await test.internals.processQueuedEvent(queued)
    expect(test.run).toHaveBeenCalledOnce()
    expect(test.runtime.status().conversations[0]).toMatchObject({ status: 'COMPLETED', deliveryStatus: 'FAILED', pendingDeliveryCount: 1 })
    // Heartbeats clearing connection errors cannot erase pending delivery state.
    Object.assign(test.runtime, { lastError: undefined })
    expect(test.runtime.status().state).toBe('DEGRADED')
    const restored = fixture(join(directory, 'state.json'))
    await restored.internals.loadSessions()
    const pending = [...restored.internals.pendingEvents.values()][0]!
    await restored.internals.processQueuedEvent(pending)
    expect(restored.reply).not.toHaveBeenCalled()
    const key = restored.runtime.status().conversations[0]!.conversationKey
    await restored.runtime.retryDelivery(key)
    await Promise.all(restored.internals.conversationWork.values())
    expect(restored.run).not.toHaveBeenCalled()
    expect(restored.reply).toHaveBeenCalledOnce()
    expect(restored.internals.pendingEvents.size).toBe(0)
    expect(restored.runtime.status().conversations[0]?.deliveryStatus).toBeUndefined()
    await expect(restored.runtime.retryDelivery(key)).rejects.toThrow('没有等待')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects duplicate retry clicks and does not overwrite a newer task when old delivery completes', async () => {
  const test = fixture(); const queued = queuedEvent()
  test.internals.pendingEvents.set(queued.event.eventId, queued)
  test.reply.mockRejectedValue(new Error('network'))
  for (let i = 0; i < 3; i++) await test.internals.processQueuedEvent(queued)
  const key = test.runtime.status().conversations[0]!.conversationKey
  const conversation = test.internals.conversations.get(key)!
  Object.assign(conversation, { status: 'RUNNING', lastResponse: '较新的任务', sessionId: 'new-session',
    outcome: undefined,
    messages: [...conversation.messages, { id: 'new-event', role: 'user', text: '新任务', createdAt: new Date().toISOString() }] })
  let finish!: () => void
  test.reply.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  await test.runtime.retryDelivery(key)
  await expect(test.runtime.retryDelivery(key)).rejects.toThrow('没有等待')
  finish(); await Promise.all(test.internals.conversationWork.values())
  expect(test.runtime.status().conversations[0]).toMatchObject({ status: 'RUNNING', sessionId: 'new-session', lastResponse: '较新的任务' })
  expect(test.runtime.status().conversations[0]?.outcome).toBeUndefined()
  expect(test.run).toHaveBeenCalledOnce()
})

it('sends generated attachment bytes through a local HTTP receiver and retries only a failed file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-im-http-'))
  const receipts: string[] = []
  let failFirst = true
  const server = createServer(async (request, response) => {
    const buffers: Buffer[] = []
    for await (const chunk of request) buffers.push(Buffer.from(chunk))
    const body = Buffer.concat(buffers)
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/media/upload') {
      const name = body.includes(Buffer.from('first.xlsx')) ? 'first.xlsx' : 'second.xlsx'
      expect(body.includes(Buffer.from('PK'))).toBe(true)
      receipts.push(`upload:${name}`)
      if (name === 'first.xlsx' && failFirst) { failFirst = false; response.writeHead(503); response.end('{}'); return }
      response.end(JSON.stringify({ media_id: name })); return
    }
    const content = JSON.parse(body.toString())
    receipts.push(content.msgKey === 'sampleFile' ? `file:${JSON.parse(content.msgParam).fileName}` : 'text')
    response.end('{}')
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const networkFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string | URL, options: RequestInit) => {
      const parsed = new URL(String(url))
      if (!['api.dingtalk.com', 'oapi.dingtalk.com'].includes(parsed.hostname)) throw new Error('Unexpected destination')
      return networkFetch(`http://127.0.0.1:${port}${parsed.pathname}`, options)
    })
    vi.stubEnv('XIAOYIN_LOCAL_FILE_ROOTS', JSON.stringify([{ id: 'local-im-workspace', path: directory }]))
    for (const name of ['first.xlsx', 'second.xlsx']) await writeFile(join(directory, name), Buffer.from('PK\u0003\u0004synthetic-office-fixture'))
    const run = vi.fn<HarnessRuntime['run']>().mockImplementation(async (_input, notify) => {
      for (const name of ['first.xlsx', 'second.xlsx']) {
        notify({ method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/call', data: { callId: name, name: 'local_files_publish' } } } }, 'root')
        notify({ method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: name, content: [{ type: 'text', text: JSON.stringify({ rootId: 'local-im-workspace', path: name }) }] }] } } } } }, 'root')
      }
      return { sessionId: 'root', finalResponse: '两份合成表格已生成' }
    })
    const test = fixture(join(directory, 'state.json'), run)
    // Use the production protocol and file upload methods; only the destination is redirected locally.
    Reflect.deleteProperty(test.runtime, 'reply'); Reflect.deleteProperty(test.runtime, 'sendGeneratedFile')
    Object.assign(test.runtime, { client: { getAccessToken: async () => 'local-test-token' } })
    const queued = queuedEvent(); queued.event.sessionWebhookExpiredTime = 1
    test.internals.pendingEvents.set(queued.event.eventId, queued)
    await test.internals.processQueuedEvent(queued)
    expect(run).toHaveBeenCalledOnce()
    expect(receipts).toEqual(['text', 'upload:first.xlsx', 'upload:second.xlsx', 'file:second.xlsx', 'upload:first.xlsx', 'file:first.xlsx'])
    expect(test.runtime.status().conversations[0]?.status).toBe('COMPLETED')
    expect(test.internals.pendingEvents.size).toBe(0)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
