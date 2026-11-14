/** Authorized library originals rendered by the official Host Office provider. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { OfficeKitError, type OfficeExtension, type OfficeSourceKey } from '@deepseek-ai/dsh-office-kit'
import { ProductError } from '@deepseek-harness/product/errors'
import { isLibraryResourceId, type LibraryFileTransfer } from '@deepseek-harness/product/protocol'
import { LibraryEntrySchema } from '@deepseek-harness/product/library'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'

/** Authorize before admission and again before returning any cached or new PDF.
 * @param ctx - Host services, including the optional official converter.
 * @param product - Main-owned authenticated product transport.
 * @param payload - IDs-only IPC request.
 * @param signal - Preview lifetime, including cancellation and plugin disposal.
 * @returns Main-owned PDF handle and official missing-font notices.
 * @throws ProductError when authorization, conversion, transfer, or private-file cleanup fails.
 */
export async function renderLibraryOffice(ctx: Context, product: Pick<DeepSeekHarnessProductIpc, 'invoke'>,
  payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<LibraryFileTransfer> {
  if (Object.keys(payload).some(key => !['libraryId', 'entryId'].includes(key))
    || !isLibraryResourceId(payload.libraryId) || !isLibraryResourceId(payload.entryId)) {
    throw new ProductError('LIBRARY_REQUEST_INVALID', 'Invalid original file identity', false)
  }
  const identity = { libraryId: payload.libraryId, entryId: payload.entryId }
  const files = ctx.get('officeKit')
  if (files === undefined) throw new ProductError('LIBRARY_OFFICE_PREVIEW_UNAVAILABLE', 'Office preview is unavailable', true)
  const employee = await product.invoke('auth.getSession', undefined, signal)
  if (typeof employee !== 'object' || employee === null || !('authenticated' in employee) || employee.authenticated !== true
    || !('employeeId' in employee) || !isLibraryResourceId(employee.employeeId)) {
    throw new ProductError('LIBRARY_ACCESS_DENIED', 'Authenticated employee is required', false)
  }
  const readEntry = async (lifetime: AbortSignal) => {
    const entry = LibraryEntrySchema.parse(await product.invoke('library.entries.get', identity, lifetime))
    if (entry.id !== identity.entryId || entry.libraryId !== identity.libraryId || entry.kind !== 'FILE' || !entry.sha256) {
      throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid original file metadata', false)
    }
    return { ...entry, sha256: entry.sha256 }
  }
  const source = await readEntry(signal)
  const policy = await product.invoke('runtime.library.preview.policy', {}, signal)
  if (typeof policy !== 'object' || policy === null || !('fileRequestTimeoutMs' in policy)
    || typeof policy.fileRequestTimeoutMs !== 'number' || !Number.isSafeInteger(policy.fileRequestTimeoutMs)
    || policy.fileRequestTimeoutMs < 1 || policy.fileRequestTimeoutMs > 1_800_000) {
    throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid file transport policy', false)
  }
  const fileRequestTimeoutMs = policy.fileRequestTimeoutMs
  const extension = source.name.split('.').at(-1)?.toLowerCase()
  if (!officeExtension(extension)) throw new ProductError('LIBRARY_PREVIEW_UNAVAILABLE', 'This file cannot use Office preview', false)
  const checkSource = async (lifetime: AbortSignal): Promise<void> => {
    const currentEmployee = await product.invoke('auth.getSession', undefined, lifetime)
    if (typeof currentEmployee !== 'object' || currentEmployee === null || !('employeeId' in currentEmployee)
      || currentEmployee.employeeId !== employee.employeeId || !('authenticated' in currentEmployee) || currentEmployee.authenticated !== true) {
      throw new ProductError('LIBRARY_ACCESS_DENIED', 'Employee identity changed', false)
    }
    const current = await readEntry(lifetime)
    if (current.sha256 !== source.sha256 || current.name !== source.name
      || current.sizeBytes !== source.sizeBytes) {
      throw new ProductError('LIBRARY_PREVIEW_SOURCE_CHANGED', 'The original file changed; reopen the preview', true)
    }
  }
  try {
    const result = await files.convert({ extension, priority: 'foreground', source: {
      key: brandString<OfficeSourceKey>(JSON.stringify(['product-library', employee.employeeId, identity.libraryId, identity.entryId])),
      version: source.sha256, bytes: source.sizeBytes,
      read: async (lifetime, maxBytes) => {
        await checkSource(lifetime)
        const bytes = await readOriginal(ctx, product, identity, lifetime, maxBytes, fileRequestTimeoutMs)
        await checkSource(lifetime)
        return { bytes, version: source.sha256 }
      },
    } }, signal)
    await checkSource(signal)
    signal.throwIfAborted()
    const output = fileTransfer(await product.invoke('runtime.library.preview.write.open', identity, signal))
    let committed = false
    let failure: unknown
    try {
      for (let offset = 0; offset < result.pdf.byteLength; offset += output.chunkSize) {
        signal.throwIfAborted()
        const chunk = result.pdf.subarray(offset, offset + output.chunkSize)
        const progress = await product.invoke('runtime.library.preview.write.append', { transferId: output.transferId, offset,
          dataBase64: Buffer.from(chunk).toString('base64') }, signal)
        if (typeof progress !== 'object' || progress === null || !('offset' in progress) || progress.offset !== offset + chunk.byteLength) {
          throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid converted file progress', false)
        }
      }
      await checkSource(signal)
      const transfer = fileTransfer(await product.invoke('runtime.library.preview.write.commit',
        { transferId: output.transferId, missingFonts: result.missingFonts }, signal))
      if (transfer.byteLength !== result.pdf.byteLength || transfer.mediaType !== 'application/pdf') {
        throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid converted file descriptor', false)
      }
      committed = true
      return transfer
    } catch (cause) {
      failure = cause
      throw cause
    } finally {
      if (!committed) await closePreviewTransfer(ctx, product, 'runtime.library.preview.write.close', output.transferId, signal, failure)
    }
  } catch (cause) {
    signal.throwIfAborted()
    if (!(cause instanceof OfficeKitError)) throw cause
    const code = cause.code === 'input-too-large' || cause.code === 'output-too-large' ? 'LIBRARY_PREVIEW_TOO_LARGE'
      : cause.code === 'unavailable' ? 'LIBRARY_OFFICE_PREVIEW_UNAVAILABLE'
        : cause.code === 'source-changed' ? 'LIBRARY_PREVIEW_SOURCE_CHANGED'
          : cause.code === 'timeout' ? 'LIBRARY_PREVIEW_TIMEOUT'
            : cause.code === 'busy' ? 'LIBRARY_PREVIEW_BUSY'
              : ['invalid-document', 'invalid-output', 'unsupported-format'].includes(cause.code) ? 'LIBRARY_PREVIEW_INVALID' : 'LIBRARY_PREVIEW_FAILED'
    throw new ProductError(code, 'Office file preview failed', !['LIBRARY_PREVIEW_TOO_LARGE', 'LIBRARY_PREVIEW_INVALID'].includes(code))
  }
}

function officeExtension(value: string | undefined): value is OfficeExtension {
  return value === 'doc' || value === 'docx' || value === 'xls' || value === 'xlsx' || value === 'ppt' || value === 'pptx'
}
async function readOriginal(ctx: Context, product: Pick<DeepSeekHarnessProductIpc, 'invoke'>, identity: { libraryId: string; entryId: string },
  signal: AbortSignal, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const transfer = fileTransfer(await product.invoke('library.files.preview.open', identity, signal, timeoutMs))
  let failure: unknown
  try {
    if (transfer.byteLength > maxBytes) throw new ProductError('LIBRARY_PREVIEW_TOO_LARGE', 'Original file exceeds the reserved preview capacity', false)
    const bytes = new Uint8Array(transfer.byteLength)
    let offset = 0
    while (offset < bytes.byteLength) {
      const value = await product.invoke('runtime.library.preview.readChunk', { transferId: transfer.transferId, offset }, signal)
      if (typeof value !== 'object' || value === null || !('dataBase64' in value) || typeof value.dataBase64 !== 'string'
        || value.dataBase64.length > Math.ceil(transfer.chunkSize / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.dataBase64)
        || !('offset' in value) || value.offset !== offset || !('eof' in value) || typeof value.eof !== 'boolean') {
        throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid original file chunk', false)
      }
      const chunk = Buffer.from(value.dataBase64, 'base64')
      if (chunk.byteLength === 0 || chunk.byteLength > transfer.chunkSize || offset + chunk.byteLength > bytes.byteLength
        || value.eof !== (offset + chunk.byteLength === bytes.byteLength)) {
        throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid original file progress', false)
      }
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    signal.throwIfAborted()
    return bytes
  } catch (cause) {
    failure = cause
    throw cause
  } finally {
    await closePreviewTransfer(ctx, product, 'library.files.preview.close', transfer.transferId, signal, failure)
  }
}

async function closePreviewTransfer(ctx: Context, product: Pick<DeepSeekHarnessProductIpc, 'invoke'>,
  method: 'library.files.preview.close' | 'runtime.library.preview.write.close', transferId: string,
  signal: AbortSignal, operationFailure: unknown): Promise<void> {
  try { await product.invoke(method, { transferId }) }
  catch (cleanupFailure) {
    const error = new ProductError('LIBRARY_PREVIEW_CLEANUP_FAILED',
      'Temporary preview file cleanup could not be confirmed. Restart the desktop app before retrying.', false, [], {
        cause: operationFailure === undefined ? cleanupFailure
          : new AggregateError([operationFailure, cleanupFailure], 'Preview operation and private-file cleanup failed'),
      })
    if (signal.aborted) ctx.logger.error(error.message)
    throw error
  }
}

function fileTransfer(value: unknown): LibraryFileTransfer {
  if (typeof value !== 'object' || value === null || !('transferId' in value) || typeof value.transferId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.transferId)
    || !('fileName' in value) || typeof value.fileName !== 'string' || !('mediaType' in value) || typeof value.mediaType !== 'string'
    || !('byteLength' in value) || typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0
    || !('maxBytes' in value) || typeof value.maxBytes !== 'number' || !Number.isSafeInteger(value.maxBytes)
    || value.maxBytes < 1 || value.maxBytes < value.byteLength
    || !('chunkSize' in value) || typeof value.chunkSize !== 'number' || !Number.isSafeInteger(value.chunkSize) || value.chunkSize < 1 || value.chunkSize > 256 * 1024) {
    throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid file transfer descriptor', false)
  }
  return value as LibraryFileTransfer
}
