import { describe, expect, it } from 'vitest'
import {
  connectorServerName,
  connectorToolPolicy,
  parseConnectorCatalog,
} from '../src/deepseek-harness-connector-contract.ts'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

const remote = (overrides: Record<string, unknown> = {}) => ({
  id: 'erp', name: 'ERP', transport: 'streamable-http', url: 'https://erp.example/mcp',
  status: 'ready', authMode: 'none',
  arguments: [], environment: {}, headers: {}, toolNames: ['orders_read', 'orders_update'],
  readOnlyTools: ['orders_read'], ...overrides,
})

describe('DeepSeekHarness connector contract', () => {
  it('maps declared connector tools to Harness read and write policy', () => {
    const connectors = parseConnectorCatalog([remote()])
    const serverName = connectorServerName('erp')
    expect(connectorToolPolicy(connectors, publicToolName(serverName, 'orders_read'))).toBe('read-only')
    expect(connectorToolPolicy(connectors, publicToolName(serverName, 'orders_update'))).toBe('write')
    expect(connectorToolPolicy(connectors, `mcp__${serverName}__undeclared`)).toBe('undeclared')
    expect(connectorToolPolicy(connectors, 'read')).toBe('unrelated')
  })

  it.each([
    [remote({ toolNames: ['orders_read', 'orders_read'] }), 'duplicate toolNames'],
    [remote({ readOnlyTools: ['missing'] }), 'unknown read-only tool'],
    [remote({ url: 'file:///tmp/mcp' }), 'invalid URL'],
    [remote({ url: 'https://user:pass@erp.example/mcp' }), 'invalid URL'],
    [remote({ url: 'https://erp.example/mcp?token=secret' }), 'invalid URL'],
    [remote({ headers: { 'X-Unsafe': 'ok\r\ninjected: true' } }), 'invalid HTTP header'],
    [{ ...remote(), transport: 'stdio', command: '  ', url: undefined }, 'stdio command'],
  ])('rejects an unsafe catalog (%s)', (entry, message) => {
    expect(() => parseConnectorCatalog([entry])).toThrow(message)
  })

  it('uses the official deterministic normalization for dotted and long MCP names', () => {
    const rawName = 'x'.repeat(64)
    const connectors = parseConnectorCatalog([remote({
      toolNames: ['finance.smt_order_amount_explain', rawName],
      readOnlyTools: ['finance.smt_order_amount_explain'],
    })])
    const serverName = connectorServerName('erp')
    const dotted = publicToolName(serverName, 'finance.smt_order_amount_explain')
    const long = publicToolName(serverName, rawName)
    expect(dotted).toMatch(/^mcp__erp_[0-9a-f]{8}__finance_smt_order_amount_explain_[0-9a-f]{12}$/)
    expect(long).toHaveLength(64)
    expect(connectorToolPolicy(connectors, dotted)).toBe('read-only')
    expect(connectorToolPolicy(connectors, long)).toBe('write')
  })

  it('accepts a valid stdio connector without treating it as a remote MCP URL', () => {
    expect(parseConnectorCatalog([{ ...remote(), transport: 'stdio', command: 'node', url: undefined }]))
      .toMatchObject([{ transport: 'stdio', command: 'node' }])
  })

  it('does not mount unavailable connectors and rejects unsupported authentication', () => {
    expect(parseConnectorCatalog([remote({ status: 'unavailable', authMode: 'oauth' })])).toEqual([])
    expect(parseConnectorCatalog([remote({ toolNames: [], readOnlyTools: [] })])).toEqual([])
    expect(() => parseConnectorCatalog([remote({ authMode: 'oauth' })]))
      .toThrow('requires unsupported authentication oauth')
  })
})
