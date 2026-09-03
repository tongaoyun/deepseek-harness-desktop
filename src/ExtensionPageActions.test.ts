import { describe, expect, it } from 'vitest'
import { parseConnectorJson } from './ExtensionPageActions'

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
})
