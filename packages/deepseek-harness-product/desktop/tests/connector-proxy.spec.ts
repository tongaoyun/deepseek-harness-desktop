import { createServer } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorProxy } from '../src/connector-proxy.ts'

it('relays MCP with main-owned credentials, refuses revoked authorization, and closes connections', async () => {
  const requests: string[] = []
  const upstream = createServer((request, response) => {
    requests.push(request.headers.authorization ?? '')
    response.setHeader('mcp-session-id', 'mcp-session')
    response.end('{"jsonrpc":"2.0","id":1,"result":{}}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => { upstream.closeAllConnections(); upstream.close() })
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind')
  let authorized = true
  const connector = { id: 'erp', status: 'ready', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { Authorization: 'Bearer employee-token', 'x-connector-secret': 'private' }, environment: { SECRET: 'private' } }
  const catalog = vi.fn(async () => authorized ? [connector] : [])
  const proxy = new ConnectorProxy(catalog)
  onTestFinished(() => proxy.close())
  await proxy.start()
  const safe = proxy.catalog([connector]) as typeof connector[]
  const entry = safe[0]!
  expect(JSON.stringify(safe)).not.toContain('employee-token')
  expect(JSON.stringify(safe)).not.toContain('private')
  const result = await fetch(entry.url, { method: 'POST', headers: entry.headers, body: '{}' })
  expect(result.status).toBe(200)
  expect(result.headers.get('mcp-session-id')).toBe('mcp-session')
  expect(await result.json()).toMatchObject({ result: {} })
  expect(requests).toEqual(['Bearer employee-token'])
  authorized = false
  const revoked = await fetch(entry.url, { method: 'POST', headers: entry.headers, body: '{}' })
  expect(revoked.status).toBe(502)
  expect(requests).toHaveLength(1)
  expect((await fetch(entry.url)).status).toBe(502)
  await proxy.close()
  await expect(fetch(entry.url)).rejects.toThrow()
})

it('bounds a stalled upstream request by the connector timeout', async () => {
  const upstream = createServer(() => undefined)
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => { upstream.closeAllConnections(); upstream.close() })
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  const connector = { id: 'slow', status: 'ready', transport: 'streamable-http', timeoutSeconds: 1,
    url: `http://127.0.0.1:${address.port}/mcp`, headers: {} }
  const proxy = new ConnectorProxy(async () => [connector])
  onTestFinished(() => proxy.close())
  await proxy.start()
  const [entry] = proxy.catalog([connector]) as typeof connector[]
  if (!entry) throw new Error('No relay connector')
  const started = Date.now()
  const response = await fetch(entry.url, { method: 'POST', headers: entry.headers, body: '{}' })
  expect(response.status).toBe(502)
  expect(Date.now() - started).toBeLessThan(4000)
  expect(await response.text()).toBe('Connector request failed')
})
