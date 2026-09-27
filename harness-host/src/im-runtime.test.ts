import { describe, expect, it, vi } from 'vitest'
import { buildConversationKey, parseDingTalkEvent, parseTaskCommand } from './im-runtime.js'
import { generatedArtifactPath } from './im-runtime.js'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalImRuntime } from './im-runtime.js'
import { EventAck } from 'dingtalk-stream'
import type { HarnessRuntime } from './runtime.js'

describe('local DingTalk runtime', () => {
  it('does not acknowledge a duplicate before its first receipt is durable', async () => {
    const runtime = new LocalImRuntime({} as HarnessRuntime, '')
    let rejectFirst!: (error: Error) => void
    const persist = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject })).mockResolvedValue(undefined)
    const acknowledge = vi.fn()
    const scheduleEvent = vi.fn()
    Object.assign(runtime, { persistSessions: persist, acknowledge, scheduleEvent, configuration: { clientId: 'test-client', accessPolicy: 'open' } })
    const accept = (runtime as unknown as { enqueueMessage(message: unknown, messageId: string): Promise<void> }).enqueueMessage.bind(runtime)
    const message = { specVersion: '1.0', type: 'CALLBACK', headers: { appId: 'app', connectionId: 'connection', contentType: 'application/json', messageId: 'event-1', time: '0', topic: '/v1.0/im/bot/messages/get' },
      data: JSON.stringify({ msgtype: 'text', text: { content: '查询库存' }, senderStaffId: 'staff-1', senderNick: '员工', conversationType: '1', conversationId: 'one', sessionWebhook: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', sessionWebhookExpiredTime: Date.now() + 60_000 }) }
    const first = accept(message, 'receipt-1')
    await accept(message, 'receipt-2')
    expect(acknowledge).toHaveBeenCalledWith('receipt-2', EventAck.LATER)
    rejectFirst(new Error('disk full'))
    await first
    expect(scheduleEvent).not.toHaveBeenCalled()
    await accept(message, 'receipt-3')
    expect(acknowledge).toHaveBeenCalledWith('receipt-3', EventAck.SUCCESS)
    expect(scheduleEvent).toHaveBeenCalledOnce()
  })
  it('exposes paired conversations and allows revoking one without dropping the others', () => {
    const runtime = new LocalImRuntime({} as HarnessRuntime, '')
    Object.assign(runtime, { configuration: { clientId: 'test', accessPolicy: 'pairing', notifyTaskResults: false } })
    runtime.allowPairing('test:private:one')
    expect(runtime.allowPairing('test:group:two').pairedConversations).toEqual(['test:private:one', 'test:group:two'])
    expect(runtime.revokePairing('test:private:one').pairedConversations).toEqual(['test:group:two'])
    expect(runtime.revokePairing('test:private:one').pairedConversations).toEqual(['test:group:two'])
  })
  it('delivers published files using the native stable root ID, not a positional directory number', () => {
    const calls = new Map<string, string>()
    const root = resolve(tmpdir(), 'xiaoyin-im-artifact-fixture')
    const roots = JSON.stringify([{ id: 'local-im-workspace', name: 'IM 工作目录', path: root }])
    const call = { method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/call', data: { callId: 'one', name: 'local_files_publish' } } } }
    const result = imArtifactResult('one', 'local-im-workspace', 'report.csv')
    expect(generatedArtifactPath(call, calls, 'root', roots)).toBeUndefined()
    expect(generatedArtifactPath(result, calls, 'root', roots)).toBe(resolve(root, 'report.csv'))
    expect(calls.size).toBe(0)
    expect(generatedArtifactPath(result, calls, 'root', roots)).toBeUndefined()
  })

  it('does not deliver merely read files, unknown results, failed outputs or child-session outputs', () => {
    const roots = JSON.stringify([{ id: 'local-im-workspace', path: tmpdir() }])
    const calls = new Map<string, string>()
    const call = { method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/call', data: { callId: 'read', name: 'local_files_read_text' } } } }
    generatedArtifactPath(call, calls, 'root', roots)
    expect(generatedArtifactPath(imArtifactResult('read', 'local-im-workspace', 'source.csv'), calls, 'root', roots)).toBeUndefined()
    calls.set('failed', 'local_files_publish')
    expect(generatedArtifactPath(imArtifactResult('failed', 'local-im-workspace', 'report.csv', true), calls, 'root', roots)).toBeUndefined()
    expect(calls.size).toBe(0)
    const child = { ...call, params: { ...call.params, sessionId: 'child', event: { ...call.params.event, data: { callId: 'child', name: 'local_files_publish' } } } }
    generatedArtifactPath(child, calls, 'root', roots)
    expect(calls.size).toBe(0)
    calls.set('outside', 'local_files_publish')
    expect(generatedArtifactPath(imArtifactResult('outside', 'local-im-workspace', '../outside.csv'), calls, 'root', roots)).toBeUndefined()
  })

  it('delivers files declared by the official present tool from the session workspace', () => {
    const root = resolve(tmpdir(), 'xiaoyin-im-present-fixture')
    const roots = JSON.stringify([{ id: 'local-im-workspace', path: root }])
    const calls = new Map<string, string>()
    const call = { method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/call', data: { callId: 'present', name: 'present' } } } }
    const result = imArtifactResult('present', '', '', false, { turn: 1, files: [{ path: 'report.xlsx' }] })
    expect(generatedArtifactPath(call, calls, 'root', roots)).toBeUndefined()
    expect(generatedArtifactPath(result, calls, 'root', roots)).toBe(resolve(root, 'report.xlsx'))
  })
  it('parses in-channel task takeover commands exactly', () => {
    expect(parseTaskCommand('/bind')).toEqual({ kind: 'bind' })
    expect(parseTaskCommand('/bind 2')).toEqual({ kind: 'bind', index: 2 })
    expect(parseTaskCommand('/unbind')).toEqual({ kind: 'unbind' })
    expect(parseTaskCommand('/unbind 2')).toBeUndefined()
    expect(parseTaskCommand('please /bind 2')).toBeUndefined()
  })

  it('normalizes a DingTalk Stream text message without exposing raw payload', () => {
    const event = parseDingTalkEvent({
      specVersion: '1.0', type: 'CALLBACK',
      headers: {
        appId: 'app', connectionId: 'connection', contentType: 'application/json',
        messageId: 'event-1', time: '0', topic: '/v1.0/im/bot/messages/get',
      },
      data: JSON.stringify({
        msgtype: 'text', text: { content: ' 查询库存 ' }, senderStaffId: 'staff-1',
        senderNick: '小王', conversationType: '1', conversationId: 'conversation-1',
        sessionWebhook: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
        sessionWebhookExpiredTime: Date.now() + 60_000,
      }),
    })
    expect(event.text).toBe('查询库存')
    expect(event.conversationType).toBe('private')
    expect(buildConversationKey('client-1', event)).toBe('client-1:private:staff-1')
    expect(event).not.toHaveProperty('raw')
  })

  it('rejects a forged session webhook', () => {
    expect(() => parseDingTalkEvent({
      specVersion: '1.0', type: 'CALLBACK',
      headers: {
        appId: 'app', connectionId: 'connection', contentType: 'application/json',
        messageId: 'event-2', time: '0', topic: '/v1.0/im/bot/messages/get',
      },
      data: JSON.stringify({ msgtype: 'text', text: { content: 'hello' },
        sessionWebhook: 'https://evil.example/steal' }),
    })).toThrow('not trusted')
  })

  it('normalizes a DingTalk document attachment without retaining paths', () => {
    const event = parseDingTalkEvent({
      specVersion: '1.0', type: 'CALLBACK',
      headers: {
        appId: 'app', connectionId: 'connection', contentType: 'application/json',
        messageId: 'event-3', time: '0', topic: '/v1.0/im/bot/messages/get',
      },
      data: JSON.stringify({
        msgtype: 'file', content: JSON.stringify({ downloadCode: 'download-1', fileName: '../库存.xlsx' }),
        senderStaffId: 'staff-1', sessionWebhook: 'https://api.dingtalk.com/robot/reply',
      }),
    })
    expect(event.text).toBe('')
    expect(event.attachment).toEqual({ downloadCode: 'download-1', fileName: '库存.xlsx', kind: 'document' })
  })
})

function imArtifactResult(callId: string, rootId: string, path: string, isError = false, output: Record<string, unknown> = { rootId, path, size: 20 }) {
  return { method: 'session.event', params: { sessionId: 'root', event: { type: 'tool/result', data: { message: { content: [{
    type: 'tool-result', toolCallId: callId, isError,
    content: [{ type: 'text', text: JSON.stringify(output) }],
  }] } } } } }
}
