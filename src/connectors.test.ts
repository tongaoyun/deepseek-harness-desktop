import { describe, expect, it } from 'vitest'
import { buildRuntimeConnectorCatalog } from './connectors'
import { parseConnectorJson } from './connectorImport'

it('preserves ERP cookie authentication on import and runtime selection without storing cookies', () => {
  const config = { id: 'erp-custom', name: 'ERP', url: 'https://erp.example/mcp', authMode: 'erp-cookie' }
  const entry = parseConnectorJson(JSON.stringify(config))
  expect(buildRuntimeConnectorCatalog([entry], ['erp-custom'])[0]).toMatchObject({ authMode: 'erp-cookie', headers: {}, enabled: true })
  for (const extra of [{ headers: { Cookie: 'secret' } }, { headers: { aUtHoRiZaTiOn: 'secret' } }, { transport: 'stdio', command: 'node' }, { authMode: 'invalid' }]) {
    expect(() => parseConnectorJson(JSON.stringify({ ...config, ...extra }))).toThrow()
  }
})

it('does not accept publisher-supplied read-only classifications', () => {
  const entry = parseConnectorJson(JSON.stringify({ id: 'reports', url: 'https://example.test/mcp', toolNames: ['report', 'send'] }))
  expect(buildRuntimeConnectorCatalog([entry], ['reports'])[0].readOnlyTools).toEqual([])
})

describe('runtime connector catalog', () => {
  it('does not enable incomplete managed connector definitions', () => {
    const [runtime] = buildRuntimeConnectorCatalog([{
      id: 'erp-mcp', name: 'ERP', summary: '', category: 'industry-data', kind: 'managed-mcp', scope: 'organization',
      status: 'ready', managed: true, toolNames: ['sales_summary'],
    }], ['erp-mcp'])
    expect(runtime).toMatchObject({ status: 'needs-configuration', enabled: true })
  })

  it('marks missing configuration unusable and recovers when values are supplied', () => {
    const catalog = [{ id: 'crm', name: 'CRM', summary: '', category: 'project-management' as const, kind: 'managed-mcp', scope: 'organization',
      status: 'ready' as const, managed: false, transport: 'stdio' as const, command: 'node', toolNames: [], environment: { TOKEN: '' } }]
    expect(buildRuntimeConnectorCatalog(catalog, ['crm'])[0].status).toBe('needs-configuration')
    expect(buildRuntimeConnectorCatalog(catalog, ['crm'], { crm: { environment: { TOKEN: 'configured' }, headers: {} } })[0].status).toBe('ready')
  })
  it('requires complete managed connector definitions and treats local tools separately', () => {
    const result = buildRuntimeConnectorCatalog([
      { id: 'erp-mcp', name: 'ERP', summary: '', category: 'industry-data', kind: 'managed-mcp', scope: 'organization',
        status: 'ready', managed: true, transport: 'streamable-http', url: 'http://erp.internal/mcp', authMode: 'employee-bearer', toolNames: ['sales_summary'] },
      { id: 'local-office', name: 'Office', summary: '', category: 'recommended-system', kind: 'local-tool', scope: 'device',
        status: 'ready', managed: true, toolNames: ['store.sales_summary'] },
    ], ['erp-mcp'])

    expect(result[0]).toMatchObject({
      status: 'ready', transport: 'streamable-http', url: 'http://erp.internal/mcp',
      authMode: 'employee-bearer',
      enabled: true,
    })
    expect(result[1]).toMatchObject({ transport: 'streamable-http', status: 'needs-configuration', enabled: false })
  })

  it('hydrates published credential keys only from the current employee local store', () => {
    const [runtime] = buildRuntimeConnectorCatalog([{
      id: 'crm', name: 'CRM', summary: '', category: 'project-management', kind: 'managed-mcp', scope: 'organization',
      status: 'ready', managed: false, version: '1', transport: 'stdio', command: 'node', arguments: ['server.js'],
      url: '', authMode: 'none', toolNames: [], environment: { CRM_TOKEN: '' }, headers: {},
    }], ['crm'], { crm: { environment: { CRM_TOKEN: 'local-secret' }, headers: {} } })

    expect(runtime.environment).toEqual({ CRM_TOKEN: 'local-secret' })
    expect(runtime.enabled).toBe(true)
  })
})
