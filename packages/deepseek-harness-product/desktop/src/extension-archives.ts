/** Bounded directory, ZIP and immutable tar readers for personal authoring. */
import { constants } from 'node:fs'
import { lstat, open as openFile, opendir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { open, type Entry, type ZipFile } from 'yauzl'
import { Readable } from 'node:stream'
import { Parser, type ReadEntry } from 'tar'

/** Security limits shared by every local package reader. */
export const ARCHIVE_LIMITS = { files: 1024, extractedBytes: 64 * 1024 * 1024, compressedBytes: 32 * 1024 * 1024 } as const
/** Validate one portable relative package filename.
 * @param path Untrusted archive or filesystem relative path.
 * @returns Normalized relative path.
 */
export function archivePath(path: string): string {
  const normalized = path.replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || path.includes('\\') || /^[A-Za-z]:/.test(path) || path.startsWith('/')
    || /[\x00-\x1f\x7f]/.test(path) || normalized.split('/').some(value => !value || value === '..' || value === '.')) {
    throw new Error('Extension contains an illegal path')
  }
  return normalized
}

function collector(): { files: Map<string, Buffer>; add(path: string, bytes: Buffer): void } {
  const files = new Map<string, Buffer>()
  let total = 0
  return { files, add(path, bytes) {
    const key = archivePath(path)
    total += bytes.length
    if (files.has(key) || files.size >= ARCHIVE_LIMITS.files || total > ARCHIVE_LIMITS.extractedBytes) {
      throw new Error('Extension has duplicate files or exceeds package limits')
    }
    files.set(key, bytes)
  } }
}

/** Read a standalone SKILL.md without following links.
 * @param path Main-process file picker selection.
 * @param signal Cancellation.
 * @returns The bounded standard skill file; adjacent resources require directory import.
 */
export async function readExtensionMarkdown(path: string, signal: AbortSignal): Promise<Map<string, Buffer>> {
  signal.throwIfAborted()
  if (basename(path) !== 'SKILL.md') throw new Error('Select a standard SKILL.md')
  const original = await lstat(path)
  if (!original.isFile() || original.isSymbolicLink() || original.size > 65_536) throw new Error('Invalid or oversized SKILL.md')
  const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.ino !== original.ino || stat.size > 65_536) throw new Error('Invalid or oversized SKILL.md')
    const bytes = await file.readFile({ signal })
    if (bytes.length > 65_536) throw new Error('SKILL.md exceeds size limit')
    return new Map([['SKILL.md', bytes]])
  } finally { await file.close() }
}

/** Read a selected directory without following links or modifying its contents.
 * @param root Main-process file picker selection.
 * @param signal Cancellation.
 * @returns Bounded package files.
 */
export async function readExtensionDirectory(root: string, signal: AbortSignal): Promise<Map<string, Buffer>> {
  const output = collector()
  let entries = 0
  let declaredBytes = 0
  const visit = async (relative: string): Promise<void> => {
    signal.throwIfAborted()
    const path = join(root, relative)
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Extension links and special files are forbidden')
    if (++entries > ARCHIVE_LIMITS.files) throw new Error('Extension has too many entries')
    if (stat.isDirectory()) {
      for await (const entry of await opendir(path)) await visit(relative ? `${relative}/${entry.name}` : entry.name)
    } else {
      const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const current = await file.stat()
        declaredBytes += current.size
        if (!current.isFile() || current.ino !== stat.ino || declaredBytes > ARCHIVE_LIMITS.extractedBytes) throw new Error('Extension file changed or exceeds size limit')
        output.add(relative, await file.readFile({ signal }))
      } finally { await file.close() }
    }
  }
  await visit('')
  return output.files
}

/** Read a ZIP lazily, rejecting links, traversal, duplicates and expansion bombs.
 * @param path Main-process ZIP selection.
 * @param signal Cancellation.
 * @returns Bounded package files.
 */
export async function readExtensionZip(path: string, signal: AbortSignal): Promise<Map<string, Buffer>> {
  signal.throwIfAborted()
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARCHIVE_LIMITS.compressedBytes) throw new Error('Invalid or oversized ZIP')
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    open(path, { lazyEntries: true, validateEntrySizes: true }, (error, file) => {
      if (error) reject(error); else resolve(file)
    })
  })
  const output = collector()
  let entries = 0
  let declaredBytes = 0
  const cancel = (): void => { zip.close() }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    if (zip.entryCount > ARCHIVE_LIMITS.files) throw new Error('ZIP has excessive entries')
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        // Cancellation reasons are caller-owned and must retain their identity.
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        reject(signal.reason)
      }
      signal.addEventListener('abort', abort, { once: true })
      const settled = (): void => { signal.removeEventListener('abort', abort) }
      zip.once('end', () => { settled(); resolve() })
      zip.once('close', () => { settled(); if (signal.aborted) abort() })
      zip.once('error', reject)
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          signal.throwIfAborted()
          archivePath(entry.fileName)
          const type = (entry.externalFileAttributes >>> 16) & 0o170000
          if (++entries > ARCHIVE_LIMITS.files || (type !== 0 && type !== 0o100000 && type !== 0o040000)) throw new Error('ZIP links or excessive entries are forbidden')
          declaredBytes += entry.uncompressedSize
          if (declaredBytes > ARCHIVE_LIMITS.extractedBytes) throw new Error('ZIP exceeds extracted size limit')
          if (!entry.fileName.endsWith('/')) {
            const stream = await new Promise<Readable>((accept, fail) => {
              zip.openReadStream(entry, (error, value) => {
                if (error) fail(error); else accept(value)
              })
            })
            const abort = (): void => { stream.destroy(new Error('Import cancelled')) }
            signal.addEventListener('abort', abort, { once: true })
            const chunks: Buffer[] = []
            let bytes = 0
            try {
              for await (const chunk of stream) {
                signal.throwIfAborted()
                const part = Buffer.from(chunk as Uint8Array)
                bytes += part.length
                if (bytes > entry.uncompressedSize) throw new Error('ZIP entry exceeds declared size')
                chunks.push(part)
              }
            } finally { signal.removeEventListener('abort', abort) }
            output.add(entry.fileName, Buffer.concat(chunks))
          }
          zip.readEntry()
        })().catch((error: unknown) => {
          settled()
          // Preserve cancellation reasons and the original archive failure.
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          reject(error)
        })
      })
      zip.readEntry()
    })
    signal.throwIfAborted()
    return output.files
  } finally { signal.removeEventListener('abort', cancel); zip.close() }
}

/** Read a downloaded immutable tar.gz without writing archive paths to disk.
 * @param bytes Hash-verified package bytes.
 * @param signal Cancellation.
 * @returns Bounded package files.
 */
export async function readExtensionTar(bytes: Buffer, signal: AbortSignal): Promise<Map<string, Buffer>> {
  signal.throwIfAborted()
  if (bytes.length > ARCHIVE_LIMITS.compressedBytes) throw new Error('Artifact exceeds size limit')
  const output = collector()
  const parser = new Parser({ strict: true })
  const pending: Promise<void>[] = []
  const paths = new Set<string>()
  let declaredBytes = 0
  parser.on('entry', (entry: ReadEntry) => {
    const operation = (async () => {
      const path = archivePath(entry.path)
      declaredBytes += entry.size
      if (paths.has(path) || paths.size >= ARCHIVE_LIMITS.files || declaredBytes > ARCHIVE_LIMITS.extractedBytes) throw new Error('Artifact exceeds limits or repeats a path')
      paths.add(path)
      if (entry.type === 'Directory') { entry.resume(); return }
      if (entry.type !== 'File' || entry.size > ARCHIVE_LIMITS.extractedBytes) throw new Error('Artifact contains links or oversized files')
      const chunks: Buffer[] = []
      let length = 0
      for await (const chunk of entry) {
        signal.throwIfAborted()
        const value = Buffer.from(chunk as Uint8Array)
        length += value.length
        if (length > entry.size) throw new Error('Artifact entry exceeds declared size')
        chunks.push(value)
      }
      if (length !== entry.size) throw new Error('Artifact entry is truncated')
      output.add(entry.path, Buffer.concat(chunks))
    })()
    pending.push(operation)
    void operation.catch((error: unknown) => { parser.abort(error instanceof Error ? error : new Error('Invalid artifact')) })
  })
  const abort = (): void => { parser.abort(new Error('Artifact read cancelled')) }
  try {
    await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', abort, { once: true })
      parser.once('error', reject)
      parser.once('end', resolve)
      parser.end(bytes)
    })
    await Promise.all(pending)
    return output.files
  } finally {
    signal.removeEventListener('abort', abort)
    await Promise.allSettled(pending)
  }
}
