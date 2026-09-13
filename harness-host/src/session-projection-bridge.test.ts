import { describe, expect, it, vi } from 'vitest'
import { SessionProjectionBridge } from './session-projection-bridge.js'

describe('SessionProjectionBridge', () => {
  it('forwards an authenticated projection update as a JSON-RPC notification', async () => {
    const outputs: unknown[] = []
    const bridge = new SessionProjectionBridge((output) => outputs.push(output))
    const endpoint = await bridge.start()
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', key: 'todo', value: { items: [] }, seq: 4 }),
    })
    expect(response.status).toBe(204)
    expect(outputs).toEqual([{ jsonrpc: '2.0', method: 'session.projection', params: {
      sessionId: 'session-1', key: 'todo', value: { items: [] }, seq: 4,
    } }])
    await bridge.close()
  })

  it('rejects unauthenticated and malformed updates without publishing', async () => {
    const outputs: unknown[] = []
    const bridge = new SessionProjectionBridge((output) => outputs.push(output))
    const endpoint = await bridge.start()
    const unauthorized = await fetch(endpoint.url, { method: 'POST', body: '{}' })
    const malformed = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-1', key: 'todo', value: {}, seq: -2 }),
    })
    expect(unauthorized.status).toBe(404)
    expect(malformed.status).toBe(400)
    expect(outputs).toHaveLength(0)
    await bridge.close()
  })

  it('does not throw when a client disconnects before shutdown', async () => {
    const bridge = new SessionProjectionBridge(vi.fn())
    await bridge.start()
    await expect(bridge.close()).resolves.toBeUndefined()
  })
})
