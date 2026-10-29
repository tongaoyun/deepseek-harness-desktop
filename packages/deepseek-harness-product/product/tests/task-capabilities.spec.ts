/** Task receipts are checked before crossing main's authenticated process interface. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { parseTaskCapabilityRequest, parseTaskCapabilityResult } from '../src/protocol.ts'

function receipt(ids = ['policy']) {
  return { kind: 'CURRENT_SESSION', presetId: 'product-task-pinned',
    capabilities: { basePresetId: 'standard', knowledgeBaseIds: ids },
    dependencyChecks: ids.map(reference => ({ kind: 'KNOWLEDGE_BASE', reference, status: 'READY' })) }
}
function fixture(result: unknown) {
  const host = vi.fn(async () => result)
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test',
    sessionToken: 'fixture-token', initialSession: { authenticated: true, employeeId: 'employee', expiresAt: '2099-01-01T00:00:00Z' },
    taskCapabilities: host })
  onTestFinished(() => bridge.dispose())
  return { bridge, host }
}

it.each([
  { knowledgeBaseIds: [42] }, { basePresetId: ' ' }, { knowledgeBaseIds: Array.from({ length: 33 }, (_, i) => `${i}`) },
  { connectorIds: ['erp'] }, { recoverCapabilities: 'yes' },
])('rejects invalid and obsolete task fields before invoking Host (%j)', async (request) => {
  const { bridge, host } = fixture(receipt())
  await expect(bridge.invoke('tasks.capabilities.prepare', request)).rejects.toMatchObject({ code: 'CAPABILITY_REQUEST_INVALID' })
  expect(host).not.toHaveBeenCalled()
})

it.each([
  { kind: 'CURRENT_SESSION', presetId: 'product-task-pinned' },
  { ...receipt(), dependencyChecks: [] },
  { ...receipt(), dependencyChecks: [{ kind: 'KNOWLEDGE_BASE', reference: 'policy', status: 'NOT_CHECKED' }] },
  { ...receipt(), dependencyChecks: [{ kind: 'KNOWLEDGE_BASE', reference: 'other', status: 'READY' }] },
  { ...receipt(), capabilities: { ...receipt().capabilities, unavailable: { code: 'error', message: 'failed', retryable: false, resources: [] } } },
  receipt(['other']),
])('rejects damaged or mismatched Host receipts at main (%j)', async (result) => {
  const { bridge, host } = fixture(result)
  await expect(bridge.invoke('tasks.capabilities.prepare', { sessionId: 'session', knowledgeBaseIds: ['policy'] }))
    .rejects.toMatchObject({ code: 'CAPABILITY_RESPONSE_INVALID' })
  expect(host).toHaveBeenCalledOnce()
})

it('validates task reads without exposing malformed unavailable diagnostics', async () => {
  const { bridge } = fixture({ knowledgeBaseIds: [], unavailable: { message: 'private diagnostic' } })
  await expect(bridge.invoke('tasks.capabilities.read', { sessionId: 'session' })).rejects.toMatchObject({ code: 'CAPABILITY_RESPONSE_INVALID' })
})

it('accepts reordered canonical selections and allows explicit recovery to remove unavailable knowledge', () => {
  const request = parseTaskCapabilityRequest({ sessionId: 'session', knowledgeBaseIds: ['b', 'a', 'a'] })
  expect(parseTaskCapabilityResult(receipt(['a', 'b']), request).capabilities.knowledgeBaseIds).toEqual(['a', 'b'])
  expect(() => parseTaskCapabilityResult(receipt(['a']), request)).toThrow()
  expect(parseTaskCapabilityResult(receipt(['a']), { ...request, recoverCapabilities: true }).capabilities.knowledgeBaseIds).toEqual(['a'])
  expect(() => parseTaskCapabilityResult(receipt(['a', 'other']), { ...request, recoverCapabilities: true })).toThrow()
  expect(() => parseTaskCapabilityResult(receipt(), { basePresetId: 'different' })).toThrow()
})
