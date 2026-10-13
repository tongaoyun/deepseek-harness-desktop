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
  onTestFinished(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  })
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
  onTestFinished(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  })
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

it('cancels catalog requests when the caller disconnects', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const cancelled = Promise.withResolvers<undefined>()
  const proxy = new ConnectorProxy(async (signal) => {
    entered.resolve(signal)
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      cancelled.resolve(undefined)
      reject(signal.reason)
    }, { once: true }))
  })
  onTestFinished(() => proxy.close())
  await proxy.start()
  const [entry] = proxy.catalog([{ id: 'pending', transport: 'streamable-http' }]) as { url: string; headers: Record<string, string> }[]
  if (!entry) throw new Error('No relay connector')
  const controller = new AbortController()
  const request = fetch(entry.url, { headers: entry.headers, signal: controller.signal }).catch(error => error)
  onTestFinished(async () => { controller.abort(); await request })
  const signal = await entered.promise
  expect(signal).toBeInstanceOf(AbortSignal)
  controller.abort()
  await cancelled.promise
  expect(signal.aborted).toBe(true)
  await request
})

it('waits for in-flight stdio cleanup before closing and rejects new connections', async () => {
  const entered = Promise.withResolvers<undefined>()
  const cancelled = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const connector = { id: 'stdio', status: 'ready', transport: 'stdio', visibility: 'PERSONAL' }
  let cleaned = false
  const proxy = new ConnectorProxy(async () => [connector], async (_request, response, _connector, signal) => {
    signal.addEventListener('abort', () => cancelled.resolve(undefined), { once: true })
    entered.resolve(undefined)
    response.end('accepted')
    await release.promise
    cleaned = true
  })
  onTestFinished(async () => { release.resolve(undefined); await proxy.close() })
  await proxy.start()
  const [entry] = proxy.catalog([connector]) as { url: string; headers: Record<string, string> }[]
  if (!entry) throw new Error('No relay connector')
  expect(await (await fetch(entry.url, { headers: entry.headers })).text()).toBe('accepted')
  await entered.promise
  let closed = false
  const closing = proxy.close().then(() => { closed = true })
  await cancelled.promise
  await expect(fetch(entry.url)).rejects.toThrow()
  expect(closed).toBe(false)
  release.resolve(undefined)
  await closing
  expect(cleaned).toBe(true)
})

it('does not start a connector after a cancelled catalog returns late', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<undefined>()
  const connector = { id: 'late', status: 'ready', transport: 'stdio', visibility: 'PERSONAL' }
  const serveStdio = vi.fn(async () => undefined)
  const proxy = new ConnectorProxy(async (signal) => {
    entered.resolve(signal)
    await release.promise
    return [connector]
  }, serveStdio)
  onTestFinished(async () => { release.resolve(undefined); await proxy.close() })
  await proxy.start()
  const [entry] = proxy.catalog([connector]) as { url: string; headers: Record<string, string> }[]
  if (!entry) throw new Error('No relay connector')
  const controller = new AbortController()
  const request = fetch(entry.url, { headers: entry.headers, signal: controller.signal }).catch(error => error)
  onTestFinished(async () => { controller.abort(); await request })
  const signal = await entered.promise
  const cancelled = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  controller.abort()
  await cancelled
  release.resolve(undefined)
  await proxy.close()
  await request
  expect(serveStdio).not.toHaveBeenCalled()
})
