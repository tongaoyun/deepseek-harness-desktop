import { describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/client'
import { selectTools } from './managed-mcp-plugin.js'

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
    annotations: { readOnlyHint: false },
  },
]

describe('managed MCP tool selection', () => {
  it('uses the server catalog as an explicit allowlist', () => {
    expect(selectTools(tools, [], [], false)).toEqual([])
    expect(selectTools(tools, ['sales_summary'], [], false).map((tool) => tool.name))
      .toEqual(['sales_summary'])
  })

  it('fails closed when a required tool is missing or mutating', () => {
    expect(() => selectTools(tools, ['sales_summary'], ['inventory_risk'], false, 'ERP'))
      .toThrow('inventory_risk')
    expect(() => selectTools(tools, ['order_cancel'], ['order_cancel'], false, 'ERP'))
      .toThrow('order_cancel')
  })

  it('includes mutating tools only when the expert kit permits writes', () => {
    expect(selectTools(tools, ['order_cancel'], ['order_cancel'], true).map((tool) => tool.name))
      .toEqual(['order_cancel'])
  })
})
