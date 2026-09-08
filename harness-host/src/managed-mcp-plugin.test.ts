import { describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/client'
import { createServer } from 'node:http'
import {
  compareConnectorTools,
  connectorRequestOptions,
  diagnoseConnector,
  diagnosticError,
  selectTools,
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

it('uses the configured execution deadline and validates its range', () => {
  expect(connectorRequestOptions({})).toEqual({ timeout: 60000, maxTotalTimeout: 60000 })
  expect(connectorRequestOptions({ timeoutSeconds: 120 })).toEqual({ timeout: 120000, maxTotalTimeout: 120000 })
  for (const timeoutSeconds of [0, 601, 1.5, NaN]) expect(() => connectorRequestOptions({ timeoutSeconds })).toThrow('1–600')
})

describe('managed MCP tool selection', () => {
  it('exposes provider-safe unique names without changing the upstream MCP name', () => {
    const used = new Set<string>()
    const first = uniqueHarnessToolName('github.com', 'repos/list:all', used)
    used.add(first)
    const second = uniqueHarnessToolName('github.com', 'repos/list:all', used)

    expect(first).toBe('mcp_github_com_repos_list_all')
    expect(second).toBe('mcp_github_com_repos_list_all_2')
    expect(first).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('uses only annotated read tools when writes are disabled', () => {
    expect(selectTools(tools, [], [], false).map((tool) => tool.name))
      .toEqual(['sales_summary'])
    expect(selectTools(tools, ['sales_summary'], [], false).map((tool) => tool.name))
      .toEqual(['sales_summary'])
  })

  it('treats declared dependencies as guidance rather than a session gate', () => {
    expect(selectTools(tools, ['sales_summary'], ['inventory_risk'], false, 'ERP').map((tool) => tool.name))
      .toEqual(['sales_summary'])
    expect(selectTools(tools, ['order_cancel'], ['order_cancel'], false, 'ERP').map((tool) => tool.name))
      .toEqual([])
  })

  it('keeps MCP tools available regardless of legacy expert-kit write flags', () => {
    expect(selectTools(tools, ['order_cancel'], ['order_cancel'], true).map((tool) => tool.name))
      .toEqual(['order_cancel'])
  })
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
