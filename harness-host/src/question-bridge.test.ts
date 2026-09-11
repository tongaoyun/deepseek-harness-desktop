import { describe, expect, it } from 'vitest'
import type { JsonRpcOutput } from './protocol.js'
import { QuestionBridge } from './question-bridge.js'

describe('QuestionBridge', () => {
  it('round-trips structured answers over its authenticated loopback endpoint', async () => {
    const output: JsonRpcOutput[] = []
    const bridge = new QuestionBridge((value) => {
      output.push(value)
      if ('method' in value && value.method === 'question.request') {
        const params = value.params as { questionId: string }
        bridge.respond(params.questionId, { answers: [{ id: 'mode', selected: ['安全模式'], custom: '保留备份' }] })
      }
    })
    const endpoint = await bridge.start()
    try {
      expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/question$/)
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ questions: [{ id: 'mode', question: '选择执行方式', options: [{ label: '安全模式' }] }] }),
      })
      expect(await response.json()).toEqual({ answers: [{ id: 'mode', selected: ['安全模式'], custom: '保留备份' }] })
      expect(output[0]).toMatchObject({ method: 'question.request', params: { questions: [{ id: 'mode' }] } })
    } finally {
      await bridge.close()
    }
  })

  it('rejects unauthenticated requests without disclosing the endpoint', async () => {
    const bridge = new QuestionBridge(() => {})
    const endpoint = await bridge.start()
    try {
      expect((await fetch(endpoint.url, { method: 'POST', body: '{}' })).status).toBe(404)
    } finally {
      await bridge.close()
    }
  })
})
