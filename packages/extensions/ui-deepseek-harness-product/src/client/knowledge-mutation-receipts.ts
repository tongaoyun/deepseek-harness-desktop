/** Confirm resource-specific write receipts before publishing a successful file operation. */
import { ProductError } from '@deepseek-harness/product/errors'
import { knowledgeDocument } from './knowledge-data.ts'

function unconfirmed(): ProductError {
  return new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Knowledge operation receipt is invalid', true)
}

/** Require the requested document and, for moves, the exact destination.
 * @param action Submitted file operation.
 * @param value Untrusted product IPC response.
 * @param target Captured library, document, and optional move destination.
 * @returns Nothing when the receipt confirms the submitted operation.
 */
export function confirmKnowledgeDocumentMutation(action: 'move' | 'delete' | 'reindex' | 'cancel', value: unknown,
  target: { readonly knowledgeBaseId: string; readonly documentId: string; readonly folderId?: string | null }): void {
  if (action === 'reindex' || action === 'cancel') {
    try {
      const document = knowledgeDocument(value)
      if (document.id !== target.documentId || document.knowledgeBaseId !== target.knowledgeBaseId
        || document.filename.trim() === '' || document.updatedAt.trim() === '' || document.status.trim() === ''
        || action === 'cancel' && document.status !== 'CANCELLED') throw unconfirmed()
    } catch (_error) { throw unconfirmed() }
    return
  }
  if (typeof value !== 'object' || value === null || !('documentId' in value) || value.documentId !== target.documentId) throw unconfirmed()
  if (action === 'move') {
    if (!('moved' in value) || value.moved !== true || !('folderId' in value) || value.folderId !== (target.folderId ?? null)) throw unconfirmed()
  } else if (!('taskId' in value) || typeof value.taskId !== 'string' || value.taskId.trim() === ''
    || !('status' in value) || value.status !== 'DELETING') throw unconfirmed()
}

/** Require acknowledgement of the requested folder; false means it was already absent.
 * @param value Untrusted deletion receipt.
 * @param folderId Folder selected for deletion.
 * @returns Nothing when deletion or prior absence is confirmed.
 */
export function confirmKnowledgeFolderDeletion(value: unknown, folderId: string): void {
  if (typeof value !== 'object' || value === null || !('folderId' in value) || value.folderId !== folderId
    || !('deleted' in value) || typeof value.deleted !== 'boolean') throw unconfirmed()
}
