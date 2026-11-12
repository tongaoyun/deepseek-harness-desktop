/** Validate credential-free knowledge responses received through product IPC. */
import { useCallback, useEffect, useRef } from 'react'
import { productFailure } from '@deepseek-harness/product/errors'
import { isKnowledgeResourceId } from '@deepseek-harness/product/protocol'
import { invokeProduct, productApi } from './product-api.ts'
export { parseKnowledgeDocument as knowledgeDocument, type KnowledgeDocument } from '@deepseek-harness/product/protocol'

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
export interface KnowledgePassage {
  readonly knowledgeBaseId: string
  readonly sourceId: string
  readonly documentId: string
  readonly filename: string
  readonly locator: string
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
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid knowledge response count')
  return value
}

/** Validate paginated metadata or content returned by the server.
 * @param value Product page response.
 * @param read Item parser for the page's resource type.
 * @returns Validated page and server total.
 */
export function knowledgePage<T>(value: unknown, read: (entry: unknown) => T): KnowledgePage<T> {
  const page = record(value)
  if (!Array.isArray(page.items)) throw new Error('Invalid knowledge response items')
  const pageNumber = number(page.page)
  const size = number(page.size)
  const total = number(page.total)
  if (pageNumber < 1 || size < 1 || page.items.length > size || page.items.length > total) throw new Error('Invalid knowledge response page')
  return { items: page.items.map(read), page: pageNumber, size, total }
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

/** Read one retrieval passage without changing its original text.
 * @param value Search or source-read response.
 * @param expected Library and optional source and document identities requested by the caller.
 * @returns A complete passage; invalid fields or mismatched identities reject the response.
 * Empty content lets the reader display its empty state.
 */
export function knowledgePassage(value: unknown, expected: {
  readonly knowledgeBaseId: string
  readonly sourceId?: string
  readonly documentId?: string
}): KnowledgePassage {
  const row = record(value)
  const knowledgeBaseId = string(row.knowledgeBaseId), sourceId = string(row.sourceId), documentId = string(row.documentId)
  const filename = string(row.filename), locator = string(row.locator), content = string(row.content)
  if (!isKnowledgeResourceId(knowledgeBaseId) || !isKnowledgeResourceId(sourceId) || !isKnowledgeResourceId(documentId)
    || filename.trim() === '') throw new Error('Invalid knowledge source response')
  if (knowledgeBaseId !== expected.knowledgeBaseId || expected.sourceId !== undefined && sourceId !== expected.sourceId
    || expected.documentId !== undefined && documentId !== expected.documentId) throw new Error('Knowledge source identity changed')
  return { knowledgeBaseId, sourceId, documentId, filename, locator, content }
}

/** Own request cancellation for one mounted knowledge view.
 * @returns Requests that reject on caller cancellation or view unload; transfer cleanup can still run afterward.
 */
export function useKnowledgeRequests(): (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> {
  const requests = useRef(new Set<AbortController>())
  useEffect(() => () => {
    for (const controller of requests.current) controller.abort()
    requests.current.clear()
  }, [])
  return useCallback(async (method: string, payload: unknown, signal?: AbortSignal) => {
    const api = productApi()
    if (api === undefined) throw new Error('Product transport unavailable')
    const controller = new AbortController()
    requests.current.add(controller)
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const timeoutMs = ['knowledge.documents.preview.open', 'knowledge.documents.download', 'knowledge.documents.openExternal',
      'knowledge.documents.upload', 'knowledge.documents.upload.select'].includes(method) ? 300_000 : undefined
    let opening: Promise<unknown> | undefined
    const transport = method === 'knowledge.documents.preview.open' ? {
      ...api,
      invoke(...args: Parameters<typeof api.invoke>) {
        opening = api.invoke(...args)
        return opening
      },
    } : api
    try { return await invokeProduct(transport, method, payload, combined, timeoutMs) }
    finally {
      requests.current.delete(controller)
      // A late open reply still owns a transfer even though the caller has stopped waiting.
      if (combined.aborted) void opening?.then(value =>
        api.invoke('knowledge.documents.preview.close', { transferId: string(record(value).transferId) }), () => undefined)
        .catch((error: unknown) => { console.warn('Knowledge preview cleanup failed', error) })
    }
  }, [])
}
