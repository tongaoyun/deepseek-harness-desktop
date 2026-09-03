import { beforeEach, describe, expect, it } from 'vitest'
import { deletePersonalConnector, loadPersonalConnectors, savePersonalConnector } from './extensionSubmissions'
import type { ConnectorCatalogEntry } from './types'

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
})
