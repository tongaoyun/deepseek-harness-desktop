import { createServer } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorProxy, resolveConnectorProxyPolicy } from '../src/connector-proxy.ts'

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
    await new Promise<void>((resolve, reject) => upstream.close((error) => { if (error) reject(error); else resolve() }))
  })
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind')
  let authorized = true
  const connector = { id: 'erp', version: '1.0.0', status: 'ready', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`,
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
  expect(catalog).toHaveBeenCalledWith(expect.any(AbortSignal), ['erp'])
  connector.version = '1.0.1'
  const changed = await fetch(entry.url, { method: 'POST', headers: entry.headers, body: '{}' })
  expect(changed.status).toBe(409)
  expect(await changed.text()).toContain('Connector version changed')
  expect(requests).toHaveLength(1)
  authorized = false
  const revoked = await fetch(entry.url, { method: 'POST', headers: entry.headers, body: '{}' })
  expect(revoked.status).toBe(502)
  expect(requests).toHaveLength(1)
  expect((await fetch(entry.url)).status).toBe(502)
  await proxy.close()
  await expect(fetch(entry.url)).rejects.toThrow()
})

it('bounds a stalled upstream request by the response-header timeout', async () => {
  const upstream = createServer(() => undefined)
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve, reject) => upstream.close((error) => { if (error) reject(error); else resolve() }))
  })
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  const connector = { id: 'slow', version: '1.0.0', status: 'ready', transport: 'streamable-http', timeoutSeconds: 1,
    url: `http://127.0.0.1:${address.port}/mcp`, headers: {} }
  const proxy = new ConnectorProxy(async () => [connector], undefined, { responseTimeoutMs: 1000, streamIdleTimeoutMs: 1000 })
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

it.each(['idle', 'active'] as const)('bounds idle reads while retaining an %s SSE stream beyond transport deadlines', async (mode) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: first\n\n')
    if (mode === 'idle') return
    let heartbeats = 0
    const timer = setInterval(() => {
      response.write('data: heartbeat\n\n')
      if (++heartbeats === 14) { clearInterval(timer); response.end() }
    }, 100)
    response.once('close', () => { clearInterval(timer) })
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => { resolve() }))
  })
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  const connector = { id: 'stream', version: '1.0.0', status: 'ready', transport: 'streamable-http', timeoutSeconds: 1,
    url: `http://127.0.0.1:${address.port}/mcp`, headers: {} }
  const proxy = new ConnectorProxy(async () => [connector], undefined, { responseTimeoutMs: 1000, streamIdleTimeoutMs: 1000 })
  onTestFinished(() => proxy.close())
  await proxy.start()
  const [entry] = proxy.catalog([connector]) as typeof connector[]
  if (!entry) throw new Error('No relay connector')
  const started = Date.now()
  const response = await fetch(entry.url, { headers: entry.headers })
  if (mode === 'idle') {
    await expect(response.text()).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3500)
  } else {
    expect((await response.text()).match(/data: heartbeat/g)).toHaveLength(14)
    expect(Date.now() - started).toBeGreaterThan(1000)
  }
})

it('validates independently configurable response and idle deadlines', () => {
  expect(resolveConnectorProxyPolicy()).toEqual({ responseTimeoutMs: 30000, streamIdleTimeoutMs: 120000 })
  expect(resolveConnectorProxyPolicy({ responseTimeoutMs: 1000, streamIdleTimeoutMs: 3600000 }))
    .toEqual({ responseTimeoutMs: 1000, streamIdleTimeoutMs: 3600000 })
  for (const invalid of [{ responseTimeoutMs: 0 }, { streamIdleTimeoutMs: 3600001 }, { timeoutSeconds: 1 }]) {
    expect(() => resolveConnectorProxyPolicy(invalid)).toThrow()
  }
})

it('cancels catalog requests when the caller disconnects', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const cancelled = Promise.withResolvers<undefined>()
  const proxy = new ConnectorProxy(async (signal) => {
    entered.resolve(signal)
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => {
      cancelled.resolve(undefined)
      reject(new Error('Catalog request cancelled'))
    }, { once: true }) })
  })
  onTestFinished(() => proxy.close())
  await proxy.start()
  const [entry] = proxy.catalog([{ id: 'pending', transport: 'streamable-http' }]) as { url: string; headers: Record<string, string> }[]
  if (!entry) throw new Error('No relay connector')
  const controller = new AbortController()
  const request = fetch(entry.url, { headers: entry.headers, signal: controller.signal }).catch((error: unknown) => error)
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
  const connector = { id: 'stdio', version: '1.0.0', status: 'ready', transport: 'stdio', visibility: 'PERSONAL' }
  let cleaned = false
  const proxy = new ConnectorProxy(async () => [connector], async (_request, response, _connector, signal) => {
    signal.addEventListener('abort', () => { cancelled.resolve(undefined) }, { once: true })
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
  const connector = { id: 'late', version: '1.0.0', status: 'ready', transport: 'stdio', visibility: 'PERSONAL' }
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
  const request = fetch(entry.url, { headers: entry.headers, signal: controller.signal }).catch((error: unknown) => error)
  onTestFinished(async () => { controller.abort(); await request })
  const signal = await entered.promise
  const cancelled = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
  controller.abort()
  await cancelled
  release.resolve(undefined)
  await proxy.close()
  await request
  expect(serveStdio).not.toHaveBeenCalled()
})

it.each(['idle', 'disconnect', 'shutdown'] as const)(
  'cancels a stalled response reader on %s and awaits transport cleanup', async (mode) => {
    const localFetch = globalThis.fetch
    const entered = Promise.withResolvers<AbortSignal>()
    const cleanup = Promise.withResolvers<undefined>()
    const cancel = vi.fn(() => cleanup.promise)
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; controller.enqueue(new TextEncoder().encode('data: first\n\n')) },
      cancel,
    })
    const forwarding = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (!init?.signal) throw new Error('No upstream cancellation signal')
      entered.resolve(init.signal)
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    const connector = { id: 'stalled', version: '1.0.0', status: 'ready', transport: 'streamable-http',
      url: 'https://connector.invalid/mcp', headers: {} }
    const proxy = new ConnectorProxy(async () => [connector], undefined,
      { responseTimeoutMs: 1000, streamIdleTimeoutMs: 1000 })
    const caller = new AbortController()
    onTestFinished(async () => {
      caller.abort()
      source?.error(new Error('Fixture shutdown'))
      cleanup.resolve(undefined)
      await proxy.close()
      forwarding.mockRestore()
    })
    await proxy.start()
    const [entry] = proxy.catalog([connector]) as typeof connector[]
    if (!entry) throw new Error('No relay connector')
    const response = await localFetch(entry.url, { headers: entry.headers, signal: caller.signal })
    const received = response.text().catch((error: unknown) => error)
    const signal = await entered.promise
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    let closed = false
    let closing: Promise<void> | undefined
    if (mode === 'disconnect') caller.abort()
    if (mode === 'shutdown') closing = proxy.close().then(() => { closed = true })
    await aborted
    await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce() }, { timeout: 500 })
    closing ??= proxy.close().then(() => { closed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    cleanup.resolve(undefined)
    await closing
    expect(body.locked).toBe(false)
    await received
  },
)

it.each(['success', 'failure'] as const)('releases a late response after shutdown with cleanup %s', async (mode) => {
  const localFetch = globalThis.fetch
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const cancel = vi.fn(async () => {
    if (mode === 'failure') throw new Error('Private connector cleanup detail')
  })
  const body = new ReadableStream<Uint8Array>({ cancel })
  const forwarding = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    entered.resolve(undefined)
    await release.promise
    return new Response(body)
  })
  const connector = { id: 'late-http', version: '1.0.0', status: 'ready', transport: 'streamable-http',
    url: 'https://connector.invalid/mcp', headers: {} }
  const proxy = new ConnectorProxy(async () => [connector])
  onTestFinished(async () => { release.resolve(undefined); await proxy.close(); forwarding.mockRestore() })
  await proxy.start()
  const [entry] = proxy.catalog([connector]) as typeof connector[]
  if (!entry) throw new Error('No relay connector')
  const received = localFetch(entry.url, { headers: entry.headers }).catch((error: unknown) => error)
  await entered.promise
  const closing = proxy.close()
  release.resolve(undefined)
  await closing
  await received
  expect(cancel).toHaveBeenCalledOnce()
  expect(body.locked).toBe(false)
})
