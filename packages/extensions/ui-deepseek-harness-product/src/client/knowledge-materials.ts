/** Compose folder-first material pages without depending on the navigation tree. */
import { knowledgeDocument, knowledgePage, type KnowledgeDocument, type KnowledgeFolder, type KnowledgePage } from './knowledge-data.ts'

/** Read the document portion of a combined folder/document page.
 * @param request Authorized, cancellable knowledge transport.
 * @param selection Document filters, library, and location.
 * @param folders Independently queried folder page and complete folder count.
 * @param page One-based material page.
 * @param signal Query lifetime.
 * @returns Document rows for this material page and the complete document count.
 */
export async function readMaterialDocuments(request: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>,
  selection: Readonly<Record<string, unknown>>, folders: KnowledgePage<KnowledgeFolder>, page: number,
  signal: AbortSignal): Promise<KnowledgePage<KnowledgeDocument>> {
  const size = 20
  const offset = Math.max(0, (page - 1) * size - folders.total)
  const documentPage = Math.floor(offset / size) + 1
  const skip = offset % size
  const needed = size - folders.items.length
  const read = async (nextPage: number) => knowledgePage(await request('knowledge.documents.list',
    { ...selection, page: nextPage, size }, signal), knowledgeDocument)
  const first = await read(documentPage)
  signal.throwIfAborted()
  let documents = first.items.slice(skip, skip + needed)
  if (documents.length < needed && offset + documents.length < first.total && skip > 0) {
    const second = await read(documentPage + 1)
    signal.throwIfAborted()
    documents = [...documents, ...second.items.slice(0, needed - documents.length)]
  }
  return { items: documents, page, size, total: first.total }
}
