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
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
      await writeFile(temporary, input.data, { flag: 'wx' })
      await rename(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
        await unlink(temporary).catch(() => undefined)
      })
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AttachmentError('Unable to persist screenshot.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
      }
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
    let data: Buffer
    try {
      data = await readFile(this.objectPath(hash))
    } catch (error) {
      throw new AttachmentError('Screenshot attachment was not found.', 'ATTACHMENT_NOT_FOUND', { cause: error })
    }
    signal?.throwIfAborted()
    if (digest(data) !== hash) throw new AttachmentError('Screenshot attachment digest mismatch.', 'ATTACHMENT_CORRUPT')
    if (ref.mediaType !== 'image/png' && ref.mediaType !== 'image/jpeg') {
      throw new AttachmentError('Stored image media type is unsupported.', 'INVALID_ATTACHMENT_REF')
    }
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
      mediaType: 'image/png',
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
