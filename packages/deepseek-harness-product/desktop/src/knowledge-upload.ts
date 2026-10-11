/** Main-owned knowledge upload from a user-selected regular file. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { OpenDialogOptions } from 'electron'
import type { DeepSeekHarnessApiClient, KnowledgePdfParseMode } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'

/** Limit text extraction selection to PDF documents.
 * @param mode Validated upload parsing mode.
 * @returns Main-process native picker options.
 */
export function knowledgeUploadDialogOptions(mode: KnowledgePdfParseMode): OpenDialogOptions {
  return { properties: ['openFile'], ...(mode === 'TEXT' ? { filters: [{ name: 'PDF', extensions: ['pdf'] }] } : {}) }
}

/** Upload a selected file without sending local paths to the renderer.
 * @param path User-selected file, never a renderer-supplied path.
 * @param baseId Server knowledge base ID.
 * @param operationId Stable retry identity for the upload.
 * @param pdfParseMode Standard processing or embedded PDF text without OCR.
 * @param api Main-owned employee transport.
 * @param signal Caller cancellation.
 * @param options Validated destination folder and main-owned upload byte policy.
 * @returns The server document and current indexing state.
 */
export async function uploadKnowledgeFile(path: string, baseId: string, operationId: string,
  pdfParseMode: KnowledgePdfParseMode, api: DeepSeekHarnessApiClient, signal: AbortSignal | undefined,
  options: { readonly maxBytes: number; readonly folderId?: string | null | undefined }): Promise<unknown> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
    || (options.folderId !== undefined && options.folderId !== null
      && (typeof options.folderId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(options.folderId)))) {
    throw new ProductError('KNOWLEDGE_REQUEST_INVALID', 'Invalid upload policy or folder', false)
  }
  if (pdfParseMode === 'TEXT' && extname(path).toLowerCase() !== '.pdf') {
    throw new ProductError('KNOWLEDGE_FILE_INVALID', 'Text extraction requires a PDF document', false)
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1) {
      throw new ProductError('KNOWLEDGE_FILE_INVALID', 'Select a nonempty regular file', false)
    }
    if (stat.size > options.maxBytes) {
      throw new ProductError('KNOWLEDGE_FILE_TOO_LARGE', 'The selected file exceeds the upload size limit', false)
    }
    const content = await file.readFile(signal === undefined ? {} : { signal })
    if (content.byteLength !== stat.size || content.byteLength > options.maxBytes) {
      throw new ProductError('KNOWLEDGE_FILE_CHANGED', 'The selected file changed during upload preparation', true)
    }
    signal?.throwIfAborted()
    const body = new FormData()
    body.set('pdfParseMode', pdfParseMode)
    if (options.folderId !== undefined && options.folderId !== null) body.set('folderId', options.folderId)
    body.set('file', new Blob([new Uint8Array(content)], { type: 'application/octet-stream' }), basename(path))
    return await api.request(`/api/v1/knowledge-bases/${encodeURIComponent(baseId)}/documents`, {
      method: 'POST', headers: { 'idempotency-key': operationId }, body, ...signal === undefined ? {} : { signal },
    })
  } finally {
    await file.close()
  }
}
