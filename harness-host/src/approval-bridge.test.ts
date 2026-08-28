import { describe, expect, it } from 'vitest'
import type { JsonRpcOutput } from './protocol.js'
import { ApprovalBridge } from './approval-bridge.js'

describe('ApprovalBridge', () => {
  it('binds only to loopback and resolves one explicit desktop decision', async () => {
    const output: JsonRpcOutput[] = []
    const bridge = new ApprovalBridge((value) => {
      output.push(value)
      if ('method' in value && value.method === 'approval.request') {
        const params = value.params as { approvalId: string }
        bridge.respond(params.approvalId, 'allow')
      }
    })
    const endpoint = await bridge.start()
    try {
      expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/approval$/)
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'local_files_write_text', reason: '写入 report.md' }),
      })
      expect(await response.json()).toEqual({ outcome: 'allowed-once' })
      expect(output[0]).toMatchObject({ method: 'approval.request', params: { toolName: 'local_files_write_text' } })
    } finally {
      await bridge.close()
    }
  })

  it('does not disclose the endpoint to callers without the bearer secret', async () => {
    const bridge = new ApprovalBridge(() => {})
    const endpoint = await bridge.start()
    try {
      const response = await fetch(endpoint.url, { method: 'POST', body: '{}' })
      expect(response.status).toBe(404)
    } finally {
      await bridge.close()
    }
  })
})
