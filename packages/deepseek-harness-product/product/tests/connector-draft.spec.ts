/** Invalid private connection settings fail before discovery or persistence. */
import { expect, it } from 'vitest'
import { ConnectorDraftSchema } from '../src/connector-draft.ts'

const base = { kind: 'connector', id: 'orders-mcp', version: '1.0.0', name: 'Orders', summary: 'Read orders', category: 'orders' }
it.each([
  { 'Bad Header': 'value' }, { Authorization: 'value\r\nInjected: value' },
  { Authorization: 'first', authorization: 'second' }, { 'X-Token': '中文' },
])('rejects unusable or ambiguous HTTP headers before connecting: %j', (headers) => {
  expect(ConnectorDraftSchema.safeParse({ ...base, transport: 'streamable-http', url: 'https://mcp.example.test', headers }).success).toBe(false)
})
it.each([{ 'BAD=KEY': 'value' }, { 'BAD\0KEY': 'value' }, { TOKEN: 'invalid\0value' }])('rejects environment values that cannot reach a child process: %j', (environment) => {
  expect(ConnectorDraftSchema.safeParse({ ...base, transport: 'stdio', command: 'npx', environment }).success).toBe(false)
})
it('preserves masked secrets and literal stdio values accepted by the native transports', () => {
  expect(ConnectorDraftSchema.parse({ ...base, transport: 'streamable-http', url: 'https://mcp.example.test', headers: { Authorization: '' } }).headers).toEqual({ Authorization: '' })
  expect(ConnectorDraftSchema.parse({ ...base, transport: 'stdio', command: 'npx', arguments: ['literal $VALUE'], environment: { TOKEN: '中文=literal' } }).environment).toEqual({ TOKEN: '中文=literal' })
})
it.each([{ command: 'npx\0invalid' }, { command: 'npx', arguments: ['invalid\0argument'] }])('rejects stdio values that cannot reach a process: %j', (values) => {
  expect(ConnectorDraftSchema.safeParse({ ...base, transport: 'stdio', ...values }).success).toBe(false)
})
