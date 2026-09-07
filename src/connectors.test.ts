import { describe, expect, it } from 'vitest'
import { buildRuntimeConnectorCatalog } from './connectors'

describe('runtime connector catalog', () => {
  it('does not enable an administratively disabled legacy connector', () => {
    const [runtime] = buildRuntimeConnectorCatalog([{
      id: 'erp-mcp', name: 'ERP', summary: '', category: 'industry-data', kind: 'managed-mcp', scope: 'organization',
      status: 'disabled', managed: true, toolNames: [],
    }], 'http://erp.internal/mcp', ['erp-mcp'])
    expect(runtime.status).toBe('disabled')
  })

  it('marks missing configuration unusable and recovers when values are supplied', () => {
    const catalog = [{ id: 'crm', name: 'CRM', summary: '', category: 'project-management' as const, kind: 'managed-mcp', scope: 'organization',
      status: 'ready' as const, managed: false, transport: 'stdio' as const, command: 'node', toolNames: [], environment: { TOKEN: '' } }]
    expect(buildRuntimeConnectorCatalog(catalog, '', ['crm'])[0].status).toBe('needs-configuration')
    expect(buildRuntimeConnectorCatalog(catalog, '', ['crm'], { crm: { environment: { TOKEN: 'configured' }, headers: {} } })[0].status).toBe('ready')
  })
  it('adapts the legacy ERP catalog while preserving desktop built-ins', () => {
    const result = buildRuntimeConnectorCatalog([
      { id: 'erp-mcp', name: 'ERP', summary: '', category: 'industry-data', kind: 'managed-mcp', scope: 'organization',
        status: 'needs-configuration', managed: true, toolNames: ['sales_summary'] },
      { id: 'desktop-office', name: 'Office', summary: '', category: 'recommended-system', kind: 'desktop-builtin', scope: 'device',
        status: 'ready', managed: true, toolNames: ['office.xlsx.create'] },
    ], 'http://erp.internal/mcp', ['erp-mcp'])

    expect(result[0]).toMatchObject({
      status: 'ready', transport: 'streamable-http', url: 'http://erp.internal/mcp',
      authMode: 'employee-bearer',
      enabled: true,
    })
    expect(result[1]).toMatchObject({ transport: 'desktop', url: '', enabled: false })
  })

  it('hydrates published credential keys only from the current employee local store', () => {
    const [runtime] = buildRuntimeConnectorCatalog([{
      id: 'crm', name: 'CRM', summary: '', category: 'project-management', kind: 'managed-mcp', scope: 'organization',
      status: 'ready', managed: false, version: '1', transport: 'stdio', command: 'node', arguments: ['server.js'],
      url: '', authMode: 'none', toolNames: [], environment: { CRM_TOKEN: '' }, headers: {},
    }], '', ['crm'], { crm: { environment: { CRM_TOKEN: 'local-secret' }, headers: {} } })

    expect(runtime.environment).toEqual({ CRM_TOKEN: 'local-secret' })
    expect(runtime.enabled).toBe(true)
  })
})
