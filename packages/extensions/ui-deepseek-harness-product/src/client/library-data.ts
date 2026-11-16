import { useCallback, useEffect, useRef } from 'react'
import { z } from 'zod'
import { LibraryEntrySchema, LibrarySelectionSchema, type LibraryEntry } from '@deepseek-harness/product/library'
import type { DocumentPreviewFile } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { invokeProduct, productApi } from './product-api.ts'
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid file response')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid file response')
  return value
}
function number(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Invalid file response')
  return value
}
/** Resolve a folder's path within its authorized library, rejecting cycles and mismatched replies.
 * @param request Cancellable metadata transport.
 * @param entry Folder whose ancestors are needed.
 * @param signal Owning navigation lifetime.
 * @returns Root-to-folder breadcrumbs, including the supplied folder.
 */
export async function readLibraryTrail(
  request: ReturnType<typeof useLibraryRequests>, entry: LibraryEntry, signal: AbortSignal,
): Promise<readonly LibraryEntry[]> {
  const ancestors = [entry]
  const visited = new Set([entry.id])
  let parentId = entry.parentId
  while (parentId !== null) {
    if (visited.has(parentId)) throw new Error('Invalid library folder ancestry')
    visited.add(parentId)
    const parent = LibraryEntrySchema.parse(await request('library.entries.get', {
      libraryId: entry.libraryId, entryId: parentId,
    }, signal))
    signal.throwIfAborted()
    if (parent.id !== parentId || parent.libraryId !== entry.libraryId || parent.kind !== 'FOLDER') {
      throw new Error('Invalid library folder ancestry')
    }
    ancestors.unshift(parent)
    parentId = parent.parentId
  }
  signal.throwIfAborted()
  return ancestors
}
/** Read a bounded private file transfer and release its handle on every outcome.
 * @param request Cancellable library transport with independent cleanup requests.
 * @param payload Authorized resource identity and requested representation.
 * @param signal Preview or native attachment lifetime.
 * @returns Bytes for the native preview or attachment provider.
 */
export async function readLibraryFile(
  request: ReturnType<typeof useLibraryRequests>,
  payload: {
    readonly libraryId: string
    readonly entryId: string
    readonly rendered?: boolean
    readonly attachment?: boolean
    readonly sha256?: string
  },
  signal: AbortSignal,
): Promise<DocumentPreviewFile> {
  const transfer = record(await request('library.files.preview.open', payload, signal))
  const transferId = string(transfer.transferId)
  const close = async () => {
    await request('library.files.preview.close', { transferId })
  }
  let file: DocumentPreviewFile
  try {
    const byteLength = number(transfer.byteLength)
    const maxBytes = number(transfer.maxBytes)
    const chunkSize = number(transfer.chunkSize)
    const mediaType = string(transfer.mediaType)
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(byteLength) ||
      byteLength > maxBytes ||
      !Number.isSafeInteger(chunkSize) ||
      chunkSize < 1
    )
      throw new Error('Invalid library preview limit')
    const missingFonts = transfer.missingFonts
    if (
      missingFonts !== undefined &&
      (!Array.isArray(missingFonts) || missingFonts.some(font => typeof font !== 'string'))
    ) {
      throw new Error('Invalid library preview fonts')
    }
    const data = new Uint8Array(byteLength)
    let offset = 0
    while (offset < byteLength) {
      signal.throwIfAborted()
      const chunk = record(await request('library.files.preview.read', { transferId, offset }, signal))
      signal.throwIfAborted()
      if (
        !(chunk.data instanceof Uint8Array) ||
        chunk.offset !== offset ||
        typeof chunk.eof !== 'boolean' ||
        chunk.data.byteLength === 0 ||
        chunk.data.byteLength > chunkSize ||
        offset + chunk.data.byteLength > byteLength ||
        chunk.eof !== (offset + chunk.data.byteLength === byteLength)
      )
        throw new Error('Invalid library preview chunk')
      data.set(chunk.data, offset)
      offset += chunk.data.byteLength
    }
    signal.throwIfAborted()
    file = { data, mediaType, ...(Array.isArray(missingFonts) ? { missingFonts: missingFonts as string[] } : {}) }
  } catch (failure) {
    void close().catch((error: unknown) => {
      console.warn('Library preview cleanup failed', error)
    })
    throw failure
  }
  await close()
  signal.throwIfAborted()
  await request('library.entries.access', { libraryId: payload.libraryId, entryId: payload.entryId }, signal)
  signal.throwIfAborted()
  return file
}

/** Invoke a library operation and release resources returned after caller cancellation.
 * @param method Allowlisted metadata or file-transfer operation.
 * @param payload Resource identity or main-owned handle.
 * @param signal Caller lifetime; omitted for cleanup that must finish after cancellation.
 * @returns Operation result, or a cancellation rejection while late resources are released.
 */
export async function invokeLibraryRequest(
  method: string,
  payload: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
  const api = productApi()
  if (api === undefined) throw new Error('Product transport unavailable')
  const timeoutMs = [
    'library.files.preview.open',
    'library.files.download',
    'library.files.openExternal',
    'library.files.upload',
    'library.files.upload.select',
    'library.files.archive.select',
  ].includes(method)
    ? 300_000
    : undefined
  let opening: Promise<unknown> | undefined
  const transport =
    method === 'library.files.preview.open' || method === 'library.files.upload.select' || method === 'library.files.archive.select'
      ? {
        ...api,
        invoke(...args: Parameters<typeof api.invoke>) {
          opening = api.invoke(...args)
          return opening
        },
      }
      : api
  try {
    return await invokeProduct(transport, method, payload, signal, timeoutMs)
  } finally {
    // Late replies still own native resources after the caller stops waiting.
    if (signal.aborted)
      void opening
        ?.then(
          async (value) => {
            if (method === 'library.files.preview.open') {
              await api.invoke('library.files.preview.close', { transferId: string(record(value).transferId) })
            } else {
              const selections = z.array(LibrarySelectionSchema).parse(value)
              const results = await Promise.allSettled(selections.map(({ selectionId }) =>
                api.invoke('library.files.upload.discard', { selectionId })))
              const failures = results.filter(result => result.status === 'rejected')
              if (failures.length) throw new AggregateError(failures.map((result): unknown => result.reason), 'Library selection cleanup failed')
            }
          },
          () => undefined,
        )
        .catch((error: unknown) => {
          console.warn('Library resource cleanup failed', error)
        })
  }
}

/** Own request cancellation for one mounted library view.
 * @returns Requests that reject on caller cancellation or view unload; transfer cleanup can still run afterward.
 */
export function useLibraryRequests(): (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> {
  const requests = useRef(new Set<AbortController>())
  useEffect(
    () => () => {
      for (const controller of requests.current) controller.abort()
      requests.current.clear()
    },
    [],
  )
  return useCallback(async (method: string, payload: unknown, signal?: AbortSignal) => {
    const controller = new AbortController()
    requests.current.add(controller)
    try {
      return await invokeLibraryRequest(method, payload,
        signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]))
    } finally {
      requests.current.delete(controller)
    }
  }, [])
}
