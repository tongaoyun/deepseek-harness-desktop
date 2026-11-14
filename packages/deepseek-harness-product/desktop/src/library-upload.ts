/** Native picker and declared-result snapshots remain owned by the authenticated employee. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { LibraryEntrySchema, type LibraryEntry } from '@deepseek-harness/product/library'
import type { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'
interface Selection {
  readonly name: string
  readonly sizeBytes: number
  readonly employee: string
  readonly sourceSessionId?: string
  readonly source:
    | { readonly path: string; readonly mtimeMs: number; readonly ctimeMs: number; readonly dev: number; readonly ino: number }
    | { readonly bytes: Uint8Array }
  touchedAt: number
  pending: boolean
  fingerprint?: string
  sha256?: string
  receipt?: LibraryEntry
}
const archive = z
  .object({
    sessionId: z.string().min(1).max(180),
    seq: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
  })
  .strict()
/** Only issued selection IDs cross into the renderer; bytes and paths remain in main. */
export class LibraryUploads {
  private readonly selections = new Map<string, Selection>()
  private picking = false
  constructor(
    private readonly getEmployee: () => string | undefined,
    private readonly pick: (signal: AbortSignal) => Promise<readonly string[] | undefined>,
    private readonly maxBytes: number,
    private readonly lifetimeMs: number,
    private readonly readArchive?: (
      input: z.infer<typeof archive> & { maxBytes: number },
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  resetIdentity(): void {
    this.selections.clear()
  }
  close(): void {
    this.resetIdentity()
  }
  /** Resolve one native selection, upload receipt, or explicitly discarded selection.
   * @param method Allowlisted operation.
   * @param input Renderer IDs or Session event coordinates.
   * @param api Employee-authenticated client.
   * @param employee Captured employee.
   * @param signal Request and employee lifetime.
   * @returns Credential-free metadata; retries retain the same receipt and immutable bytes.
   */
  async invoke(
    method: string,
    input: Readonly<Record<string, unknown>>,
    api: DeepSeekHarnessApiClient,
    employee: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const check = () => {
      signal.throwIfAborted()
      if (this.getEmployee() !== employee) throw new ProductError('LIBRARY_ACCESS_REVOKED', 'Employee changed', false)
    }
    check()
    for (const [id, selection] of this.selections) {
      if (!selection.pending && Date.now() - selection.touchedAt > this.lifetimeMs) this.selections.delete(id)
    }
    if (method === 'library.files.upload.select' || method === 'library.files.archive.select') {
      if (this.picking) throw new ProductError('LIBRARY_PREVIEW_BUSY', 'File selection already open', true)
      this.picking = true
      try {
        const limit = Math.min(
          this.maxBytes,
          z
            .number()
            .int()
            .positive()
            .parse(await api.request('/api/v1/libraries/file-policy', { signal })),
        )
        const prepared: Selection[] = []
        if (method === 'library.files.archive.select') {
          const value = archive.parse(input)
          if (!this.readArchive) throw new Error('Native result reading unavailable')
          const result = z
            .object({ name: z.string().min(1).max(180), dataBase64: z.string().max(Math.ceil(limit / 3) * 4) })
            .strict()
            .parse(await this.readArchive({ ...value, maxBytes: limit }, signal))
          check()
          const bytes = Buffer.from(result.dataBase64, 'base64')
          if (bytes.byteLength < 1 || bytes.byteLength > limit || bytes.toString('base64') !== result.dataBase64)
            throw new Error('Invalid native file snapshot')
          prepared.push({
            name: basename(result.name),
            sizeBytes: bytes.byteLength,
            employee,
            source: { bytes },
            sourceSessionId: value.sessionId,
            pending: false,
            touchedAt: Date.now(),
          })
        } else {
          z.object({}).strict().parse(input)
          const paths = await this.pick(signal)
          check()
          if (paths === undefined) return []
          if (paths.length > 20) throw new Error('Too many selected files')
          for (const path of paths) {
            const info = await lstat(path)
            check()
            if (!info.isFile() || info.size < 1 || info.size > limit)
              throw new ProductError('LIBRARY_FILE_INVALID', 'File exceeds upload policy', false)
            prepared.push({
              name: basename(path),
              sizeBytes: info.size,
              employee,
              source: { path, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino },
              pending: false,
              touchedAt: Date.now(),
            })
          }
        }
        check()
        const total = [...this.selections.values(), ...prepared].reduce((size, item) => size + item.sizeBytes, 0)
        if (this.selections.size + prepared.length > 40 || total > Math.min(this.maxBytes * 2, 100 * 1024 * 1024))
          throw new ProductError('LIBRARY_FILE_INVALID', 'Selection exceeds upload policy', false)
        return prepared.map((selection) => {
          const selectionId = randomUUID()
          this.selections.set(selectionId, selection)
          return { selectionId, name: selection.name, sizeBytes: selection.sizeBytes }
        })
      } finally {
        this.picking = false
      }
    }
    const selectionId = z.uuid().parse(input.selectionId),
      selection = this.selections.get(selectionId)
    if (!selection || selection.employee !== employee)
      throw new ProductError('LIBRARY_FILE_INVALID', 'File selection expired', false)
    selection.touchedAt = Date.now()
    if (method === 'library.files.upload.discard') {
      z.object({ selectionId: z.uuid() }).strict().parse(input)
      if (selection.pending) throw new Error('Upload in progress')
      this.selections.delete(selectionId)
      return true
    }
    if (method !== 'library.files.upload') throw new Error('Unsupported upload operation')
    const value = z
      .object({
        selectionId: z.uuid(),
        libraryId: z.uuid(),
        parentId: z.uuid().nullable(),
        key: z.string().regex(/^[A-Za-z0-9._~-]{16,128}$/u),
      })
      .strict()
      .parse(input)
    if (selection.pending) throw new Error('Upload in progress')
    const fingerprint = JSON.stringify([value.libraryId, value.parentId, value.key])
    if (selection.fingerprint && selection.fingerprint !== fingerprint)
      throw new ProductError('IDEMPOTENCY_KEY_REUSED', 'Retry must keep the original destination', false)
    selection.fingerprint = fingerprint
    if (selection.receipt) return selection.receipt
    selection.pending = true
    try {
      const limit = Math.min(
        this.maxBytes,
        z
          .number()
          .int()
          .positive()
          .parse(await api.request('/api/v1/libraries/file-policy', { signal })),
      )
      if (selection.sizeBytes > limit)
        throw new ProductError('LIBRARY_FILE_INVALID', 'File exceeds upload policy', false)
      let bytes: Uint8Array
      if ('bytes' in selection.source) bytes = selection.source.bytes
      else {
        const source = selection.source
        await using file = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const info = await file.stat()
        check()
        if (
          !info.isFile() ||
          info.size !== selection.sizeBytes ||
          info.mtimeMs !== source.mtimeMs ||
          info.ctimeMs !== source.ctimeMs ||
          info.dev !== source.dev ||
          info.ino !== source.ino
        )
          throw new ProductError('LIBRARY_FILE_INVALID', 'Selected file changed; select it again', false)
        bytes = new Uint8Array(selection.sizeBytes)
        let offset = 0
        while (offset < bytes.byteLength) {
          const read = await file.read(bytes, offset, bytes.byteLength - offset, offset)
          check()
          if (!read.bytesRead) throw new Error('Selected file truncated')
          offset += read.bytesRead
        }
        const after = await file.stat()
        check()
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
          throw new ProductError('LIBRARY_FILE_INVALID', 'Selected file changed; select it again', false)
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (selection.sha256 && selection.sha256 !== sha256)
        throw new ProductError('LIBRARY_FILE_INVALID', 'Selected file changed; select it again', false)
      selection.sha256 = sha256
      const form = new FormData()
      form.append('file', new Blob([Uint8Array.from(bytes)]), selection.name)
      form.append('sha256', sha256)
      if (selection.sourceSessionId) form.append('sourceSessionId', selection.sourceSessionId)
      if (value.parentId !== null) form.append('parentId', value.parentId)
      const result = LibraryEntrySchema.parse(
        await api.request(`/api/v1/libraries/${value.libraryId}/files`, {
          method: 'POST',
          headers: { 'Idempotency-Key': value.key },
          body: form,
          signal,
        }),
      )
      check()
      if (
        this.selections.get(selectionId) !== selection ||
        result.libraryId !== value.libraryId ||
        result.sha256 !== sha256 ||
        result.parentId !== value.parentId ||
        result.sizeBytes !== bytes.byteLength ||
        result.name !== selection.name.trim()
      ) {
        throw new ProductError('INVALID_SERVER_RESPONSE', 'Upload receipt does not match the selected file', false)
      }
      selection.receipt = result
      return result
    } finally {
      selection.pending = false
      selection.touchedAt = Date.now()
    }
  }
}
