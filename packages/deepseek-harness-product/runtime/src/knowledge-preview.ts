/** Authorized knowledge originals rendered by the official Host Office provider. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { OfficeToPdfError, type OfficeExtension, type OfficeSourceKey } from '@deepseek-ai/dsh-office-to-pdf'
import { ProductError } from '@deepseek-harness/product/errors'
import { isKnowledgeResourceId, parseKnowledgeDocumentPreviewMetadata, type KnowledgeFileTransfer } from '@deepseek-harness/product/protocol'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'

/** Authorize before admission and again before returning any cached or new PDF.
 * @param ctx - Host services, including the optional official converter.
 * @param product - Main-owned authenticated product transport.
 * @param payload - IDs-only IPC request.
 * @param signal - Preview lifetime, including cancellation and plugin disposal.
 * @returns Main-owned PDF handle and official missing-font notices.
 */
export async function renderKnowledgeOffice(ctx: Context, product: Pick<DeepSeekHarnessProductIpc, 'invoke'>,
  payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<KnowledgeFileTransfer> {
  if (Object.keys(payload).some(key => !['knowledgeBaseId', 'documentId'].includes(key))
    || !isKnowledgeResourceId(payload.knowledgeBaseId) || !isKnowledgeResourceId(payload.documentId)) {
    throw new ProductError('KNOWLEDGE_REQUEST_INVALID', 'Invalid original file identity', false)
  }
  const identity = { knowledgeBaseId: payload.knowledgeBaseId, documentId: payload.documentId }
  const files = ctx.get('officeToPdf')
  if (files === undefined) throw new ProductError('KNOWLEDGE_OFFICE_PREVIEW_UNAVAILABLE', 'Office preview is unavailable', true)
  const employee = await product.invoke('auth.getSession', undefined, signal)
  if (typeof employee !== 'object' || employee === null || !('authenticated' in employee) || employee.authenticated !== true
    || !('employeeId' in employee) || !isKnowledgeResourceId(employee.employeeId)) {
    throw new ProductError('KNOWLEDGE_ACCESS_DENIED', 'Authenticated employee is required', false)
  }
  const source = parseKnowledgeDocumentPreviewMetadata(
    await product.invoke('knowledge.documents.previewMetadata', identity, signal),
    { id: identity.documentId, knowledgeBaseId: identity.knowledgeBaseId })
  const policy = await product.invoke('runtime.knowledge.preview.policy', {}, signal)
  if (typeof policy !== 'object' || policy === null || !('fileRequestTimeoutMs' in policy)
    || typeof policy.fileRequestTimeoutMs !== 'number' || !Number.isSafeInteger(policy.fileRequestTimeoutMs)
    || policy.fileRequestTimeoutMs < 1 || policy.fileRequestTimeoutMs > 1_800_000) {
    throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid file transport policy', false)
  }
  const fileRequestTimeoutMs = policy.fileRequestTimeoutMs
  const extension = source.filename.split('.').at(-1)?.toLowerCase()
  if (!officeExtension(extension)) throw new ProductError('KNOWLEDGE_PREVIEW_UNAVAILABLE', 'This file cannot use Office preview', false)
  const checkSource = async (lifetime: AbortSignal): Promise<void> => {
    const currentEmployee = await product.invoke('auth.getSession', undefined, lifetime)
    if (typeof currentEmployee !== 'object' || currentEmployee === null || !('employeeId' in currentEmployee)
      || currentEmployee.employeeId !== employee.employeeId || !('authenticated' in currentEmployee) || currentEmployee.authenticated !== true) {
      throw new ProductError('KNOWLEDGE_ACCESS_DENIED', 'Employee identity changed', false)
    }
    const current = parseKnowledgeDocumentPreviewMetadata(
      await product.invoke('knowledge.documents.previewMetadata', identity, lifetime),
      { id: identity.documentId, knowledgeBaseId: identity.knowledgeBaseId })
    if (current.contentVersion !== source.contentVersion || current.filename !== source.filename
      || current.sizeBytes !== source.sizeBytes) {
      throw new ProductError('KNOWLEDGE_PREVIEW_SOURCE_CHANGED', 'The original file changed; reopen the preview', true)
    }
  }
  try {
    const result = await files.convert({ extension, priority: 'foreground', source: {
      key: brandString<OfficeSourceKey>(JSON.stringify(['product-knowledge', employee.employeeId, identity.knowledgeBaseId, identity.documentId])),
      version: source.contentVersion, bytes: source.sizeBytes,
      read: async (lifetime, maxBytes) => {
        await checkSource(lifetime)
        const bytes = await readOriginal(product, identity, lifetime, maxBytes, fileRequestTimeoutMs)
        await checkSource(lifetime)
        return { bytes, version: source.contentVersion }
      },
    } }, signal)
    await checkSource(signal)
    signal.throwIfAborted()
    const output = fileTransfer(await product.invoke('runtime.knowledge.preview.write.open', identity, signal))
    let committed = false
    try {
      for (let offset = 0; offset < result.pdf.byteLength; offset += output.chunkSize) {
        signal.throwIfAborted()
        const chunk = result.pdf.subarray(offset, offset + output.chunkSize)
        const progress = await product.invoke('runtime.knowledge.preview.write.append', { transferId: output.transferId, offset,
          dataBase64: Buffer.from(chunk).toString('base64') }, signal)
        if (typeof progress !== 'object' || progress === null || !('offset' in progress) || progress.offset !== offset + chunk.byteLength) {
          throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid converted file progress', false)
        }
      }
      await checkSource(signal)
      const transfer = fileTransfer(await product.invoke('runtime.knowledge.preview.write.commit',
        { transferId: output.transferId, missingFonts: result.missingFonts }, signal))
      if (transfer.byteLength !== result.pdf.byteLength || transfer.mediaType !== 'application/pdf') {
        throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid converted file descriptor', false)
      }
      committed = true
      return transfer
    } finally {
      if (!committed) await product.invoke('runtime.knowledge.preview.write.close', { transferId: output.transferId }).catch(() => undefined)
    }
  } catch (cause) {
    signal.throwIfAborted()
    if (!(cause instanceof OfficeToPdfError)) throw cause
    const code = cause.code === 'input-too-large' || cause.code === 'output-too-large' ? 'KNOWLEDGE_PREVIEW_TOO_LARGE'
      : cause.code === 'unavailable' ? 'KNOWLEDGE_OFFICE_PREVIEW_UNAVAILABLE'
        : cause.code === 'source-changed' ? 'KNOWLEDGE_PREVIEW_SOURCE_CHANGED'
          : cause.code === 'timeout' ? 'KNOWLEDGE_PREVIEW_TIMEOUT'
            : cause.code === 'busy' ? 'KNOWLEDGE_PREVIEW_BUSY'
              : ['invalid-document', 'invalid-output', 'unsupported-format'].includes(cause.code) ? 'KNOWLEDGE_PREVIEW_INVALID' : 'KNOWLEDGE_PREVIEW_FAILED'
    throw new ProductError(code, 'Office file preview failed', !['KNOWLEDGE_PREVIEW_TOO_LARGE', 'KNOWLEDGE_PREVIEW_INVALID'].includes(code))
  }
}

function officeExtension(value: string | undefined): value is OfficeExtension {
  return value === 'doc' || value === 'docx' || value === 'xls' || value === 'xlsx' || value === 'ppt' || value === 'pptx'
}
async function readOriginal(product: Pick<DeepSeekHarnessProductIpc, 'invoke'>, identity: { knowledgeBaseId: string; documentId: string },
  signal: AbortSignal, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  const transfer = fileTransfer(await product.invoke('knowledge.documents.preview.open', identity, signal, timeoutMs))
  try {
    if (transfer.byteLength > maxBytes) throw new ProductError('KNOWLEDGE_PREVIEW_TOO_LARGE', 'Original file exceeds the reserved preview capacity', false)
    const bytes = new Uint8Array(transfer.byteLength)
    let offset = 0
    while (offset < bytes.byteLength) {
      const value = await product.invoke('runtime.knowledge.preview.readChunk', { transferId: transfer.transferId, offset }, signal)
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
  } finally {
    await product.invoke('knowledge.documents.preview.close', { transferId: transfer.transferId }).catch(() => undefined)
  }
}
function fileTransfer(value: unknown): KnowledgeFileTransfer {
  if (typeof value !== 'object' || value === null || !('transferId' in value) || typeof value.transferId !== 'string'
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.transferId)
    || !('fileName' in value) || typeof value.fileName !== 'string' || !('mediaType' in value) || typeof value.mediaType !== 'string'
    || !('byteLength' in value) || typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0
    || !('maxBytes' in value) || typeof value.maxBytes !== 'number' || !Number.isSafeInteger(value.maxBytes)
    || value.maxBytes < 1 || value.maxBytes < value.byteLength
    || !('chunkSize' in value) || typeof value.chunkSize !== 'number' || !Number.isSafeInteger(value.chunkSize) || value.chunkSize < 1 || value.chunkSize > 256 * 1024) {
    throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid file transfer descriptor', false)
  }
  return value as KnowledgeFileTransfer
}
