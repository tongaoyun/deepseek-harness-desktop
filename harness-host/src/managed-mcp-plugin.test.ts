import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Tool } from '@modelcontextprotocol/client'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  compareConnectorTools,
  connectorRequestOptions,
  diagnoseConnector,
  discoverConnectorTools,
  diagnosticError,
  selectTools,
  toHarnessTool,
  harnessServerName,
  hasEligibleHarnessMcpConnector,
  shouldUseHarnessMcpClient,
  uniqueHarnessToolName,
} from './managed-mcp-plugin.js'

const tools: Tool[] = [
  {
    name: 'sales_summary',
    description: 'Sales',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'order_cancel',
    description: 'Cancel an order',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
]

it.each(['none', 'employee-bearer'] as const)('delivers images and preserves call failures without replay using %s authentication', async (authMode) => {
  vi.stubEnv('XIAOYIN_MCP_TEST_TOKEN', 'test-employee-token')
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  let failed = false
  let unauthorized = false
  let toolCalls = 0
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    let body = ''; for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    if (message.method === 'tools/call') {
      toolCalls++
      if (unauthorized) { response.writeHead(401).end(); return }
    }
    if (message.id === undefined) { response.writeHead(202).end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'image-test', version: '1' } }
      : message.method === 'tools/list' ? { tools }
      : { isError: failed, content: [{ type: 'text', text: failed ? '上游失败' : '结果' }, { type: 'image', mimeType: 'image/png', data: png }] }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const registered = new Map<string, ToolDefinition>()
  const saveImage = vi.fn(async () => ({ attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', width: 1, height: 1, bytes: Buffer.from(png, 'base64').length }))
  let dispose = async () => {}
  try {
    await apply({ attachments: { saveImage }, tools: { register(tool: ToolDefinition) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
      on() { return () => {} }, effect(factory: () => () => Promise<void>) { dispose = factory() },
    } as unknown as Context, { employeeBearerTokenEnv: 'XIAOYIN_MCP_TEST_TOKEN', connectors: [{ id: 'images', name: '图片服务', version: '1', transport: 'streamable-http',
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, authMode, command: '', allowedTools: [], requiredTools: [], readOnlyTools: ['sales_summary'], allowWrite: true, requireWriteApproval: false, required: true,
    }] })
    const tool = registered.get('mcp_images_sales_summary')!
    expect(tool.isConcurrencySafe()).toBe(true)
    expect(registered.get('mcp_images_order_cancel')!.isConcurrencySafe()).toBe(false)
    const exec = { signal: new AbortController().signal } as never
    const value = await tool.execute({}, exec)
    expect(tool.output.render({}, JSON.parse(JSON.stringify(value)))).toEqual([
      { type: 'text', text: '结果' }, { type: 'image', attachment: await saveImage.mock.results[0].value },
    ])
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ data: Buffer.from(png, 'base64'), mediaType: 'image/png' }))
    failed = true
    await expect(tool.execute({}, exec)).rejects.toThrow('上游失败')
    expect(saveImage).toHaveBeenCalledOnce()
    unauthorized = true
    const before = toolCalls
    await expect(registered.get('mcp_images_order_cancel')!.execute({}, exec)).rejects.toThrow('[XY-CONNECTOR-AUTH]')
    expect(toolCalls - before).toBe(1)
    unauthorized = false
    failed = false
    await expect(tool.execute({}, exec)).resolves.toBeDefined()
  } finally { await dispose(); await new Promise<void>((resolve) => server.close(() => resolve())); vi.unstubAllEnvs() }
  expect(registered.size).toBe(0)
})

it('does not let a remote read-only hint bypass product write approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-mcp-policy-'))
  vi.stubEnv('XIAOYIN_OPERATION_JOURNAL', join(directory, 'operations.sqlite'))
  vi.stubEnv('XIAOYIN_OPERATION_SCOPE', 'policy-test')
  let calls = 0
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    let body = ''; for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    if (message.id === undefined) { response.writeHead(202).end(); return }
    if (message.method === 'tools/call') calls++
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'untrusted', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'send_order', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: 'sent' }] }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const registered = new Map<string, ToolDefinition>()
  let policy!: (exec: { name: string; arguments: unknown }, next: () => unknown) => unknown
  let dispose = async () => {}
  try {
    await apply({ attachments: {}, tools: { register(tool: ToolDefinition) { registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
      on(_event: string, handler: typeof policy) { policy = handler; return () => {} },
      effect(factory: () => () => Promise<void>) { dispose = factory() },
    } as unknown as Context, { connectors: [{ id: 'orders', name: '订单', version: '1', transport: 'streamable-http',
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, authMode: 'none', command: '', arguments: [], environment: {}, headers: {},
      allowedTools: [], requiredTools: [], readOnlyTools: [], allowWrite: true, requireWriteApproval: true, required: true,
    }] })
    const name = 'mcp_orders_send_order'
    expect(registered.get(name)?.isConcurrencySafe()).toBe(false)
    expect(await policy({ name, arguments: { orderId: 'one' } }, () => undefined)).toMatchObject({ kind: 'ask' })
    const tool = registered.get(name)!
    const exec = { signal: new AbortController().signal } as never
    await tool.execute({ orderId: 'one' }, exec)
    await tool.execute({ orderId: 'one' }, exec)
    expect(calls).toBe(1)
  } finally { await dispose(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs() }
})

it('uses the configured execution deadline and validates its range', () => {
  expect(connectorRequestOptions({})).toEqual({ timeout: 60000, maxTotalTimeout: 60000 })
  expect(connectorRequestOptions({ timeoutSeconds: 120 })).toEqual({ timeout: 120000, maxTotalTimeout: 120000 })
  for (const timeoutSeconds of [0, 601, 1.5, NaN]) expect(() => connectorRequestOptions({ timeoutSeconds })).toThrow('1–600')
})

describe('managed MCP tool selection', () => {
  it('keeps sanitized official server names collision-safe', () => {
    expect(harnessServerName('sales/crm')).not.toBe(harnessServerName('sales_crm'))
    expect(harnessServerName('sales/crm')).toMatch(/^sales_crm_[a-f0-9]{10}$/)
    expect(harnessServerName('x'.repeat(200)).length).toBeLessThanOrEqual(32)
  })
  it('routes unrestricted non-SSE connectors through the upstream MCP bridge', () => {
    vi.stubEnv('XIAOYIN_MCP_IMPLEMENTATION', 'harness')
    expect(shouldUseHarnessMcpClient({ id: 'github', name: 'GitHub', version: '1', transport: 'streamable-http', url: 'https://example.test/mcp', authMode: 'none', command: '', arguments: [], environment: {}, headers: {}, allowedTools: [], requiredTools: [], allowWrite: true, requireWriteApproval: false, required: false })).toBe(true)
    expect(shouldUseHarnessMcpClient({ id: 'erp', name: 'ERP', version: '1', transport: 'sse', url: 'https://example.test/sse', authMode: 'none', command: '', arguments: [], environment: {}, headers: {}, allowedTools: [], requiredTools: [], allowWrite: true, requireWriteApproval: false, required: false })).toBe(false)
    expect(shouldUseHarnessMcpClient({ id: 'restricted', name: 'Restricted', version: '1', transport: 'streamable-http', url: 'https://example.test/mcp', authMode: 'none', command: '', arguments: [], environment: {}, headers: {}, allowedTools: ['read'], requiredTools: [], allowWrite: true, requireWriteApproval: false, required: false })).toBe(false)
    vi.unstubAllEnvs()
  })

  it('only reports an eligible official MCP path for connectors without product restrictions', () => {
    const connector = { id: 'public', name: 'Public', version: '1', transport: 'streamable-http', url: 'https://example.test/mcp', authMode: 'none', command: '', arguments: [], environment: {}, headers: {}, allowedTools: [], requiredTools: [], allowWrite: true, requireWriteApproval: false, required: false }
    const env = { XIAOYIN_MCP_IMPLEMENTATION: 'harness', XIAOYIN_MCP_CONNECTORS: JSON.stringify([connector]) }
    expect(hasEligibleHarnessMcpConnector(env)).toBe(true)
    expect(hasEligibleHarnessMcpConnector({ ...env, XIAOYIN_MCP_CONNECTORS: '[]' })).toBe(false)
    expect(hasEligibleHarnessMcpConnector({ ...env, XIAOYIN_MCP_CONNECTORS: 'invalid' })).toBe(false)
    expect(hasEligibleHarnessMcpConnector({ ...env, XIAOYIN_OPERATION_JOURNAL: '/tmp/journal' })).toBe(false)
    expect(hasEligibleHarnessMcpConnector({ ...env, XIAOYIN_MCP_CONNECTORS: JSON.stringify([{ ...connector, allowedTools: ['read'], requireWriteApproval: true }]) })).toBe(false)
  })

  it('exposes provider-safe unique names without changing the upstream MCP name', () => {
    const used = new Set<string>()
    const first = uniqueHarnessToolName('github.com', 'repos/list:all', used)
    used.add(first)
    const second = uniqueHarnessToolName('github.com', 'repos/list:all', used)

    expect(first).toBe('mcp_github_com_repos_list_all')
    expect(second).toBe('mcp_github_com_repos_list_all_2')
    expect(first).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('uses only product-declared read tools when writes are disabled', () => {
    expect(selectTools(tools, [], [], false).map((tool) => tool.name)).toEqual([])
    expect(selectTools(tools, [], [], false, 'MCP', ['sales_summary']).map((tool) => tool.name))
      .toEqual(['sales_summary'])
    expect(selectTools(tools, ['sales_summary'], [], false, 'MCP', ['sales_summary']).map((tool) => tool.name))
      .toEqual(['sales_summary'])
    expect(selectTools([{ ...tools[1]!, annotations: { readOnlyHint: true } }], [], [], false, 'MCP', []).map((tool) => tool.name)).toEqual([])
  })

  it('rejects required tools missing from discovery or excluded by policy', () => {
    expect(() => selectTools(tools, ['sales_summary'], ['inventory_risk'], false, 'ERP')).toThrow('inventory_risk')
    expect(() => selectTools(tools, ['order_cancel'], ['order_cancel'], false, 'ERP')).toThrow('order_cancel')
    expect(() => selectTools(tools, ['sales_summary'], ['order_cancel'], true, 'ERP')).toThrow('order_cancel')
  })

  it('includes required write tools when writes are enabled', () => {
    expect(selectTools(tools, ['order_cancel'], ['order_cancel'], true).map((tool) => tool.name))
      .toEqual(['order_cancel'])
  })
})

it('declares a harness-enforced deadline on every connector tool', () => {
  const tool = { name: 'order.intake_diagnose_shop', description: '', inputSchema: {} }
  const connector = { id: 'erp-mcp', name: 'erp-mcp', timeoutSeconds: undefined } as never
  // The MCP client's own timeout does not cover a response stream that stalls,
  // so the harness needs a deadline it enforces itself.
  expect(toHarnessTool({} as never, {} as never, tool as never, connector).timeoutMs).toBe(60_000 + 15_000)
  const patient = { id: 'erp-mcp', name: 'erp-mcp', timeoutSeconds: 300 } as never
  expect(toHarnessTool({} as never, {} as never, tool as never, patient).timeoutMs).toBe(300_000 + 15_000)
})

it('discovers tools across pages and rejects looping cursors or duplicate names', async () => {
  const listTools = vi.fn().mockResolvedValueOnce({ tools: [tools[0]], nextCursor: 'page-2' }).mockResolvedValueOnce({ tools: [tools[1]] })
  expect(await discoverConnectorTools({ listTools } as never, 1000)).toEqual(tools)
  expect(listTools.mock.calls[1][0]).toEqual({ cursor: 'page-2' })
  expect(listTools.mock.calls[0][1]).not.toHaveProperty('cacheMode')
  listTools.mockReset().mockResolvedValue({ tools: [tools[0]] })
  await discoverConnectorTools({ listTools } as never, 1000, true)
  expect(listTools.mock.calls[0][1]).toMatchObject({ cacheMode: 'refresh' })
  listTools.mockReset().mockResolvedValue({ tools: [], nextCursor: 'same' })
  await expect(discoverConnectorTools({ listTools } as never, 1000)).rejects.toThrow('游标重复')
  listTools.mockReset().mockResolvedValue({ tools: [tools[0]], nextCursor: 'more' })
  await expect(discoverConnectorTools({ listTools } as never, 1000)).rejects.toThrow('重复工具')
})

describe('managed MCP diagnostics', () => {
  it('performs a real HTTP handshake and detects outage, recovery and tool drift without calling business tools', async () => {
    let offline = false
    let names = ['sales_summary']
    const methods: string[] = []
    const server = createServer(async (request, response) => {
      if (offline) { response.writeHead(503).end(); return }
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      let body = ''
      for await (const chunk of request) body += chunk
      const message = JSON.parse(body)
      methods.push(message.method)
      if (message.id === undefined) { response.writeHead(202).end(); return }
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'local-acceptance', version: '1' } }
        : { tools: names.map((name) => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })) }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const connector = { id: 'local-test', name: 'Local', version: '1', transport: 'streamable-http' as const, url: `http://127.0.0.1:${address.port}/mcp`, authMode: 'none' as const,
        command: '', arguments: [], environment: {}, headers: {}, allowedTools: ['sales_summary'], requiredTools: [], allowWrite: false, requireWriteApproval: true, required: false }
      expect(await diagnoseConnector(connector, undefined, 1000)).toMatchObject({ status: 'ready', discoveredTools: ['sales_summary'] })
      offline = true
      expect(await diagnoseConnector(connector, undefined, 1000)).toMatchObject({ status: 'unavailable' })
      offline = false; names = ['inventory_summary']
      expect(await diagnoseConnector(connector, undefined, 1000)).toMatchObject({ status: 'drift', missingTools: ['sales_summary'], undeclaredTools: ['inventory_summary'] })
      expect(methods).not.toContain('tools/call')
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
  it('reports missing and undeclared tools without duplicates', () => {
    expect(compareConnectorTools(
      ['inventory_risk', 'order_get', 'order_get'],
      ['sales_summary', 'inventory_risk', 'sales_summary'],
    )).toEqual({
      discoveredTools: ['inventory_risk', 'sales_summary'],
      missingTools: ['order_get'],
      undeclaredTools: ['sales_summary'],
    })
    expect(compareConnectorTools([], ['sales_summary'])).toEqual({
      discoveredTools: ['sales_summary'], missingTools: [], undeclaredTools: [],
    })
  })

  it.each(['initialize', 'tools/list'])('distinguishes authorization failures at %s from outages and verifies recovery', async (blockedMethod) => {
    let status = 401
    const methods: string[] = []
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      let body = ''
      for await (const chunk of request) body += chunk
      const message = JSON.parse(body)
      methods.push(message.method)
      if (message.method === blockedMethod && status !== 200) {
        response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid_token', error_description: 'Authentication required' }))
        return
      }
      if (message.id === undefined) { response.writeHead(202).end(); return }
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'auth-test', version: '1' } }
        : { tools: [] }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const connector = { id: 'auth-test', name: 'Auth', version: '1', transport: 'streamable-http' as const, url: `http://127.0.0.1:${address.port}/mcp`, authMode: 'none' as const,
        command: '', arguments: [], environment: {}, headers: {}, allowedTools: [], requiredTools: [], allowWrite: false, requireWriteApproval: true, required: false }
      expect(await diagnoseConnector(connector, undefined, 1000)).toMatchObject({ status: 'authentication-required', missingTools: [], error: '服务需要登录授权或凭据已失效' })
      status = 403
      expect(await diagnoseConnector(connector, undefined, 1000)).toMatchObject({ status: 'access-denied', error: '当前凭据没有访问权限' })
      status = 503
      expect(await diagnoseConnector(connector, undefined, 1000)).toMatchObject({ status: 'unavailable' })
      status = 200
      expect(await diagnoseConnector(connector, undefined, 1000)).toMatchObject({ status: 'ready' })
      expect(methods).not.toContain('tools/call')
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('returns a bounded unavailable result without invoking a tool', async () => {
    const result = await diagnoseConnector({
      id: 'offline-mcp',
      name: 'Offline MCP',
      version: '1',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:1/mcp',
      authMode: 'none',
      allowedTools: ['sales_summary'],
      requiredTools: ['sales_summary'],
      allowWrite: false,
      required: true,
    }, undefined, 100)

    expect(result).toMatchObject({
      id: 'offline-mcp',
      status: 'unavailable',
      discoveredTools: [],
      missingTools: [],
    })
    expect(result.error).toBeTruthy()
  })

  it('removes credentials, endpoints and control characters from errors', () => {
    const error = diagnosticError(
      new Error('failed http://erp.internal/mcp token-secret\u0007'),
      'token-secret',
    )
    expect(error).toContain('连接器端点')
    expect(error).not.toContain('erp.internal')
    expect(error).not.toContain('token-secret')
    expect(error).not.toContain('\u0007')
    expect(diagnosticError(new Error('header-secret env-secret'), undefined, ['header-secret', 'env-secret']))
      .toBe('[REDACTED] [REDACTED]')
  })
})
