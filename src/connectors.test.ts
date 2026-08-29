import { describe, expect, it } from 'vitest'
import { buildRuntimeConnectorCatalog } from './connectors'

describe('runtime connector catalog', () => {
  it('adapts the legacy ERP catalog while preserving desktop built-ins', () => {
    const result = buildRuntimeConnectorCatalog([
      { id: 'erp-mcp', name: 'ERP', summary: '', kind: 'managed-mcp', scope: 'organization',
        status: 'needs-configuration', managed: true, toolNames: ['sales_summary'] },
      { id: 'desktop-office', name: 'Office', summary: '', kind: 'desktop-builtin', scope: 'device',
        status: 'ready', managed: true, toolNames: ['office.xlsx.create'] },
    ], 'http://erp.internal/mcp')

    expect(result[0]).toMatchObject({
      status: 'ready', transport: 'streamable-http', url: 'http://erp.internal/mcp',
      authMode: 'employee-bearer',
    })
    expect(result[1]).toMatchObject({ transport: 'desktop', url: '' })
  })
})
