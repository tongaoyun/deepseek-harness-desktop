import { describe, expect, it } from 'vitest'
import { buildConversationKey, parseDingTalkEvent, parseTaskCommand } from './im-runtime.js'

describe('local DingTalk runtime', () => {
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
