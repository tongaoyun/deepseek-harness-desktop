import { describe, expect, it } from 'vitest'
import { resolveDeepSeekHarnessProductConfig } from '../src/deepseek-harness-product-config.ts'

const options = { packaged: true, resourcesPath: '/installed/resources' }
const support = { heartbeatIntervalMs: 300000, reportIntervalMs: 86400000 }
const document = { version: 1, serverUrl: 'http://192.168.2.67:30081/', companyContentRefreshIntervalMs: 60000, support }
const read = (fields: object = {}) => () => JSON.stringify({ ...document, ...fields })

describe('DeepSeekHarness product configuration', () => {
  it('requires a bounded company refresh interval from main-owned configuration', () => {
    for (const interval of [1000, 60000, 3600000]) {
      expect(resolveDeepSeekHarnessProductConfig({ ...options, readFile: read({ companyContentRefreshIntervalMs: interval }) })
        .companyContentRefreshIntervalMs).toBe(interval)
    }
    for (const invalid of [undefined, 0, 999, 3600001, '60000']) {
      expect(() => resolveDeepSeekHarnessProductConfig({ ...options, readFile: read({ companyContentRefreshIntervalMs: invalid }) }))
        .toThrow('Invalid company content refresh interval')
    }
  })
  it('reads MCP deadlines from the main-owned packaged resource', () => {
    const connectorProxy = { responseTimeoutMs: 2000, streamIdleTimeoutMs: 5000 }
    expect(resolveDeepSeekHarnessProductConfig({ ...options, readFile: read({ connectorProxy }) }).connectorProxy)
      .toEqual(connectorProxy)
    expect(() => resolveDeepSeekHarnessProductConfig({ ...options,
      readFile: read({ connectorProxy: { ...connectorProxy, streamIdleTimeoutMs: -1 } }) })).toThrow()
  })
  it('requires bounded main-owned support intervals in the product resource', () => {
    expect(resolveDeepSeekHarnessProductConfig({ ...options, readFile: read() }).support).toEqual(support)
    for (const invalid of [undefined, { ...support, heartbeatIntervalMs: 59999 },
      { ...support, reportIntervalMs: 200000 }, { ...support, reportIntervalMs: 86400001 }]) {
      expect(() => resolveDeepSeekHarnessProductConfig({ ...options, readFile: read({ support: invalid }) }))
        .toThrow('Invalid desktop support policy')
    }
  })
  it('reads the packaged resource and ignores process overrides', () => {
    const reads: string[] = []
    const result = resolveDeepSeekHarnessProductConfig({
      ...options,
      environment: { DEEPSEEK_HARNESS_SERVER_URL: 'https://untrusted.example.test' },
      readFile: (path) => { reads.push(path); return read()() },
    })
    expect(result.serverUrl).toBe('http://192.168.2.67:30081')
    expect(reads).toEqual(['/installed/resources/deepseek-harness/product.json'])
  })

  it('allows development to override only the server origin while retaining resource policies', () => {
    const reads: string[] = []
    const result = resolveDeepSeekHarnessProductConfig({
      packaged: false,
      resourcesPath: '/unused',
      environment: { DEEPSEEK_HARNESS_SERVER_URL: 'https://deepseek-harness.example.test' },
      readFile: (path) => { reads.push(path); return read({ serverUrl: undefined })() },
    })
    expect(result.serverUrl).toBe('https://deepseek-harness.example.test')
    expect(result.support).toEqual(support)
    expect(reads).toHaveLength(1)
    expect(reads[0]).toMatch(/\/resources\/product\.json$/)
  })

  it('keeps independent file and connector policy defaults when their sections are omitted', () => {
    const defaults = resolveDeepSeekHarnessProductConfig({ ...options, readFile: read() })
    const changed = resolveDeepSeekHarnessProductConfig({ ...options, readFile: read({ knowledgeFiles: { maxTransfers: 2 } }) })
    expect(changed.knowledgeFiles).toEqual({ ...defaults.knowledgeFiles, maxTransfers: 2 })
    expect(changed.connectorProxy).toEqual(defaults.connectorProxy)
    expect(() => resolveDeepSeekHarnessProductConfig({ ...options, readFile: read({ knowledgeFiles: null }) })).toThrow()
  })

  it.each(['missing', 'malformed'])('reports an unreadable %s resource before starting the workspace', (kind) => {
    const cause = new Error('missing resource')
    expect(() => resolveDeepSeekHarnessProductConfig({ ...options, readFile: () => {
      if (kind === 'missing') throw cause
      return '{invalid'
    } })).toThrow('unable to read /installed/resources/deepseek-harness/product.json')
  })

  it.each([
    [{ version: 2, serverUrl: 'https://deepseek-harness.example.test' }, 'schema version 1'],
    [{ version: 1, serverUrl: 'file:///tmp/server' }, 'HTTP(S) origin'],
    [{ version: 1, serverUrl: 'https://deepseek-harness.example.test/api' }, 'HTTP(S) origin'],
    [{ version: 1, serverUrl: 'https://user:secret@deepseek-harness.example.test' }, 'HTTP(S) origin'],
  ])('rejects invalid packaged configuration %#', (fields, message) => {
    expect(() => resolveDeepSeekHarnessProductConfig({
      ...options,
      readFile: read(fields),
    })).toThrow(message)
  })
})
