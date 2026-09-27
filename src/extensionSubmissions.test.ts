import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deletePersonalConnector,
  loadPersonalConnectors,
  savePersonalConnector,
  saveValidationReport,
  submitConnector,
  type ExtensionValidationReport,
} from './extensionSubmissions'
import type { ConnectorCatalogEntry } from './types'

afterEach(() => vi.unstubAllGlobals())

const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  })
})

const connector = (id: string, version: string): ConnectorCatalogEntry => ({
  id,
  name: id,
  version,
  summary: '测试连接器',
  category: 'developer-tools',
  kind: 'managed-mcp',
  scope: 'PERSONAL',
  status: 'ready',
  managed: false,
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  authMode: 'none',
  toolNames: ['search'],
})

describe('personal connector drafts', () => {
  it('updates one connector in place and preserves other drafts', () => {
    savePersonalConnector('employee-1', connector('first', '1.0.0'))
    savePersonalConnector('employee-1', connector('second', '1.0.0'))
    savePersonalConnector('employee-1', connector('first', '1.0.1'))

    expect(loadPersonalConnectors('employee-1').map((item) => `${item.id}@${item.version}`)).toEqual([
      'first@1.0.1',
      'second@1.0.0',
    ])
  })

  it('deletes only the requested employee draft', () => {
    savePersonalConnector('employee-1', connector('first', '1.0.0'))
    savePersonalConnector('employee-1', connector('second', '1.0.0'))
    savePersonalConnector('employee-2', connector('first', '2.0.0'))

    expect(deletePersonalConnector('employee-1', 'first').map((item) => item.id)).toEqual(['second'])
    expect(loadPersonalConnectors('employee-2')[0].version).toBe('2.0.0')
  })

  it('never persists personal connector values in draft metadata', () => {
    savePersonalConnector('employee-1', {
      ...connector('first', '1.0.0'), headers: { Authorization: 'local-secret' },
    })

    expect(loadPersonalConnectors('employee-1')[0].headers).toEqual({ Authorization: '' })
    expect(values.get('xiaoyin.personal-connectors.employee-1')).not.toContain('local-secret')
    expect([...values.values()].join('')).not.toContain('local-secret')
  })
})

describe('extension validation report api', () => {
  it('saves the structured report under the exact extension coordinate', async () => {
    const report: ExtensionValidationReport = {
      type: 'HARNESS', status: 'PASSED', prompt: '验证订单分析', model: 'qwen3', latencyMs: 42,
      discoveredTools: ['orders.list'],
      steps: [{ kind: 'tool', label: '查询订单', status: 'completed', toolName: 'orders.list' }],
      artifacts: [{ name: '订单报告.md', kind: 'document', sourceTool: 'document.write' }],
      finalResponse: '验证完成', completedAt: '2026-09-03T01:00:00Z',
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(wire(report)), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(saveValidationReport('skill', 'order review', '1.0.0', report, 'employee-7', 'token')).resolves.toEqual(report)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('http://192.168.2.67:30081/api/v1/extension-submissions/skill/order%20review/versions/1.0.0/validation-reports')
    expect(options.headers).toMatchObject({
      'X-Xiaoyin-Employee-Id': 'employee-7', 'X-Requested-With': 'XMLHttpRequest', Authorization: 'Bearer token',
    })
    expect(JSON.parse(options.body)).toEqual(report)
  })

  it('never sends local connector secret values to the control plane', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(wire({ id: 'erp', version: '1.0.0' })), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await submitConnector({
      ...connector('erp', '1.0.0'),
      environment: { ERP_TOKEN: 'env-secret' },
      headers: { Authorization: 'header-secret' },
    }, 'employee-1', 'access-token')

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(payload.environment).toEqual({ ERP_TOKEN: '' })
    expect(payload.headers).toEqual({ Authorization: '' })
    expect(JSON.stringify(payload)).not.toContain('env-secret')
    expect(JSON.stringify(payload)).not.toContain('header-secret')
  })
})

function wire(data: unknown) { return { success: true, data } }
