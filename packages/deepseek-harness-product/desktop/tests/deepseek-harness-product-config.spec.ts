import { describe, expect, it } from 'vitest'
import { resolveDeepSeekHarnessConnectorProxyPolicy, resolveDeepSeekHarnessProductServerUrl, resolveDesktopSupportPolicy } from '../src/deepseek-harness-product-config.ts'

describe('DeepSeekHarness product configuration', () => {
  it('reads MCP deadlines from the main-owned packaged resource', () => {
    const options = { packaged: true, resourcesPath: '/installed/resources', appPath: '/installed/app.asar' }
    const connectorProxy = { responseTimeoutMs: 2000, streamIdleTimeoutMs: 5000 }
    expect(resolveDeepSeekHarnessConnectorProxyPolicy({ ...options, readFile: () => JSON.stringify({ version: 1, connectorProxy }) }))
      .toEqual(connectorProxy)
    expect(() => resolveDeepSeekHarnessConnectorProxyPolicy({ ...options,
      readFile: () => JSON.stringify({ version: 1, connectorProxy: { ...connectorProxy, streamIdleTimeoutMs: -1 } }) })).toThrow()
    expect(() => resolveDeepSeekHarnessConnectorProxyPolicy({ ...options, readFile: () => JSON.stringify({ version: 2 }) }))
      .toThrow('Invalid product configuration')
  })
  it('requires bounded main-owned support intervals in the product resource', () => {
    const options = { packaged: true, resourcesPath: '/installed/resources', appPath: '/installed/app.asar' }
    const support = { heartbeatIntervalMs: 300000, reportIntervalMs: 86400000 }
    expect(resolveDesktopSupportPolicy({ ...options, readFile: () => JSON.stringify({ version: 1, support }) })).toEqual(support)
    for (const invalid of [undefined, { ...support, heartbeatIntervalMs: 59999 },
      { ...support, reportIntervalMs: 200000 }, { ...support, reportIntervalMs: 86400001 }]) {
      expect(() => resolveDesktopSupportPolicy({ ...options, readFile: () => JSON.stringify({ version: 1, support: invalid }) }))
        .toThrow('Invalid desktop support policy')
    }
  })
  it('reads the packaged resource and ignores process overrides', () => {
    const reads: string[] = []
    const result = resolveDeepSeekHarnessProductServerUrl({
      packaged: true,
      resourcesPath: '/installed/resources',
      appPath: '/installed/app.asar',
      environment: { DEEPSEEK_HARNESS_SERVER_URL: 'https://untrusted.example.test' },
      readFile: (path) => { reads.push(path); return JSON.stringify({ version: 1, serverUrl: 'http://192.168.2.67:30081/' }) },
    })
    expect(result).toBe('http://192.168.2.67:30081')
    expect(reads).toEqual(['/installed/resources/deepseek-harness/product.json'])
  })

  it('allows an unpackaged development override without reading the resource', () => {
    const result = resolveDeepSeekHarnessProductServerUrl({
      packaged: false,
      resourcesPath: '/unused',
      appPath: '/workspace/apps/desktop',
      environment: { DEEPSEEK_HARNESS_SERVER_URL: 'https://deepseek-harness.example.test' },
      readFile: () => { throw new Error('must not read') },
    })
    expect(result).toBe('https://deepseek-harness.example.test')
  })

  it.each([
    [{ version: 2, serverUrl: 'https://deepseek-harness.example.test' }, 'schema version 1'],
    [{ version: 1, serverUrl: 'file:///tmp/server' }, 'HTTP(S) origin'],
    [{ version: 1, serverUrl: 'https://deepseek-harness.example.test/api' }, 'HTTP(S) origin'],
    [{ version: 1, serverUrl: 'https://user:secret@deepseek-harness.example.test' }, 'HTTP(S) origin'],
  ])('rejects invalid packaged configuration %#', (document, message) => {
    expect(() => resolveDeepSeekHarnessProductServerUrl({
      packaged: true,
      resourcesPath: '/installed/resources',
      appPath: '/installed/app.asar',
      readFile: () => JSON.stringify(document),
    })).toThrow(message)
  })
})
