/** Confirm connector management receipts before publishing local success. */
import { z } from 'zod'
import { ProductError } from '@deepseek-harness/product/errors'

const ReleaseReceipt = z.object({ kind: z.literal('connector'), id: z.string(), version: z.string(),
  creatorEmployeeId: z.string(), status: z.enum(['DRAFT', 'SUBMITTED', 'REJECTED', 'PUBLISHED', 'UNPUBLISHED']) })

/** Require a release receipt for the exact connector version and authenticated owner.
 * @param value Untrusted server response.
 * @param target Connector identity captured before dispatch.
 * @param submitted Whether the request must confirm submission for review.
 * @returns Nothing when the response confirms the requested release operation.
 */
export function confirmConnectorReleaseReceipt(value: unknown,
  target: { readonly id: string; readonly version: string; readonly employeeId: string }, submitted = false): void {
  const receipt = ReleaseReceipt.safeParse(value)
  if (!receipt.success || receipt.data.id !== target.id || receipt.data.version !== target.version
    || receipt.data.creatorEmployeeId !== target.employeeId || submitted && receipt.data.status !== 'SUBMITTED') {
    throw new ProductError('CONNECTOR_OPERATION_UNCONFIRMED', 'Connector release receipt is invalid', true,
      [{ kind: 'connector', id: target.id }])
  }
}

/** Require explicit server acknowledgement before removing device configuration.
 * @param value Untrusted deletion response.
 * @param id Connector selected for deletion.
 * @returns Nothing when the server explicitly confirms deletion.
 */
export function confirmConnectorDeletionReceipt(value: unknown, id: string): void {
  if (value !== true) throw new ProductError('CONNECTOR_OPERATION_UNCONFIRMED', 'Connector deletion is not confirmed', true,
    [{ kind: 'connector', id }])
}
