import { expect, it } from 'vitest'
import { confirmConnectorReleaseReceipt } from '../src/connector-receipts.ts'

it('does not confirm review submission from a draft or another employee or release', () => {
  const target = { id: 'order-mcp', version: '1.0.0', employeeId: 'employee' }
  const receipt = { kind: 'connector', id: target.id, version: target.version,
    creatorEmployeeId: target.employeeId, status: 'SUBMITTED' }
  for (const value of [null, {}, { ...receipt, kind: 'skill' }, { ...receipt, id: 'other-mcp' },
    { ...receipt, version: '2.0.0' }, { ...receipt, creatorEmployeeId: 'other-employee' },
    { ...receipt, status: 'DRAFT' }, { ...receipt, status: 'PUBLISHED' }]) {
    expect(() => { confirmConnectorReleaseReceipt(value, target, true) })
      .toThrow(expect.objectContaining({ code: 'CONNECTOR_OPERATION_UNCONFIRMED', retryable: true }))
  }
  confirmConnectorReleaseReceipt(receipt, target, true)
  confirmConnectorReleaseReceipt({ ...receipt, status: 'DRAFT' }, target)
})
