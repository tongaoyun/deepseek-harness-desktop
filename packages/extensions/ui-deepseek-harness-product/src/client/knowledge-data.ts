/** Validate credential-free knowledge responses received through product IPC. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useCallback, useEffect, useRef } from 'react'
import { productFailure } from '@deepseek-harness/product/errors'
import { text } from './catalog-shared.tsx'
import { productApi } from './product-api.ts'

/** Document metadata and optional manager-only editable text. */
export interface KnowledgeDocument {
  readonly id: string
  readonly knowledgeBaseId: string
  readonly filename: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly status: string
  readonly chunkCount: number
  readonly failureMessage?: string
  readonly updatedAt: string
  readonly sourceType?: string
  readonly sourceUrl?: string
  readonly manualContent?: string
  /** Detail-only permission projection; list actions use the library's management permission. */
  readonly canManage?: boolean
  readonly folderId?: string | null
  readonly previewMaxBytes?: number
  readonly downloadMaxBytes?: number
  readonly uploadMaxBytes?: number
}

/** Stable product folder identity, distinct from its visible name. */
export interface KnowledgeFolder {
  readonly id: string
  readonly name: string
  readonly parentId: string | null
  readonly updatedAt: string
}

/** One-based server pagination with a total after filtering. */
export interface KnowledgePage<T> { readonly items: readonly T[]; readonly page: number; readonly size: number; readonly total: number }

/** One retrieval passage with its source and document identities. */
export interface KnowledgeSearchResult {
  readonly knowledgeBaseId?: string
  readonly sourceId?: string
  readonly documentId?: string
  readonly knowledgeBaseName?: string
  readonly filename?: string
  readonly locator?: string
  readonly content: string
}

/** Original file bytes without upstream URLs or authorization credentials. */
export interface KnowledgePreviewFile {
  readonly data: Uint8Array<ArrayBuffer>
  readonly mediaType: string
  readonly missingFonts?: readonly string[]
}

/** Identify authoritative access or employee-identity rejection without treating service outages as revocation.
 * @param error Failure returned by a knowledge or organization request.
 * @returns Whether cached knowledge and resource metadata must be removed.
 */
export function isKnowledgeAccessDenied(error: unknown): boolean {
  return ['KNOWLEDGE_ACCESS_REVOKED', 'KNOWLEDGE_ACCESS_DENIED', 'ORGANIZATION_EMPLOYEE_INACTIVE', 'ORGANIZATION_EMPLOYEE_UNMAPPED', 'ORGANIZATION_SOURCE_INVALID']
    .includes(productFailure(error).code)
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid knowledge response')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid knowledge response field')
  return value
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid knowledge response count')
  return value
}

/** Read a document's metadata; text is available only for editable manual documents.
 * @param value Product document response.
 * @returns Validated metadata without credentials.
 */
export function knowledgeDocument(value: unknown): KnowledgeDocument {
  const row = record(value)
  return {
    id: string(row.id), knowledgeBaseId: string(row.knowledgeBaseId), filename: string(row.filename),
    mediaType: string(row.mediaType), sizeBytes: number(row.sizeBytes), status: string(row.status),
    chunkCount: number(row.chunkCount), updatedAt: string(row.updatedAt),
    ...Object.fromEntries(['failureMessage', 'sourceType', 'sourceUrl', 'manualContent'].flatMap(key =>
      typeof row[key] === 'string' ? [[key, row[key]]] : [])),
    ...(typeof row.canManage === 'boolean' ? { canManage: row.canManage } : {}),
    ...(row.folderId === null || typeof row.folderId === 'string' ? { folderId: row.folderId } : {}),
    ...Object.fromEntries(['previewMaxBytes', 'downloadMaxBytes', 'uploadMaxBytes'].flatMap(key =>
      typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] > 0 ? [[key, row[key]]] : [])),
  }
}

/** Validate paginated metadata or content returned by the server.
 * @param value Product page response.
 * @param read Item parser for the page's resource type.
 * @returns Validated page and server total.
 */
export function knowledgePage<T>(value: unknown, read: (entry: unknown) => T): KnowledgePage<T> {
  const page = record(value)
  if (!Array.isArray(page.items)) throw new Error('Invalid knowledge response items')
  return { items: page.items.map(read), page: number(page.page), size: number(page.size), total: number(page.total) }
}

/** Read bounded binary chunks and attempt to close the main-process transfer on completion or failure.
 * @param request The cancellable product transport for this mounted reader.
 * @param payload Stable resource IDs and whether official Office conversion is needed.
 * @param signal Reader cancellation signal.
 * @returns Read-only original or converted bytes without URLs, paths, or credentials.
 * @throws A read failure without waiting for cleanup; cleanup failures are logged separately.
 * Successful reads require a close acknowledgement.
 */
export async function readKnowledgeFile(request: ReturnType<typeof useKnowledgeRequests>,
  payload: { readonly knowledgeBaseId: string; readonly documentId: string; readonly rendered?: boolean },
  signal: AbortSignal): Promise<KnowledgePreviewFile> {
  const transfer = record(await request('knowledge.documents.preview.open', payload, signal))
  const transferId = string(transfer.transferId)
  const close = async () => { await request('knowledge.documents.preview.close', { transferId }) }
  let file: KnowledgePreviewFile
  try {
    const byteLength = number(transfer.byteLength)
    const maxBytes = number(transfer.maxBytes)
    const chunkSize = number(transfer.chunkSize)
    const mediaType = string(transfer.mediaType)
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(byteLength)
      || byteLength > maxBytes || !Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid knowledge preview limit')
    const missingFonts = transfer.missingFonts
    if (missingFonts !== undefined && (!Array.isArray(missingFonts) || missingFonts.some(font => typeof font !== 'string'))) {
      throw new Error('Invalid knowledge preview fonts')
    }
    const data = new Uint8Array(byteLength)
    let offset = 0
    while (offset < byteLength) {
      signal.throwIfAborted()
      const chunk = record(await request('knowledge.documents.preview.read', { transferId, offset }, signal))
      signal.throwIfAborted()
      if (!(chunk.data instanceof Uint8Array) || chunk.offset !== offset || typeof chunk.eof !== 'boolean'
        || chunk.data.byteLength === 0 || chunk.data.byteLength > chunkSize || offset + chunk.data.byteLength > byteLength
        || chunk.eof !== (offset + chunk.data.byteLength === byteLength)) throw new Error('Invalid knowledge preview chunk')
      data.set(chunk.data, offset)
      offset += chunk.data.byteLength
    }
    signal.throwIfAborted()
    file = { data, mediaType, ...(Array.isArray(missingFonts) ? { missingFonts: missingFonts as string[] } : {}) }
  } catch (failure) {
    void close().catch((error: unknown) => { console.warn('Knowledge preview cleanup failed', error) })
    throw failure
  }
  await close()
  signal.throwIfAborted()
  return file
}

/** Read one server-owned folder.
 * @param value Folder response.
 * @returns Folder identity and name.
 */
export function knowledgeFolder(value: unknown): KnowledgeFolder {
  const row = record(value)
  return { id: string(row.id), name: string(row.name), parentId: row.parentId === null ? null : string(row.parentId),
    updatedAt: string(row.updatedAt) }
}

/** Read retrieval passages without treating document text as interface configuration.
 * @param value Retrieval response.
 * @returns Valid passages and their source identities.
 */
export function knowledgeSearchResults(value: unknown): readonly KnowledgeSearchResult[] {
  if (!Array.isArray(value)) throw new Error('Invalid knowledge search response')
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const row = record(entry)
    // Content is allowed to be empty so the reader can explain that the
    // authorized source has no readable body. Identity fields still use the
    // non-empty text helper below.
    const content = typeof row.content === 'string' ? row.content : undefined
    if (content === undefined) return []
    return [{ content, ...Object.fromEntries(['sourceId', 'documentId', 'knowledgeBaseId', 'knowledgeBaseName', 'filename', 'locator']
      .flatMap(key => text(row, key) === undefined ? [] : [[key, text(row, key)]])) }]
  })
}

/** Own request cancellation for one mounted knowledge view.
 * @returns An IPC request function that cancels pending work when the view unloads.
 */
export function useKnowledgeRequests(): (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> {
  const requests = useRef(new Map<string, () => void>())
  useEffect(() => () => {
    for (const cancel of requests.current.values()) cancel()
    requests.current.clear()
  }, [])
  return useCallback(async (method: string, payload: unknown, signal?: AbortSignal) => {
    const api = productApi()
    if (api === undefined) throw new Error('Product transport unavailable')
    if (signal?.aborted) throw new Error('Knowledge request cancelled')
    const id = randomUUID()
    let cancelled = false
    const cancel = () => { if (!cancelled) { cancelled = true; api.cancel(id) } }
    requests.current.set(id, cancel)
    signal?.addEventListener('abort', cancel, { once: true })
    const timeoutMs = ['knowledge.documents.preview.open', 'knowledge.documents.download', 'knowledge.documents.openExternal',
      'knowledge.documents.upload', 'knowledge.documents.upload.select'].includes(method) ? 300_000 : undefined
    try { return await api.invoke(method, payload, id, timeoutMs) }
    finally { signal?.removeEventListener('abort', cancel); requests.current.delete(id) }
  }, [])
}
