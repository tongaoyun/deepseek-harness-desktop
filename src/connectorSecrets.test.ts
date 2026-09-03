import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyConnectorSecrets,
  connectorSecretTemplate,
  connectorSecretValues,
  deleteConnectorSecrets,
  loadConnectorSecrets,
  missingConnectorSecretKeys,
  saveConnectorSecrets,
} from './connectorSecrets'
import type { ConnectorCatalogEntry } from './types'

const connector = {
  id: 'erp', name: 'ERP', summary: '', category: 'industry-data', kind: 'managed-mcp', scope: 'organization',
  status: 'ready', managed: false, toolNames: [],
  environment: { ERP_TOKEN: 'secret' }, headers: { Authorization: 'Bearer secret' },
} satisfies ConnectorCatalogEntry

const values = new Map<string, string>()

describe('local connector secrets', () => {
  beforeEach(() => {
    values.clear()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      } },
    })
  })

  it('publishes only key names and hydrates them from local values', () => {
    const template = connectorSecretTemplate(connector)
    expect(template).toMatchObject({ environment: { ERP_TOKEN: '' }, headers: { Authorization: '' } })
    expect(connectorSecretValues(connector)).toEqual({
      environment: { ERP_TOKEN: 'secret' }, headers: { Authorization: 'Bearer secret' },
    })
    expect(missingConnectorSecretKeys(template)).toEqual(['环境变量 ERP_TOKEN', 'Header Authorization'])
    expect(applyConnectorSecrets(template, connectorSecretValues(connector))).toMatchObject(connector)
  })

  it('stores values per employee and removes only the selected connector', () => {
    saveConnectorSecrets('employee-1', 'erp', connectorSecretValues(connector))
    saveConnectorSecrets('employee-1', 'crm', { environment: {}, headers: { Token: 'crm-secret' } })
    expect(loadConnectorSecrets('employee-1').erp.environment.ERP_TOKEN).toBe('secret')
    expect(deleteConnectorSecrets('employee-1', 'erp')).toEqual({
      crm: { environment: {}, headers: { Token: 'crm-secret' } },
    })
    expect(loadConnectorSecrets('employee-2')).toEqual({})
  })
})
