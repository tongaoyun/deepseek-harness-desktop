/** Bounded local reads for skill and AgentSpec resource transfers. */
import { constants, promises as fs } from 'node:fs'

/** Resource read failures whose codes are localized by the receiving content module. */
export class ContentFileReadError extends Error {
  /** Stable failure code, without local filesystem paths. */
  readonly code: 'error.contentFile.invalid' | 'error.contentFile.tooLarge' | 'error.contentFile.changed'

  constructor(reason: 'invalid' | 'tooLarge' | 'changed') {
    super({
      invalid: 'Select a regular resource file.',
      tooLarge: 'The resource file exceeds the size limit.',
      changed: 'The resource file changed during reading. Try again.',
    }[reason])
    this.code = `error.contentFile.${reason}`
    this.name = 'ContentFileReadError'
  }
}

/** Read one regular file without following a final symbolic link or buffering subsequent growth.
 * @param path Local resource path already selected by the content module.
 * @param maxBytes Inclusive limit for the complete file.
 * @param signal Checked before and after opening, applied to the stream and checked before returning.
 * @returns Complete bytes; replaced files, changed size, modification or change times,
 * invalid files and size limits reject with ContentFileReadError.
 * All outcomes close the handle.
 */
export async function readContentFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted()
  const entry = await fs.lstat(path)
  signal?.throwIfAborted()
  if (!entry.isFile() || entry.isSymbolicLink()) throw new ContentFileReadError('invalid')
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    signal?.throwIfAborted()
    const info = await handle.stat()
    signal?.throwIfAborted()
    if (!info.isFile()) throw new ContentFileReadError('invalid')
    if (info.dev !== entry.dev || info.ino !== entry.ino) throw new ContentFileReadError('changed')
    if (info.size > maxBytes) throw new ContentFileReadError('tooLarge')
    // The inclusive end allows one probe byte beyond the initial size.
    const stream = handle.createReadStream({ start: 0, end: info.size, autoClose: false, ...signal ? { signal } : {} })
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      signal?.throwIfAborted()
      length += chunk.byteLength
      if (length > info.size) throw new ContentFileReadError('changed')
      chunks.push(chunk)
    }
    signal?.throwIfAborted()
    if (length !== info.size) throw new ContentFileReadError('changed')
    const after = await handle.stat()
    signal?.throwIfAborted()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
      throw new ContentFileReadError('changed')
    return Buffer.concat(chunks, length)
  } finally { await handle.close() }
}
