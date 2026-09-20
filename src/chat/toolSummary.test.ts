import { describe, expect, it } from 'vitest'
import { toolDisplayLabel } from './toolSummary'

describe('toolSummary', () => {
  it('hides the MCP connector id from connector tool labels', () => {
    expect(toolDisplayLabel({
      kind: 'tool', id: 'call-1', toolName: 'mcp_erp-mcp_order_intake_diagnose_shop',
      status: 'running', startedAt: '', label: 'mcp_erp-mcp_order_intake_diagnose_shop',
    })).toBe('查询店铺订单概况')
  })

  it('keeps a generic Chinese label for unknown connector operations', () => {
    expect(toolDisplayLabel({
      kind: 'tool', id: 'call-2', toolName: 'mcp_erp-mcp_custom_read',
      status: 'completed', startedAt: '', label: 'mcp_erp-mcp_custom_read',
    })).toBe('调用连接器工具')
  })
})
