import { createServer, type RequestListener } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ConnectorProxy } from '../src/connector-proxy.ts'

interface RelayAddress {
  readonly url: string
  readonly headers: Record<string, string>
}

function address(proxy: ConnectorProxy, connector: object): RelayAddress {
  const [entry] = proxy.catalog([connector]) as RelayAddress[]
  if (!entry) throw new Error('No relay connector')
  return entry
}

async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const location = server.address()
  if (!location || typeof location === 'string') throw new Error('No upstream port')
  return `http://127.0.0.1:${location.port}/mcp`
}

function bodyReader(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!response.body) throw new Error('No stream body')
  const reader = response.body.getReader()
  onTestFinished(async () => {
    try { await reader.cancel().catch(() => undefined) }
    finally { reader.releaseLock() }
  })
  return reader
}

it('revokes old HTTP capabilities and streams on identity changes while retaining same-employee token refresh', async () => {
  const requests: { employee: string; session: string | undefined }[] = []
  const streamClosed = Promise.withResolvers<undefined>()
  let writeStream: ((value: string) => void) | undefined
  const url = await listen((request, response) => {
    requests.push({ employee: String(request.headers['x-fixture-employee']),
      session: typeof request.headers['mcp-session-id'] === 'string' ? request.headers['mcp-session-id'] : undefined })
    if (request.method === 'GET') {
      response.once('close', () => { streamClosed.resolve(undefined) })
      writeStream = (value) => { response.write(`data: ${value}\n\n`) }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      writeStream('A-initial')
    } else {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ employee: request.headers['x-fixture-employee'], revision: request.headers['x-fixture-revision'] }))
    }
  })
  let employee = 'A'
  let revision = 1
  const connector = () => ({ id: 'shared-erp', version: '1.0.0', status: 'ready', transport: 'streamable-http', url,
    headers: { 'x-fixture-employee': employee, 'x-fixture-revision': String(revision) } })
  const proxy = new ConnectorProxy(async () => [connector()])
  const caller = new AbortController()
  onTestFinished(async () => {
    caller.abort()
    await proxy.close()
  })
  await proxy.resetIdentity(employee)
  await proxy.start()
  const old = address(proxy, connector())
  const stream = await fetch(old.url, { headers: old.headers, signal: caller.signal })
  const reader = bodyReader(stream)
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: A-initial\n\n')

  revision = 2
  await proxy.resetIdentity(employee)
  expect(address(proxy, connector()).headers).toEqual(old.headers)
  const refreshed = await fetch(old.url, { method: 'POST', headers: old.headers, body: '{}' })
  expect(await refreshed.json()).toEqual({ employee: 'A', revision: '2' })
  writeStream?.('A-refreshed')
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: A-refreshed\n\n')

  const stopped = reader.read().then(value => value.done, () => true)
  employee = 'B'
  await proxy.resetIdentity(employee)
  await streamClosed.promise
  expect(await stopped).toBe(true)
  const oldRequest = await fetch(old.url, { method: 'POST',
    headers: { ...old.headers, 'mcp-session-id': 'A-session' }, body: '{}' })
  expect(oldRequest.status).toBe(502)
  await oldRequest.text()
  expect(requests).toEqual([{ employee: 'A', session: undefined }, { employee: 'A', session: undefined }])

  const current = address(proxy, connector())
  const accepted = await fetch(current.url, { method: 'POST', headers: current.headers, body: '{}' })
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toEqual({ employee: 'B', revision: '2' })
  await proxy.resetIdentity(undefined)
  await proxy.resetIdentity(employee)
  const afterLogin = address(proxy, connector())
  const stale = await fetch(current.url, { method: 'POST', headers: current.headers, body: '{}' })
  expect(stale.status).toBe(502)
  await stale.text()
  const resumed = await fetch(afterLogin.url, { method: 'POST', headers: afterLogin.headers, body: '{}' })
  expect(await resumed.json()).toEqual({ employee: 'B', revision: '2' })
  expect(requests.filter(request => request.employee === 'B')).toHaveLength(2)
})

it('waits for a cancelled catalog and never forwards its late result under the next identity', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<undefined>()
  const connector = { id: 'late-stdio', version: '1.0.0', status: 'ready', transport: 'stdio' }
  const serveStdio = vi.fn(async () => undefined)
  const proxy = new ConnectorProxy(async (signal) => {
    entered.resolve(signal)
    await release.promise
    return [connector]
  }, serveStdio)
  const caller = new AbortController()
  const requests: Promise<unknown>[] = []
  onTestFinished(async () => {
    caller.abort()
    release.resolve(undefined)
    await proxy.close()
    await Promise.allSettled(requests)
  })
  await proxy.resetIdentity('A')
  await proxy.start()
  const old = address(proxy, connector)
  const request = fetch(old.url, { headers: old.headers, signal: caller.signal })
    .then(response => response.text(), (error: unknown) => error)
  requests.push(request)
  const signal = await entered.promise
  let resetCompleted = false
  const resetting = proxy.resetIdentity('B').then(() => { resetCompleted = true })
  expect(signal.aborted).toBe(true)
  const rejected = await fetch(old.url, { headers: old.headers })
  expect(rejected.status).toBe(502)
  await rejected.text()
  expect(resetCompleted).toBe(false)
  release.resolve(undefined)
  await resetting
  await request
  expect(serveStdio).not.toHaveBeenCalled()
})

it('invalidates capabilities synchronously and joins stdio cleanup before completing an identity reset', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const connector = { id: 'active-stdio', version: '1.0.0', status: 'ready', transport: 'stdio' }
  let cleaned = false
  const proxy = new ConnectorProxy(async () => [connector], async (_request, response, _connector, signal) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ready\n\n')
    const cancelled = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { aborted.resolve(undefined); response.destroy(); resolve() }, { once: true })
    })
    entered.resolve(signal)
    await cancelled
    await release.promise
    cleaned = true
  })
  const caller = new AbortController()
  onTestFinished(async () => {
    caller.abort()
    release.resolve(undefined)
    await proxy.close()
  })
  await proxy.resetIdentity('A')
  await proxy.start()
  const old = address(proxy, connector)
  const response = await fetch(old.url, { headers: old.headers, signal: caller.signal })
  const reader = bodyReader(response)
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: ready\n\n')
  const signal = await entered.promise
  const stopped = reader.read().then(value => value.done, () => true)
  let resetCompleted = false
  const resetting = proxy.resetIdentity('B').then(() => { resetCompleted = true })
  expect(signal.aborted).toBe(true)
  await aborted.promise
  const rejected = await fetch(old.url, { headers: old.headers })
  expect(rejected.status).toBe(502)
  await rejected.text()
  expect(resetCompleted).toBe(false)
  expect(cleaned).toBe(false)
  release.resolve(undefined)
  await resetting
  expect(cleaned).toBe(true)
  expect(await stopped).toBe(true)
})
