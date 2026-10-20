import { expect, it } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import type { ProductEvent } from '../src/protocol.ts'

const operations = [
  { method: 'connectors.authorization.begin', valid: { connectorId: 'erp', status: 'PENDING', authorizationUrl: 'https://auth.example.test/' } },
  { method: 'connectors.authorization.status', valid: { connectorId: 'erp', status: 'AUTHORIZED' } },
  { method: 'connectors.authorization.revoke', valid: { connectorId: 'erp', status: 'REQUIRED' } },
] as const
const invalidCases = operations.flatMap(operation => [undefined, null, {}, [], { ...operation.valid, connectorId: 'other' },
  { ...operation.valid, status: 'UNKNOWN' }, ...operation.method.endsWith('.begin') ? [
    { ...operation.valid, status: 'AUTHORIZED' }, { ...operation.valid, authorizationUrl: 'file:///private/authorization' },
    { ...operation.valid, authorizationUrl: 'javascript:alert(1)' },
  ] : operation.method.endsWith('.revoke') ? [{ ...operation.valid, status: 'AUTHORIZED' }, { ...operation.valid, status: 'PENDING' }] : [],
].map(value => ({ ...operation, value })))

it.each(invalidCases)('rejects invalid $method responses before publishing a catalog change: $value', async ({ method, value }) => {
  const events: ProductEvent[] = []
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.example.test', sessionToken: 'private-test-session',
    initialSession: { authenticated: true, employeeId: 'employee' },
    fetch: async () => Response.json({ success: true, data: value }),
  })
  bridge.subscribe((event) => { events.push(event) })
  try { await expect(bridge.invoke(method, { id: 'erp' })).rejects.toThrow(); expect(events).toEqual([]) }
  finally { await bridge.dispose() }
})
