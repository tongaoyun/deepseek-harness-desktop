/** Compose folder-first material pages without depending on the navigation tree. */
import { ProductError } from '@deepseek-harness/product/errors'
import { knowledgeDocument, knowledgePage, type KnowledgeDocument, type KnowledgeFolder, type KnowledgePage } from './knowledge-data.ts'

interface DocumentSelection {
  readonly knowledgeBaseId: string
  readonly folderId?: string | null
  readonly query?: string
  readonly format?: string
  readonly status?: string
}

/** Read the document portion of a combined folder/document page.
 * @param request Authorized, cancellable knowledge transport.
 * @param selection Document filters, library, and location.
 * @param folders Folder page or pending folder read; the first document page loads concurrently.
 * @param page One-based material page.
 * @param signal Query lifetime.
 * @returns Document rows for this material page and the complete document count.
 * @throws Rejects mismatched pages, resource identities, duplicate documents, or inconsistent totals without returning partial rows.
 */
export async function readMaterialDocuments(request: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>,
  selection: DocumentSelection, folders: KnowledgePage<KnowledgeFolder> | Promise<KnowledgePage<KnowledgeFolder>>,
  page: number,
  signal: AbortSignal): Promise<KnowledgePage<KnowledgeDocument>> {
  const size = 20
  const ids = new Set<string>()
  const read = async (nextPage: number) => {
    const result = knowledgePage(await request('knowledge.documents.list', { ...selection, page: nextPage, size }, signal), knowledgeDocument)
    if (result.page !== nextPage || result.size !== size) throw new ProductError('INVALID_SERVER_RESPONSE', 'Mismatched knowledge document page')
    for (const document of result.items) {
      if (document.knowledgeBaseId !== selection.knowledgeBaseId
        || selection.folderId !== undefined && (document.folderId ?? null) !== selection.folderId || ids.has(document.id)) {
        throw new ProductError('INVALID_SERVER_RESPONSE', 'Mismatched or duplicate knowledge document')
      }
      ids.add(document.id)
    }
    return result
  }
  const [folderPage, initial] = await Promise.all([folders, page === 1 ? read(1) : undefined])
  signal.throwIfAborted()
  const offset = Math.max(0, (page - 1) * size - folderPage.total)
  const documentPage = Math.floor(offset / size) + 1
  const skip = offset % size
  const needed = size - folderPage.items.length
  const first = initial ?? await read(documentPage)
  signal.throwIfAborted()
  let documents = first.items.slice(skip, skip + needed)
  if (documents.length < needed && offset + documents.length < first.total && skip > 0) {
    const second = await read(documentPage + 1)
    signal.throwIfAborted()
    if (second.total !== first.total) throw new ProductError('INVALID_SERVER_RESPONSE', 'Knowledge document total changed between pages')
    documents = [...documents, ...second.items.slice(0, needed - documents.length)]
  }
  return { items: documents, page, size, total: first.total }
}
