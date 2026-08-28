import { describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/client'
import { selectReadOnlyTools, selectTools } from './erp-mcp-plugin.js'

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

describe('ERP MCP tool selection', () => {
  it('registers only explicitly read-only tools', () => {
    expect(selectReadOnlyTools(tools, [], []).map((tool) => tool.name)).toEqual(['sales_summary'])
  })

  it('fails closed when a required tool is missing or mutating', () => {
    expect(() => selectReadOnlyTools(tools, ['sales_summary'], ['inventory_risk']))
      .toThrow('inventory_risk')
    expect(() => selectReadOnlyTools(tools, ['order_cancel'], ['order_cancel']))
      .toThrow('order_cancel')
  })

  it('includes mutating tools only when the expert kit permits ERP writes', () => {
    expect(selectTools(tools, ['order_cancel'], ['order_cancel'], true).map((tool) => tool.name))
      .toEqual(['order_cancel'])
  })
})
