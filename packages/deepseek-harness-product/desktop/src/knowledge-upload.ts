/** Main-owned knowledge upload from a user-selected regular file. */
import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { OpenDialogOptions } from 'electron'
import type { DeepSeekHarnessApiClient, KnowledgePdfParseMode } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'
import type { KnowledgeUpload, KnowledgeUploadPending } from '@deepseek-harness/product/bridge'

interface Selection {
  readonly baseId: string
  readonly mode: KnowledgePdfParseMode
  readonly folderId: string | null | undefined
  readonly path: string
  sha256?: string
}

/** Retain employee-scoped native file selections for confirmed or explicitly discarded uploads. */
export class KnowledgeUploads implements KnowledgeUpload {
  private readonly selections = new Map<string, Selection>()
  private readonly active = new Set<string>()
  private selecting = false
  private identityOperation = new AbortController()
  private readonly lifetime = new AbortController()
  private identity: string | undefined
  constructor(private readonly employee: () => string | undefined,
    private readonly select: (mode: KnowledgePdfParseMode, signal: AbortSignal) => Promise<readonly string[] | undefined>,
    private readonly maxBytes: number) {}

  /** Capture a bounded native selection without uploading or exposing local paths.
   * @param baseId Authorized target library.
   * @param mode Validated PDF parsing mode.
   * @param folderId Fixed target folder for all selected files.
   * @param signal Native picker cancellation.
   * @returns Per-file identities and display names; cancellation returns an empty list.
   */
  async choose(baseId: string, mode: KnowledgePdfParseMode, folderId: string | null | undefined,
    signal?: AbortSignal): Promise<readonly KnowledgeUploadPending[]> {
    const employee = this.requireEmployee()
    const combined = AbortSignal.any([this.lifetime.signal, this.identityOperation.signal, ...signal === undefined ? [] : [signal]])
    combined.throwIfAborted()
    if (this.selecting) throw new ProductError('IDEMPOTENCY_OPERATION_IN_PROGRESS', 'File selection is already in progress', true)
    if (this.selections.size >= 16) throw new ProductError('KNOWLEDGE_UPLOAD_PENDING_LIMIT', 'Discard pending uploads before selecting more files', false)
    this.selecting = true
    try {
      const paths = await this.select(mode, combined)
      combined.throwIfAborted()
      if (this.employee() !== employee) throw new ProductError('KNOWLEDGE_ACCESS_DENIED', 'Employee changed during selection', false)
      if (paths === undefined || paths.length === 0) return []
      const unique = [...new Set(paths)]
      if (unique.length + this.selections.size > 16) {
        throw new ProductError('KNOWLEDGE_UPLOAD_PENDING_LIMIT', 'Select at most sixteen pending files', false)
      }
      return unique.map((path) => {
        const operationId = randomUUID()
        this.selections.set(`${employee}:${operationId}`, { baseId, mode, folderId, path })
        return { operationId, filename: basename(path), pdfParseMode: mode, ...(folderId === undefined ? {} : { folderId }) }
      })
    } finally { this.selecting = false }
  }

  /** Retry a retained file after rechecking employee identity, limits and its exact content.
   * @param baseId Authorized target library.
   * @param operationId Stable upload identity from the view.
   * @param mode Finite parsing mode.
   * @param folderId Original target folder.
   * @param api Main-owned employee transport.
   * @param signal Request cancellation; a dispatched upload retains its selection.
   * @returns Committed document metadata; the selection remains until acknowledged.
   */
  async send(baseId: string, operationId: string, mode: KnowledgePdfParseMode, folderId: string | null | undefined,
    api: DeepSeekHarnessApiClient, signal?: AbortSignal): Promise<unknown> {
    const employee = this.requireEmployee()
    const combined = AbortSignal.any([this.lifetime.signal, this.identityOperation.signal, ...signal === undefined ? [] : [signal]])
    combined.throwIfAborted()
    const key = `${employee}:${operationId}`
    if (this.active.has(key)) throw new ProductError('IDEMPOTENCY_OPERATION_IN_PROGRESS', 'Upload is already in progress', true)
    this.active.add(key)
    const selection = this.selections.get(key)
    try {
      if (!selection) throw new ProductError('KNOWLEDGE_UPLOAD_SELECTION_MISSING', 'Select the file again before uploading', false)
      if (selection.baseId !== baseId || selection.mode !== mode || selection.folderId !== folderId) {
        throw new ProductError('IDEMPOTENCY_KEY_REUSED', 'Upload destination cannot change during retry', false)
      }
      const limits = await api.request<Readonly<Record<string, unknown>>>('/api/v1/knowledge-file-limits', { signal: combined })
      if (typeof limits.uploadMaxBytes !== 'number' || !Number.isSafeInteger(limits.uploadMaxBytes) || limits.uploadMaxBytes < 1) {
        throw new Error('Invalid knowledge upload limits')
      }
      const selected = selection
      const result = await uploadKnowledgeFile(selected.path, baseId, operationId, mode, api, combined, {
        folderId, maxBytes: Math.min(limits.uploadMaxBytes, this.maxBytes),
        expectedSha256: selected.sha256,
        onPrepared: (sha256) => {
          if (this.employee() !== employee || this.selections.get(key) !== selected) {
            throw new ProductError('KNOWLEDGE_ACCESS_DENIED', 'Employee changed during upload preparation', false)
          }
          selected.sha256 = sha256
        },
      })
      return result
    } finally { this.active.delete(key) }
  }

  /** Drop one retained selection after the view explicitly abandons its retry.
   * @param baseId Original upload library.
   * @param operationId Stable operation identity.
   */
  discard(baseId: string, operationId: string): void {
    const key = `${this.employee()}:${operationId}`
    if (this.selections.get(key)?.baseId === baseId) this.selections.delete(key)
  }

  /** Recover this employee's prepared uploads after navigation; paths stay in main.
   * @param baseId Original knowledge library.
   * @returns At most sixteen retained operation identities in selection order.
   */
  pending(baseId: string): readonly KnowledgeUploadPending[] {
    const employee = this.employee()
    if (!employee || this.identity !== employee) { this.resetIdentity(); return [] }
    return [...this.selections].flatMap(([key, selection]) => selection.baseId !== baseId ? []
      : [{ operationId: key.slice(employee.length + 1), filename: basename(selection.path), pdfParseMode: selection.mode,
        ...(selection.folderId === undefined ? {} : { folderId: selection.folderId }) }])
  }

  /** Release private file selections when employee identity changes. */
  resetIdentity(): void {
    this.identityOperation.abort(); this.identityOperation = new AbortController()
    this.selections.clear(); this.identity = undefined
  }

  private requireEmployee(): string {
    this.lifetime.signal.throwIfAborted()
    const employee = this.employee()
    if (!employee) throw new ProductError('KNOWLEDGE_ACCESS_DENIED', 'Authenticated employee is required', false)
    if (this.identity !== employee) this.resetIdentity()
    this.identity = employee
    return employee
  }

  /** Cancel pending reads and release selections when the desktop closes. */
  close(): void { this.lifetime.abort(); this.resetIdentity() }
}

/** Limit text extraction selection to PDF documents.
 * @param mode Validated upload parsing mode.
 * @returns Main-process native picker options.
 */
export function knowledgeUploadDialogOptions(mode: KnowledgePdfParseMode): OpenDialogOptions {
  return { properties: ['openFile', 'multiSelections'], ...(mode === 'TEXT' ? { filters: [{ name: 'PDF', extensions: ['pdf'] }] } : {}) }
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
  options: { readonly maxBytes: number
    readonly folderId?: string | null | undefined
    readonly expectedSha256?: string | undefined
    readonly onPrepared?: (sha256: string) => void }): Promise<unknown> {
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
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) {
      throw new ProductError('KNOWLEDGE_FILE_CHANGED', 'The selected file changed; discard this upload before selecting it again', false)
    }
    options.onPrepared?.(sha256)
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
