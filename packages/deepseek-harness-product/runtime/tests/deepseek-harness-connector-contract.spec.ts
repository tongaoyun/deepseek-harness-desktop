import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  connectorServerName,
  connectorToolPolicy,
  parseConnectorCatalog,
  hydrateConnectors, snapshotConnector, parseConnectorSnapshots,
} from '../src/deepseek-harness-connector-contract.ts'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client'

const remote = (overrides: Record<string, unknown> = {}) => ({
  id: 'erp', version: '1.0.0', name: 'ERP', transport: 'streamable-http', url: 'https://erp.example/mcp',
  status: 'ready', authMode: 'none',
  arguments: [], environment: {}, headers: {}, tools: [
    { name: 'orders_read', displayName: '查询订单', description: '读取订单', access: 'READ' },
    { name: 'orders_update', displayName: '更新订单', description: '修改订单', access: 'WRITE' },
  ], ...overrides,
})

describe('DeepSeekHarness connector contract', () => {
  it('pins connector versions and refuses changed or versionless execution snapshots', () => {
    const [connector] = parseConnectorCatalog([remote()])
    const snapshot = snapshotConnector(connector!)
    expect(hydrateConnectors([snapshot], [connector!])[0]?.version).toBe('1.0.0')
    expect(() => hydrateConnectors([snapshot], parseConnectorCatalog([remote({ version: '1.0.1' })])))
      .toThrow('Connector version changed')
    const { version: _version, ...old } = snapshot
    expect(() => parseConnectorSnapshots([old])).toThrow('version')
  })
  it('uses only published dependency entry points at runtime', () => {
    const source = readFileSync(new URL('../src/deepseek-harness-connector-contract.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"]@[^'"]+\/src\//)
    expect(source).not.toMatch(/from ['"]@[^'"]+\.ts['"]/) // Runtime bundles must resolve JavaScript package exports.
  })

  it('maps declared connector tools to Harness read and write policy', () => {
    const connectors = parseConnectorCatalog([remote()])
    const serverName = connectorServerName('erp')
    expect(connectorToolPolicy(connectors, publicToolName(serverName, 'orders_read'))).toBe('read-only')
    expect(connectorToolPolicy(connectors, publicToolName(serverName, 'orders_update'))).toBe('write')
    expect(connectorToolPolicy(connectors, `mcp__${serverName}__undeclared`)).toBe('undeclared')
    expect(connectorToolPolicy(connectors, 'read')).toBe('unrelated')
  })

  it.each([
    [remote({ tools: [
      { name: 'orders_read', displayName: '读取', description: '', access: 'READ' },
      { name: 'orders_read', displayName: '读取', description: '', access: 'READ' },
    ] }), 'duplicate tools'],
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
      tools: [
        { name: 'finance.smt_order_amount_explain', displayName: '金额解释', description: '', access: 'READ' },
        { name: rawName, displayName: '长名称', description: '', access: 'WRITE' },
      ],
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

  it('mounts server-proxied authenticated connectors and skips unavailable entries', () => {
    expect(parseConnectorCatalog([remote({ status: 'unavailable', authMode: 'oauth' })])).toEqual([])
    expect(parseConnectorCatalog([remote({ tools: [] })])).toEqual([])
    expect(parseConnectorCatalog([remote({ authMode: 'oauth' })]))
      .toMatchObject([{ id: 'erp', authMode: 'oauth', url: 'https://erp.example/mcp' }])
  })

  it('rejects unsupported connector authentication modes', () => {
    expect(() => parseConnectorCatalog([remote({ authMode: 'session-cookie' })]))
      .toThrow('unsupported connector authentication')
  })
})
