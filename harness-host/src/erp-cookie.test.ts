import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { ConnectorCredentialBridge, type ConnectorCredentialResult } from './connector-credential-bridge.js'
import { erpCookieFetch } from './erp-cookie-fetch.js'
import { apply, diagnoseConnector, type ManagedConnectorConfig } from './managed-mcp-plugin.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

afterEach(() => vi.unstubAllEnvs())

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

it.each(['streamable-http', 'sse'] as const)('uses current ERP cookies for %s handshake and tools, and stops on logout', async (transport) => {
  let session: ConnectorCredentialResult = { cookie: 'SESSION=first' }
  const cookieRequests: unknown[] = []
  const bridge = new ConnectorCredentialBridge((message) => {
    const params = (message as { params: { requestId: string; connectorId: string; url: string } }).params
    cookieRequests.push(params)
    bridge.respond(params.requestId, session)
  })
  const endpoint = await bridge.start()
  vi.stubEnv('XIAOYIN_ERP_COOKIE_BRIDGE_URL', endpoint.url)
  vi.stubEnv('XIAOYIN_ERP_COOKIE_BRIDGE_TOKEN', endpoint.token)
  const received: Array<{ method: string; cookie?: string; authorization?: string }> = []
  let stream: ServerResponse | undefined
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && transport === 'sse') {
      received.push({ method: 'sse', cookie: req.headers.cookie, authorization: req.headers.authorization })
      stream = res
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: endpoint\ndata: /messages\n\n'); return
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    let body = ''; for await (const chunk of req) body += chunk
    const message = JSON.parse(body)
    received.push({ method: message.method, cookie: req.headers.cookie, authorization: req.headers.authorization })
    if (message.id === undefined) { res.writeHead(202).end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'erp-test', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: '业务结果' }] }
    const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
    if (transport === 'sse') { stream!.write(`event: message\ndata: ${response}\n\n`); res.writeHead(202).end() }
    else res.writeHead(200, { 'content-type': 'application/json' }).end(response)
  })
  const origin = await listen(server)
  const connector: ManagedConnectorConfig = { id: 'erp', name: 'ERP', version: '1', transport, url: `${origin}/mcp`, authMode: 'erp-cookie',
    command: '', arguments: [], environment: {}, headers: { 'X-Client': 'xiaoyin' }, allowedTools: [], requiredTools: [], allowWrite: true, requireWriteApproval: false, required: true }
  let dispose = async () => {}
  const registered = new Map<string, ToolDefinition>()
  try {
    await apply({ tools: { register(tool: ToolDefinition) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
      on() { return () => {} }, effect(factory: () => () => Promise<void>) { dispose = factory() },
    } as unknown as Context, { connectors: [connector] })
    expect(received.some((item) => item.method === 'initialize')).toBe(true)
    expect(received.every((item) => item.cookie === 'SESSION=first' && !item.authorization)).toBe(true)
    session = { cookie: 'SESSION=refreshed' }
    const tool = registered.get('mcp_erp_read')!
    const exec = { signal: new AbortController().signal } as never
    await expect(tool.execute({}, exec)).resolves.toEqual([{ type: 'text', text: '业务结果' }])
    expect(received.at(-1)).toMatchObject({ method: 'tools/call', cookie: 'SESSION=refreshed' })
    session = { status: 401, error: 'logged out' }
    const count = received.length
    await expect(tool.execute({}, exec)).rejects.toThrow()
    expect(received).toHaveLength(count)
    expect((await diagnoseConnector(connector, undefined, 1000)).status).toBe('authentication-required')
    expect(JSON.stringify(cookieRequests)).not.toContain('SESSION=')
  } finally { await dispose(); stream?.end(); await close(server); await bridge.close() }
})

it('blocks credential redirects and unapproved origins, and redacts upstream errors', async () => {
  let cookie = 'SESSION=private-value'
  const bridge = new ConnectorCredentialBridge((message) => {
    bridge.respond((message as { params: { requestId: string } }).params.requestId, { cookie })
  })
  const endpoint = await bridge.start()
  let calls = 0
  let redirect = false
  const other = createServer((_req, res) => { calls++; res.writeHead(200).end() })
  const otherOrigin = await listen(other)
  const server = createServer((_req, res) => {
    if (redirect) res.writeHead(302, { location: otherOrigin }).end()
    else res.writeHead(500).end(cookie)
  })
  const origin = await listen(server)
  const request = erpCookieFetch({ id: 'erp', url: `${origin}/mcp` }, endpoint.url, endpoint.token)
  try {
    expect(await (await request(`${origin}/mcp`)).text()).not.toContain(cookie)
    expect((await request(otherOrigin)).status).toBe(403)
    expect(calls).toBe(0)
    redirect = true
    await expect(request(`${origin}/mcp`)).rejects.toThrow('ERP MCP 请求失败')
    expect(calls).toBe(0)
    const unauthorized = await fetch(endpoint.url, { method: 'POST', headers: { authorization: 'Bearer invalid' }, body: '{}' })
    expect(unauthorized.status).toBe(404)
    cookie = ''
    expect((await request(`${origin}/mcp`)).status).toBe(401)
  } finally { await close(server); await close(other); await bridge.close() }
})

it('rejects cookie mode with static credentials or stdio before connecting', async () => {
  const connector = { id: 'erp', name: 'ERP', version: '1', transport: 'stdio', command: 'node', authMode: 'erp-cookie' } as ManagedConnectorConfig
  expect(await diagnoseConnector(connector, undefined)).toMatchObject({ status: 'unavailable', error: expect.stringContaining('HTTP/SSE') })
  connector.transport = 'streamable-http'; connector.url = 'http://127.0.0.1:1/mcp'; connector.headers = { cOoKiE: 'private-cookie' }
  const result = await diagnoseConnector(connector, undefined)
  expect(result.status).toBe('unavailable')
  expect(result.error).not.toContain('private-cookie')
})
