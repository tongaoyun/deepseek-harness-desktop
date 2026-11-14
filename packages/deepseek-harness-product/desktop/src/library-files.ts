/** Employee-bound original files in private main-process storage. */
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rm, unlink, type FileHandle } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ProductError } from '@deepseek-harness/product/errors'
import { isLibraryResourceId, type LibraryFileChunk, type LibraryFileMethod, type LibraryFileTransfer, type LibraryTransferId, type ProductSession } from '@deepseek-harness/product/protocol'
import { LIBRARY_FILE_CHUNK_BYTES, type LibraryFilePolicy } from './library-file-policy.ts'
import { waitForNativeDialog } from './native-dialog.ts'
import { LibraryEntrySchema } from '@deepseek-harness/product/library'

interface Identity { readonly libraryId: string; readonly entryId: string }
interface Source extends Identity {
  readonly filename: string
  readonly exportFilename: string
  readonly contentVersion: string
  readonly sizeBytes: number
  readonly previewMaxBytes: number
  readonly downloadMaxBytes: number
}
interface Transfer {
  readonly id: LibraryTransferId
  readonly employeeId: string
  readonly source: Source
  readonly path: string
  readonly directory: string
  readonly handle: FileHandle
  readonly controller: AbortController
  readonly timer: ReturnType<typeof setTimeout>
  readonly limit: number
  readonly kind: 'preview' | 'rendered' | 'download'
  mediaType: string
  byteLength: number
  ready: boolean
  missingFonts?: readonly string[]
  writing: boolean
}

/** Native interactions stay in Electron main; paths never cross product IPC. */
export interface LibraryFilesOptions {
  readonly directory: string
  readonly policy: LibraryFilePolicy
  readonly getEmployeeId: () => string | undefined
  readonly renderOffice: (identity: Identity, signal: AbortSignal) => Promise<unknown>
  readonly saveDialog: (filename: string) => Promise<string | undefined>
  readonly openPath: (path: string) => Promise<string>
}

/** Own file transfers; originals match metadata and disk reads assemble complete ranges or fail on early EOF. */
export class LibraryFiles {
  private readonly entries = new Map<string, Transfer>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly removals = new Map<string, Promise<void>>()
  private readonly lifecycle = new AbortController()
  private initialization: Promise<void> | undefined
  private preparing = 0

  constructor(private readonly options: LibraryFilesOptions) {}

  /** Remove abandoned owned temporary files before desktop startup completes. */
  async prepare(): Promise<void> {
    this.initialization ??= this.initialize()
    await this.initialization
  }

  /** Dispatch an allowlisted file operation after employee authentication.
   * @param method - Public operation or trusted Host-only conversion operation.
   * @param input - IDs and bounded chunk input; no arbitrary URLs or filesystem paths.
   * @param api - Main-owned authenticated API client.
   * @param session - Current authenticated employee.
   * @param signal - IPC caller cancellation.
   * @returns Credential-free descriptors, bounded bytes or native operation results.
   */
  invoke(method: LibraryFileMethod, input: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal?: AbortSignal): Promise<unknown> {
    const lifetime = AbortSignal.any([this.lifecycle.signal, ...signal ? [signal] : []])
    const operation = this.dispatch(method, input, api, employee(session), lifetime)
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined)
    return operation
  }

  /** Invalidate prior transfers and join removals; report failures after every removal settles. */
  async resetIdentity(): Promise<void> {
    const pending = [...this.removals.values(), ...[...this.entries.values()].map(entry => this.remove(entry))]
    const results = await Promise.allSettled(pending)
    const errors: unknown[] = []
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Library file cleanup failed')
  }

  /** Cancel and join owned work before reporting private-file cleanup failures. */
  async close(): Promise<void> {
    this.lifecycle.abort(new Error('Library file transport closed'))
    const [cleanup] = await Promise.allSettled([
      this.resetIdentity(),
      Promise.allSettled([...this.operations]),
      this.initialization?.catch(() => undefined),
    ])
    if (cleanup.status === 'rejected') throw cleanup.reason
  }

  private async dispatch(method: LibraryFileMethod, input: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    employeeId: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (method === 'runtime.library.preview.policy') {
      only(input, [])
      this.currentEmployee(employeeId)
      return { fileRequestTimeoutMs: this.options.policy.fileRequestTimeoutMs }
    }
    if (method === 'library.files.preview.close' || method === 'runtime.library.preview.write.close') {
      only(input, ['transferId'])
      const id = transferId(input.transferId)
      const entry = this.entries.get(id)
      if (entry !== undefined) {
        this.checkEmployee(entry, employeeId)
        await this.remove(entry)
      }
      return { closed: true }
    }
    if (method === 'library.files.preview.open') {
      only(input, ['libraryId', 'entryId', 'rendered', 'attachment', 'sha256'])
      if (input.rendered !== undefined && typeof input.rendered !== 'boolean') invalid()
      if (input.attachment !== undefined && typeof input.attachment !== 'boolean') invalid()
      if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sha256))) invalid()
      const identity = ids(input)
      const source = await this.authorize(api, identity, employeeId, signal)
      if (input.sha256 !== undefined && input.sha256 !== source.contentVersion) throw new ProductError('LIBRARY_PREVIEW_SOURCE_CHANGED', 'Selected file changed', true)
      if (input.rendered === true) {
        if (!office(source.filename)) throw new ProductError('LIBRARY_PREVIEW_UNAVAILABLE', 'Office preview requires an Office file', false)
        const result = await this.options.renderOffice(identity, signal)
        if (typeof result !== 'object' || result === null || !('transferId' in result)) invalid()
        const entry = this.lookup(transferId(result.transferId), employeeId)
        try {
          if (entry.kind !== 'rendered' || !entry.ready || entry.source.libraryId !== identity.libraryId
            || entry.source.entryId !== identity.entryId || entry.source.contentVersion !== source.contentVersion) {
            throw new ProductError('LIBRARY_PREVIEW_SOURCE_CHANGED', 'The converted file does not match the requested original', true)
          }
          await this.reauthorize(entry, api, employeeId, signal)
          signal.throwIfAborted()
          return descriptor(entry)
        }
        catch (cause) { await this.remove(entry); throw cause }
      }
      return descriptor(await this.original(api, source, employeeId, input.attachment === true, signal))
    }
    if (method === 'library.files.download' || method === 'library.files.openExternal') {
      only(input, ['libraryId', 'entryId', 'sha256'])
      const source = await this.authorize(api, ids(input), employeeId, signal)
      if (input.sha256 !== undefined && input.sha256 !== source.contentVersion) {
        throw new ProductError('LIBRARY_PREVIEW_SOURCE_CHANGED', 'Selected file changed', true)
      }
      const entry = await this.original(api, source, employeeId, true, signal)
      let keepForExternalApplication = false
      try {
        if (method === 'library.files.download') {
          const destination = await waitForNativeDialog(() => this.options.saveDialog(entry.source.exportFilename), signal)
          signal.throwIfAborted()
          if (destination === undefined) return { cancelled: true }
          await this.reauthorize(entry, api, employeeId, signal)
          await this.recordAccess(api, source, employeeId, signal)
          await copyFile(entry.path, destination)
          return { cancelled: false }
        }
        const documentFormat = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|txt|md|markdown|csv|json|png|jpe?g|gif|webp|bmp)$/iu
        if (!documentFormat.test(entry.source.exportFilename)) {
          throw new ProductError('LIBRARY_EXTERNAL_OPEN_UNSUPPORTED', 'This file type cannot be opened automatically', false)
        }
        await this.reauthorize(entry, api, employeeId, signal)
        await this.recordAccess(api, source, employeeId, signal)
        const error = await this.options.openPath(entry.path)
        signal.throwIfAborted()
        if (error !== '') throw new ProductError('LIBRARY_EXTERNAL_OPEN_FAILED', 'The system could not open this file', true)
        keepForExternalApplication = true
        return { opened: true }
      } finally {
        if (!keepForExternalApplication) await this.remove(entry)
      }
    }
    if (method === 'runtime.library.preview.write.open') {
      only(input, ['libraryId', 'entryId'])
      const source = await this.authorize(api, ids(input), employeeId, signal)
      if (!office(source.filename)) invalid()
      if (source.sizeBytes > Math.min(source.previewMaxBytes, this.options.policy.officeInputMaxBytes)) tooLarge()
      return descriptor(await this.create(source, employeeId, this.options.policy.officeOutputMaxBytes, 'application/pdf', 'rendered', signal))
    }
    only(input, method === 'runtime.library.preview.write.append' ? ['transferId', 'offset', 'dataBase64']
      : method === 'runtime.library.preview.write.commit' ? ['transferId', 'missingFonts'] : ['transferId', 'offset'])
    const entry = this.lookup(transferId(input.transferId), employeeId)
    const lifetime = AbortSignal.any([signal, entry.controller.signal])
    try {
      await this.reauthorize(entry, api, employeeId, lifetime)
      if (method === 'runtime.library.preview.write.append') {
        const offset = position(input.offset)
        const data = chunkBytes(input.dataBase64)
        if (entry.ready || entry.mediaType !== 'application/pdf' || entry.writing || offset !== entry.byteLength) invalid()
        if (entry.byteLength + data.length > entry.limit) tooLarge()
        entry.writing = true
        try {
          let written = 0
          while (written < data.length) {
            const result = await entry.handle.write(data, written, data.length - written, offset + written)
            if (result.bytesWritten === 0) throw new ProductError('LIBRARY_PREVIEW_FAILED', 'Temporary file could not be written', true)
            written += result.bytesWritten
          }
          entry.byteLength += data.length
        }
        finally { entry.writing = false }
        lifetime.throwIfAborted()
        return { offset: entry.byteLength }
      }
      if (method === 'runtime.library.preview.write.commit') {
        if (entry.ready || entry.writing || entry.byteLength === 0 || entry.mediaType !== 'application/pdf') invalid()
        if (input.missingFonts !== undefined && (!Array.isArray(input.missingFonts) || input.missingFonts.length > 256
          || input.missingFonts.some(font => typeof font !== 'string' || font.length > 256))) invalid()
        if (Array.isArray(input.missingFonts)) entry.missingFonts = input.missingFonts as string[]
        if (entry.byteLength < 5) throw new ProductError('LIBRARY_PREVIEW_INVALID', 'Invalid rendered PDF', false)
        const signature = await readBytes(entry.handle, 0, 5, lifetime)
        if (signature.toString('ascii') !== '%PDF-') throw new ProductError('LIBRARY_PREVIEW_INVALID', 'Invalid rendered PDF', false)
        entry.ready = true
        lifetime.throwIfAborted()
        return descriptor(entry)
      }
      if (!entry.ready) invalid()
      const offset = position(input.offset)
      if (offset > entry.byteLength) invalid()
      const bytes = await readBytes(entry.handle, offset, Math.min(LIBRARY_FILE_CHUNK_BYTES, entry.byteLength - offset), lifetime)
      lifetime.throwIfAborted()
      const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const chunk: LibraryFileChunk = { data, offset, eof: offset + data.length === entry.byteLength }
      return method === 'runtime.library.preview.readChunk'
        ? { dataBase64: bytes.toString('base64'), offset: chunk.offset, eof: chunk.eof } : chunk
    } catch (cause) { await this.remove(entry); throw cause }
  }

  private async original(api: DeepSeekHarnessApiClient, source: Source, employeeId: string,
    download: boolean, signal: AbortSignal): Promise<Transfer> {
    const extension = extname(source.filename).toLowerCase()
    const maximum = download ? Math.min(source.downloadMaxBytes, this.options.policy.downloadMaxBytes)
      : Math.min(source.previewMaxBytes, extension === '.xlsx' ? this.options.policy.spreadsheetMaxBytes
        : office(source.filename) ? this.options.policy.officeInputMaxBytes : this.options.policy.previewMaxBytes)
    if (source.sizeBytes > maximum) tooLarge()
    const entry = await this.create(source, employeeId, maximum, 'application/octet-stream', download ? 'download' : 'preview', signal)
    const lifetime = AbortSignal.any([signal, entry.controller.signal])
    try {
      const digest = createHash('sha256')
      const result = await api.streamBytes(`/api/v1/libraries/${source.libraryId}/entries/${source.entryId}/content?sha256=${source.contentVersion}`,
        maximum, async (data) => { digest.update(data); await entry.handle.writeFile(data); lifetime.throwIfAborted() },
        lifetime, this.options.policy.fileRequestTimeoutMs)
      if (result.byteLength !== source.sizeBytes || digest.digest('hex') !== source.contentVersion) {
        throw new ProductError('LIBRARY_PREVIEW_SOURCE_CHANGED', 'The original file size does not match its metadata; reopen the file', true)
      }
      entry.mediaType = result.mediaType
      entry.byteLength = result.byteLength
      await this.reauthorize(entry, api, employeeId, lifetime)
      entry.ready = true
      return entry
    } catch (cause) { await this.remove(entry); throw cause }
  }

  private async recordAccess(api: DeepSeekHarnessApiClient, source: Source, employeeId: string, signal: AbortSignal): Promise<void> {
    const result = await api.request(`/api/v1/libraries/${source.libraryId}/entries/${source.entryId}/access`, { method: 'PUT', signal })
    signal.throwIfAborted()
    if (this.options.getEmployeeId() !== employeeId) throw new ProductError('LIBRARY_ACCESS_REVOKED', 'Employee changed', false)
    if (result !== true) throw new ProductError('INVALID_SERVER_RESPONSE', 'File access was not acknowledged', true)
  }

  private async authorize(api: DeepSeekHarnessApiClient, identity: Identity, employeeId: string, signal: AbortSignal): Promise<Source> {
    this.currentEmployee(employeeId)
    const metadata = LibraryEntrySchema.parse(await api.request(`/api/v1/libraries/${identity.libraryId}/entries/${identity.entryId}`, { signal }))
    signal.throwIfAborted()
    this.currentEmployee(employeeId)
    if (metadata.id !== identity.entryId || metadata.libraryId !== identity.libraryId || metadata.kind !== 'FILE' || metadata.sha256 === null) {
      throw new ProductError('INVALID_SERVER_RESPONSE', 'Invalid file identity', false)
    }
    return { ...identity, filename: metadata.name, exportFilename: fileName(metadata.name),
      contentVersion: metadata.sha256, sizeBytes: metadata.sizeBytes,
      previewMaxBytes: this.options.policy.previewMaxBytes, downloadMaxBytes: this.options.policy.downloadMaxBytes }
  }

  private async reauthorize(entry: Transfer, api: DeepSeekHarnessApiClient, employeeId: string, signal: AbortSignal): Promise<void> {
    this.checkEmployee(entry, employeeId)
    const source = await this.authorize(api, entry.source, employeeId, signal)
    if (source.contentVersion !== entry.source.contentVersion || source.filename !== entry.source.filename
      || source.sizeBytes !== entry.source.sizeBytes
      || source.exportFilename !== entry.source.exportFilename) {
      throw new ProductError('LIBRARY_PREVIEW_SOURCE_CHANGED', 'The original file changed; reopen the preview', true)
    }
    if (entry.kind === 'download' ? Math.max(source.sizeBytes, entry.byteLength) > source.downloadMaxBytes
      : Math.max(source.sizeBytes, entry.kind === 'rendered' ? 0 : entry.byteLength) > source.previewMaxBytes) tooLarge()
  }
  private currentEmployee(employeeId: string): void {
    if (this.options.getEmployeeId() !== employeeId) throw new ProductError('LIBRARY_ACCESS_DENIED', 'Employee identity changed', false)
  }
  private checkEmployee(entry: Transfer, employeeId: string): void {
    this.currentEmployee(employeeId)
    if (entry.employeeId !== employeeId) throw new ProductError('LIBRARY_ACCESS_DENIED', 'File belongs to another employee', false)
  }
  private lookup(id: LibraryTransferId, employeeId: string): Transfer {
    const entry = this.entries.get(id)
    if (entry === undefined) throw new ProductError('LIBRARY_PREVIEW_EXPIRED', 'Reopen the file preview', true)
    this.checkEmployee(entry, employeeId)
    return entry
  }
  private async create(source: Source, employeeId: string, limit: number, mediaType: string, kind: Transfer['kind'], signal: AbortSignal): Promise<Transfer> {
    await this.prepare()
    signal.throwIfAborted()
    if (this.entries.size + this.preparing >= this.options.policy.maxTransfers) throw new ProductError('LIBRARY_PREVIEW_BUSY', 'Too many files are open; close a preview and retry', true)
    this.preparing += 1
    let directory: string | undefined
    let handle: FileHandle | undefined
    try {
      directory = await mkdtemp(join(this.options.directory, 'transfer-'))
      const path = join(directory, source.exportFilename)
      handle = await open(path, 'wx+', 0o600)
      signal.throwIfAborted()
      const id = randomUUID() as LibraryTransferId
      const timer = setTimeout(() => {
        const entry = this.entries.get(id)
        if (entry !== undefined) void this.remove(entry).catch(() => undefined)
      }, this.options.policy.transferLifetimeMs)
      timer.unref()
      const entry: Transfer = { id, employeeId, source, directory, path, handle, timer, limit, mediaType, kind,
        controller: new AbortController(), byteLength: 0, ready: false, writing: false }
      this.entries.set(id, entry)
      return entry
    } catch (cause) {
      await handle?.close()
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
      throw cause
    }
    finally { this.preparing -= 1 }
  }
  private async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const root = await lstat(this.options.directory)
    if (root.isSymbolicLink() || !root.isDirectory()) throw new ProductError('LIBRARY_PREVIEW_FAILED', 'Private file storage is unavailable', false)
    await chmod(this.options.directory, 0o700)
    for (const name of await readdir(this.options.directory)) {
      if (!/^transfer-[A-Za-z0-9]+$/u.test(name)) continue
      const path = join(this.options.directory, name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) await unlink(path)
      else if (info.isDirectory()) await rm(path, { recursive: true, force: true })
    }
  }
  private remove(entry: Transfer): Promise<void> {
    if (this.entries.get(entry.id) !== entry) return this.removals.get(entry.id) ?? Promise.resolve()
    this.entries.delete(entry.id)
    clearTimeout(entry.timer)
    entry.controller.abort(new Error('Library file handle closed'))
    const pending = (async () => {
      try { await entry.handle.close() }
      finally { await rm(entry.directory, { recursive: true, force: true }) }
    })()
    this.removals.set(entry.id, pending)
    void pending.finally(() => this.removals.delete(entry.id)).catch(() => undefined)
    return pending
  }
}

async function readBytes(handle: FileHandle, offset: number, length: number, signal: AbortSignal): Promise<Buffer> {
  const bytes = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    signal.throwIfAborted()
    const result = await handle.read(bytes, read, length - read, offset + read)
    signal.throwIfAborted()
    if (result.bytesRead === 0) throw new ProductError('LIBRARY_PREVIEW_FAILED', 'Temporary file became unavailable', true)
    read += result.bytesRead
  }
  return bytes
}

function descriptor(entry: Transfer): LibraryFileTransfer {
  return { transferId: entry.id, fileName: entry.source.exportFilename, mediaType: entry.mediaType, byteLength: entry.byteLength,
    maxBytes: entry.limit, chunkSize: LIBRARY_FILE_CHUNK_BYTES,
    ...entry.missingFonts === undefined ? {} : { missingFonts: entry.missingFonts } }
}
function employee(session: ProductSession): string {
  if (!session.authenticated || !session.employeeId) throw new ProductError('LIBRARY_ACCESS_DENIED', 'Authenticated employee is required', false)
  return session.employeeId
}
function only(input: Readonly<Record<string, unknown>>, fields: readonly string[]): void {
  if (Object.keys(input).some(key => !fields.includes(key))) invalid()
}
function ids(input: Readonly<Record<string, unknown>>): Identity {
  if (!id(input.libraryId) || !id(input.entryId)) invalid()
  return { libraryId: input.libraryId, entryId: input.entryId }
}
const id = isLibraryResourceId
function transferId(value: unknown): LibraryTransferId {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) invalid()
  return value as LibraryTransferId
}
function position(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(); return value }
function chunkBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(LIBRARY_FILE_CHUNK_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) invalid()
  const data = Buffer.from(value, 'base64')
  if (data.length > LIBRARY_FILE_CHUNK_BYTES) invalid()
  return data
}
function fileName(value: string): string {
  const sanitized = value.replace(/[\\/\x00-\x1f\x7f<>:"|?*]/gu, '_').replace(/^\.+/u, '_').replace(/[. ]+$/u, '')
  // Win32 reserves device stems even when a document extension is present.
  const reserved = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/iu
  const extension = extname(sanitized)
  const suffix = Buffer.byteLength(extension) <= 32 ? extension : ''
  const stem = suffix === '' ? sanitized : sanitized.slice(0, -suffix.length)
  let name = ''
  let remaining = 240 - Buffer.byteLength(suffix) - (reserved.test(sanitized) ? 1 : 0)
  for (const character of stem) {
    const size = Buffer.byteLength(character)
    if (size > remaining) break
    name += character
    remaining -= size
  }
  const filename = `${name.replace(/[. ]+$/u, '') || 'document'}${suffix}`
  return reserved.test(filename) ? `_${filename}` : filename
}
function office(value: string): boolean { return /\.(?:docx?|xlsx?|pptx?)$/iu.test(value) }
function invalid(): never { throw new ProductError('LIBRARY_REQUEST_INVALID', 'Invalid file transfer request', false) }
function tooLarge(): never { throw new ProductError('LIBRARY_PREVIEW_TOO_LARGE', 'File exceeds the configured size limit', false) }
