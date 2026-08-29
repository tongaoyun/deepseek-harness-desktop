import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  AttachmentError,
  AttachmentId,
  AttachmentStore,
  ImageVariantId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
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
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 12 * 1024 * 1024,
    maxImagePixels: 4_000_000,
    maxImageDimension: 2560,
    mediaTypes: ['image/png'],
  }

  private readonly root: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.root = resolve(config.root ?? './.xiaoyin/attachments')
    mkdirSync(this.root, { recursive: true })
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    if (input.mediaType !== 'image/png') throw new AttachmentError('Only PNG screenshots are supported.', 'UNSUPPORTED_IMAGE_TYPE')
    if (input.data.byteLength === 0 || input.data.byteLength > this.imageLimits.maxImageBytes) {
      throw new AttachmentError('Screenshot exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
    }
    const metadata = pngMetadata(input.data)
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
    const metadata = pngMetadata(input.data)
    return {
      attachmentId: AttachmentId(`sha256:${hash}`),
      mediaType: 'image/png',
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
    const metadata = pngMetadata(data)
    if (ref.mediaType !== 'image/png' || ref.bytes !== data.byteLength || ref.width !== metadata.width || ref.height !== metadata.height) {
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
      hasAlpha: pngMetadata(stored.data).hasAlpha,
    }
  }

  private objectPath(hash: string): string { return resolve(this.root, `${hash}.png`) }
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

function attachmentHash(ref: ImageAttachmentRef): string {
  const match = String(ref.attachmentId).match(/^sha256:([a-f0-9]{64})$/)
  if (!match) throw new AttachmentError('Screenshot attachment identifier is invalid.', 'INVALID_ATTACHMENT_REF')
  return match[1]!
}

function digest(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex') }
