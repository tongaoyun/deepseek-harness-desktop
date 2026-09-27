import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  compareConnectorTools,
  connectorTimeoutMs,
  diagnoseConnector,
  diagnosticError,
  harnessServerName,
  hasEligibleHarnessMcpConnector,
  officialMcpToolName,
  type ManagedConnectorConfig,
} from './managed-mcp-plugin.js'

afterEach(() => vi.unstubAllEnvs())

const listedTools = [
  { name: 'sales_summary', description: 'Sales', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'order_cancel', description: 'Cancel', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
]

function connector(url: string, override: Partial<ManagedConnectorConfig> = {}): ManagedConnectorConfig {
  return {
    id: 'erp-mcp', name: 'ERP', version: '1', transport: 'streamable-http', url,
    authMode: 'none', command: '', arguments: [], environment: {}, headers: {},
    allowedTools: ['sales_summary', 'order_cancel'], requiredTools: [],
    readOnlyTools: ['sales_summary'], allowWrite: true, requireWriteApproval: true, required: true,
    ...override,
  }
}

async function registry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

async function mcpServer(tools = listedTools): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    calls.push(message.method)
    if (message.id === undefined) { response.writeHead(202).end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true }, resources: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : message.method === 'tools/list'
        ? { tools }
        : message.method === 'resources/list'
          ? { resources: [] }
          : { content: [{ type: 'text', text: 'ok' }] }
    response.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, calls }
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe('official MCP policy adapter', () => {
  it('registers only snapshot tools allowed by read-only plan policy under official names', async () => {
    const fixture = await mcpServer()
    const ctx = await registry()
    try {
      const value = connector(fixture.url, { allowWrite: false })
      await apply(ctx, { connectors: [value] })
      const serverName = harnessServerName(value.id)
      expect(ctx.tools.get(officialMcpToolName(serverName, 'sales_summary'))).toBeDefined()
      expect(ctx.tools.get(officialMcpToolName(serverName, 'order_cancel'))).toBeUndefined()
      expect(fixture.calls).toContain('tools/list')
      expect(fixture.calls).not.toContain('tools/call')
    } finally {
      await ctx.fiber.dispose()
      await close(fixture.server)
    }
  })

  it('keeps write tools when writes are enabled and rejects missing required tools at startup', async () => {
    const fixture = await mcpServer()
    const ctx = await registry()
    try {
      const value = connector(fixture.url)
      await apply(ctx, { connectors: [value] })
      expect(ctx.tools.get(officialMcpToolName(harnessServerName(value.id), 'order_cancel'))).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
      await close(fixture.server)
    }

    const missingFixture = await mcpServer([listedTools[0]!])
    const missingContext = await registry()
    try {
      await expect(apply(missingContext, { connectors: [connector(missingFixture.url, {
        allowedTools: ['sales_summary', 'inventory_risk'], requiredTools: ['inventory_risk'],
      })] })).rejects.toMatchObject({ data: { code: 'XY-CONNECTOR' } })
    } finally {
      await missingContext.fiber.dispose()
      await close(missingFixture.server)
    }
  })

  it('diagnoses through dsh-mcp-client without invoking business tools', async () => {
    const fixture = await mcpServer()
    try {
      const result = await diagnoseConnector(connector(fixture.url), undefined, 2_000)
      expect(result).toMatchObject({ status: 'ready', discoveredTools: ['order_cancel', 'sales_summary'], missingTools: [] })
      expect(fixture.calls).not.toContain('tools/call')
    } finally {
      await close(fixture.server)
    }
  })
})

describe('managed MCP contracts', () => {
  it('uses collision-safe official server and tool names', () => {
    expect(harnessServerName('sales/crm')).not.toBe(harnessServerName('sales_crm'))
    expect(harnessServerName('sales/crm')).toMatch(/^sales_crm_[a-f0-9]{10}$/)
    const clean = officialMcpToolName('erp', 'sales_summary')
    const lossy = officialMcpToolName('erp', 'order.read')
    expect(clean).toBe('mcp__erp__sales_summary')
    expect(lossy).toMatch(/^mcp__erp__order_read_[a-f0-9]{12}$/)
  })

  it('validates timeout and reports configured official MCP capability without an implementation switch', () => {
    expect(connectorTimeoutMs({})).toBe(60_000)
    expect(connectorTimeoutMs({ timeoutSeconds: 120 })).toBe(120_000)
    for (const timeoutSeconds of [0, 601, 1.5, NaN]) expect(() => connectorTimeoutMs({ timeoutSeconds })).toThrow('1–600')
    const configured = JSON.stringify([connector('https://example.test/mcp')])
    expect(hasEligibleHarnessMcpConnector({ XIAOYIN_MCP_CONNECTORS: configured })).toBe(true)
    expect(hasEligibleHarnessMcpConnector({ XIAOYIN_MCP_CONNECTORS: '[]' })).toBe(false)
    expect(hasEligibleHarnessMcpConnector({ XIAOYIN_MCP_CONNECTORS: 'invalid' })).toBe(false)
  })

  it('rejects a read-only snapshot that is not part of the immutable allowed tool set', async () => {
    const fixture = await mcpServer()
    const ctx = await registry()
    try {
      await expect(apply(ctx, {
        connectors: [connector(fixture.url, { allowedTools: ['sales_summary'], readOnlyTools: ['order_cancel'] })],
      })).rejects.toMatchObject({ data: { code: 'XY-CONNECTOR' } })
    } finally {
      await ctx.fiber.dispose()
      await close(fixture.server)
    }
  })

  it('compares catalog tools and redacts connector secrets', () => {
    expect(compareConnectorTools(['read', 'write'], ['read', 'other'])).toEqual({
      discoveredTools: ['other', 'read'], missingTools: ['write'], undeclaredTools: ['other'],
    })
    const detail = diagnosticError(new Error('Bearer secret-token\nfailed'), 'secret-token', ['header-secret'])
    expect(detail).not.toContain('secret-token')
    expect(detail).not.toContain('\n')
  })
})
