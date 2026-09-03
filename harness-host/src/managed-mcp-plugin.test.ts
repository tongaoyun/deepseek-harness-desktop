import { describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/client'
import {
  compareConnectorTools,
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

  it('uses every discovered tool when no optional allowlist is configured', () => {
    expect(selectTools(tools, [], [], false).map((tool) => tool.name))
      .toEqual(['sales_summary', 'order_cancel'])
    expect(selectTools(tools, ['sales_summary'], [], false).map((tool) => tool.name))
      .toEqual(['sales_summary'])
  })

  it('treats declared dependencies as guidance rather than a session gate', () => {
    expect(selectTools(tools, ['sales_summary'], ['inventory_risk'], false, 'ERP').map((tool) => tool.name))
      .toEqual(['sales_summary'])
    expect(selectTools(tools, ['order_cancel'], ['order_cancel'], false, 'ERP').map((tool) => tool.name))
      .toEqual(['order_cancel'])
  })

  it('keeps MCP tools available regardless of legacy expert-kit write flags', () => {
    expect(selectTools(tools, ['order_cancel'], ['order_cancel'], true).map((tool) => tool.name))
      .toEqual(['order_cancel'])
  })
})

describe('managed MCP diagnostics', () => {
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
      missingTools: ['sales_summary'],
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
