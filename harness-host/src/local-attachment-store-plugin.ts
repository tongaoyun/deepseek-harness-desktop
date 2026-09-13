import type { Context } from '@deepseek-ai/cordis'
import { IMAGE_LIMITS } from './image-limits.js'
import z from '@deepseek-ai/schemastery'
import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
  ImageVariantId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageMediaType,
  type ImageRequestPolicy,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface Config { root?: string }
export const Config = z.object({ root: z.string().default('./.xiaoyin/attachments') })

export default class LocalAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = IMAGE_LIMITS

  private readonly root: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.root = resolve(config.root ?? './.xiaoyin/attachments')
    mkdirSync(this.root, { recursive: true })
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    if (!this.imageLimits.mediaTypes.includes(input.mediaType)) throw new AttachmentError('Only PNG and JPEG images are supported.', 'UNSUPPORTED_IMAGE_TYPE')
    if (input.data.byteLength === 0 || input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError('Screenshot exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
    }
    const metadata = imageMetadata(input.data, input.mediaType)
    if (metadata.width > this.imageLimits.maxImageDimension || metadata.height > this.imageLimits.maxImageDimension) {
      throw new AttachmentError('Screenshot dimensions exceed the configured limit.', 'IMAGE_DIMENSION_TOO_LARGE')
    }
    if (metadata.width * metadata.height > this.imageLimits.maxImagePixels) {
      throw new AttachmentError('Screenshot pixel count exceeds the configured limit.', 'IMAGE_TOO_MANY_PIXELS')
    }
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    await this.validateImage(input)
    const hash = digest(input.data)
    const target = this.objectPath(hash)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(input.data)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
        const existing = await readFile(target).catch(() => undefined)
        if (existing && digest(existing) === hash) {
          await unlink(temporary).catch(() => undefined)
          return
        }
        await unlink(target).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError
        })
        await rename(temporary, target)
      })
      if (process.platform !== 'win32') {
        const directory = await open(this.root, 'r')
        try { await directory.sync() } finally { await directory.close() }
      }
      const stored = await readFile(target)
      if (digest(stored) !== hash) throw new Error('Screenshot content changed before it could be verified')
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw new AttachmentError('Unable to persist screenshot.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
    }
    const metadata = imageMetadata(input.data, input.mediaType)
    return {
      attachmentId: AttachmentId(`sha256:${hash}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: metadata.width,
      height: metadata.height,
      ...(input.name ? { name: input.name.replaceAll(/[\\/]/g, '').slice(0, 100) } : {}),
    }
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    signal?.throwIfAborted()
    const hash = attachmentHash(ref)
    if (ref.mediaType !== 'image/png' && ref.mediaType !== 'image/jpeg') {
      throw new AttachmentError('Stored image media type is unsupported.', 'INVALID_ATTACHMENT_REF')
    }
    let data: Buffer
    try {
      data = await readBounded(this.objectPath(hash), this.imageLimits.maxImageBytes)
    } catch (error) {
      if (error instanceof AttachmentError) throw error
      const code = (error as NodeJS.ErrnoException).code
      throw new AttachmentError(
        code === 'ENOENT' ? 'Screenshot attachment was not found.' : 'Screenshot attachment could not be read.',
        code === 'ENOENT' ? 'ATTACHMENT_NOT_FOUND' : 'ATTACHMENT_READ_FAILED',
        { cause: error },
      )
    }
    signal?.throwIfAborted()
    if (digest(data) !== hash) throw new AttachmentError('Screenshot attachment digest mismatch.', 'ATTACHMENT_CORRUPT')
    const metadata = imageMetadata(data, ref.mediaType)
    if (ref.bytes !== data.byteLength || ref.width !== metadata.width || ref.height !== metadata.height) {
      throw new AttachmentError('Screenshot attachment metadata mismatch.', 'INVALID_ATTACHMENT_REF')
    }
    return { ref, data }
  }

  async readImageRequest(ref: ImageAttachmentRef, policy: ImageRequestPolicy, signal?: AbortSignal): Promise<RequestImageAttachment> {
    const stored = await this.readImage(ref, signal)
    if (stored.data.byteLength > policy.maxBytes || ref.width * ref.height > policy.maxPixels) {
      throw new AttachmentError('Screenshot exceeds the selected model image policy.', 'ATTACHMENT_PROJECTION_UNSUPPORTED')
    }
    const variant = digest(Buffer.from(`${String(ref.attachmentId)}:${policy.maxBytes}:${policy.maxPixels}`))
    return {
      variantId: ImageVariantId(`sha256:${variant}`),
      attachment: ref,
      data: stored.data,
      mediaType: ref.mediaType,
      bytes: stored.data.byteLength,
      width: ref.width,
      height: ref.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: imageMetadata(stored.data, ref.mediaType).hasAlpha,
    }
  }

  private objectPath(hash: string): string { return resolve(this.root, `${hash}.image`) }
}

export function imageMetadata(data: Uint8Array, mediaType: ImageMediaType): { width: number; height: number; hasAlpha: boolean } {
  if (mediaType === 'image/png') return pngMetadata(data)
  if (mediaType === 'image/jpeg') return jpegMetadata(data)
  throw new AttachmentError('Stored image media type is unsupported.', 'INVALID_ATTACHMENT_REF')
}

export function pngMetadata(data: Uint8Array): { width: number; height: number; hasAlpha: boolean } {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new AttachmentError('Screenshot is not a valid PNG image.', 'INVALID_IMAGE')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const colorType = bytes[25] ?? -1
  if (width === 0 || height === 0 || ![0, 2, 3, 4, 6].includes(colorType)) {
    throw new AttachmentError('Screenshot PNG header is invalid.', 'INVALID_IMAGE')
  }
  return { width, height, hasAlpha: colorType === 4 || colorType === 6 }
}

export function jpegMetadata(data: Uint8Array): { width: number; height: number; hasAlpha: boolean } {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new AttachmentError('Image is not a valid JPEG.', 'INVALID_IMAGE')
  }
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]!
    if (marker === 0xd9 || marker === 0xda) break
    const length = bytes.readUInt16BE(offset + 2)
    if (length < 2 || offset + length + 2 > bytes.length) break
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = bytes.readUInt16BE(offset + 5)
      const width = bytes.readUInt16BE(offset + 7)
      if (width > 0 && height > 0) return { width, height, hasAlpha: false }
    }
    offset += length + 2
  }
  throw new AttachmentError('JPEG dimensions are invalid.', 'INVALID_IMAGE')
}

function attachmentHash(ref: ImageAttachmentRef): string {
  const match = String(ref.attachmentId).match(/^sha256:([a-f0-9]{64})$/)
  if (!match) throw new AttachmentError('Screenshot attachment identifier is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]!
}

function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    if (!Number.isSafeInteger(size) || size > limit) {
      throw new AttachmentError('Screenshot attachment exceeds its byte limit.', 'ATTACHMENT_CORRUPT')
    }
    const buffer = Buffer.allocUnsafe(size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > limit) throw new AttachmentError('Screenshot attachment exceeds its byte limit.', 'ATTACHMENT_CORRUPT')
    return buffer.subarray(0, length)
  } finally {
    await file.close()
  }
}
