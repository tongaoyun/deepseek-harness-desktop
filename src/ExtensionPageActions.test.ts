import { describe, expect, it } from 'vitest'
import { parseConnectorJson } from './ExtensionPageActions'
import { parseConnectorImport, persistBundledConnectors } from './connectorImport'

describe('connector JSON import', () => {
  it('accepts a standard mcpServers stdio entry', () => {
    expect(parseConnectorJson(JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', '@example/server'], env: { TOKEN: 'secret' } } } }))).toMatchObject({
      id: 'github', transport: 'stdio', command: 'npx', arguments: ['-y', '@example/server'], environment: { TOKEN: 'secret' },
    })
  })

  it('accepts a streamable HTTP connector object', () => {
    expect(parseConnectorJson(JSON.stringify({ id: 'internal-api', name: '内部 API', transport: 'streamable-http', url: 'http://mcp.internal/mcp' }))).toMatchObject({
      id: 'internal-api', name: '内部 API', transport: 'streamable-http', url: 'http://mcp.internal/mcp',
    })
  })

  it('rejects incomplete configurations', () => {
    expect(() => parseConnectorJson('{"id":"broken"}')).toThrow('command')
  })

  it('honors type aliases and preserves names and configuration for every server', () => {
    const items = parseConnectorImport(JSON.stringify({ mcpServers: {
      '我的日历': { type: 'streamable-http', url: 'https://calendar.example/mcp', headers: { Authorization: 'Bearer secret' } },
      'My Files': { type: 'stdio', command: 'node', args: ['server.js', 'a path with spaces'], env: { KEY: 'value' } },
      api: { type: 'http', name: '内部 API', url: 'https://api.example/mcp' },
    } }))
    expect(items.map((item) => item.connector?.transport)).toEqual(['streamable-http', 'stdio', 'streamable-http'])
    expect(items[0]?.connector).toMatchObject({ name: '我的日历', headers: { Authorization: 'Bearer secret' } })
    expect(items[0]?.connector?.id).toMatch(/^[a-z0-9][a-z0-9-]{1,63}$/)
    expect(parseConnectorJson(JSON.stringify({ name: '我的日历', type: 'streamable-http', url: 'https://calendar.example/mcp' })).id).toBe(items[0]?.connector?.id)
    expect(items[1]?.connector?.arguments).toEqual(['server.js', 'a path with spaces'])
    expect(items[2]?.connector?.name).toBe('内部 API')
  })

  it('reports invalid entries individually without losing valid servers', () => {
    const items = parseConnectorImport(JSON.stringify({ mcpServers: {
      good: { command: 'node' }, broken: null, unknown: { type: 'websocket', url: 'https://example.com' },
      args: { command: 'node', args: 'server.js' }, badUrl: { type: 'streamable-http', url: 'not-a-url' },
    } }))
    expect(items[0]?.connector?.id).toBe('good')
    expect(items.slice(1).every((item) => Boolean(item.error) && !item.connector)).toBe(true)
  })

  it('rejects empty or malformed top-level configurations', () => {
    for (const value of ['null', '[]', '{"mcpServers":[]}', '{"mcpServers":{}}']) {
      expect(() => parseConnectorImport(value)).toThrow()
    }
  })

  it('reports duplicate IDs instead of overwriting entries', () => {
    const items = parseConnectorImport(JSON.stringify({ mcpServers: {
      one: { id: 'same', command: 'node' }, two: { id: 'same', command: 'python' },
    } }))
    expect(items[0]?.connector?.id).toBe('same')
    expect(items[1]?.error).toContain('重复')
    expect(() => parseConnectorJson(JSON.stringify({ mcpServers: { one: { command: 'node' }, two: { command: 'node' } } }))).toThrow('多个服务')
  })

  it('persists new bundled connectors once and reports individual failures', async () => {
    const persisted: Array<{ id: string; readOnlyTools?: string[] }> = []
    const failures = await persistBundledConnectors({ mcpServers: {
      existing: { command: 'node' },
      added: { type: 'streamable-http', url: 'https://mcp.example.com', authMode: 'oauth' },
      broken: {},
    } }, ['existing'], async (connector) => { persisted.push(connector) })
    expect(persisted).toEqual([expect.objectContaining({ id: 'added', readOnlyTools: [] })])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('broken')
  })
})
