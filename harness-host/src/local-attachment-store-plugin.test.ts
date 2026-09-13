import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalAttachmentStore, { jpegMetadata, pngMetadata } from './local-attachment-store-plugin.js'
import { IMAGE_LIMITS } from './image-limits.js'

describe('local screenshot attachment store', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  it('keeps JPEG bytes and media type consistent when projecting cached connector images to a model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-jpeg-'))
    try {
      const store = new LocalAttachmentStore(new Context(), { root: directory })
      const data = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9])
      const ref = await store.saveImage({ data, mediaType: 'image/jpeg', name: 'photo.jpg' })
      const request = await store.readImageRequest(ref, { maxBytes: 1024, maxPixels: 4_000_000 })
      expect(request.mediaType).toBe('image/jpeg')
      expect(request.data).toEqual(data)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('reads bounded PNG header metadata', () => {
    const header = Buffer.alloc(33)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
    header.writeUInt32BE(13, 8)
    header.write('IHDR', 12, 'ascii')
    header.writeUInt32BE(1280, 16)
    header.writeUInt32BE(720, 20)
    header[24] = 8
    header[25] = 6
    expect(pngMetadata(header)).toEqual({ width: 1280, height: 720, hasAlpha: true })
  })

  it('restores durable references after restart and rejects another employee root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xiaoyin-attachment-isolation-'))
    try {
      const firstRoot = join(root, 'employee-a')
      const secondRoot = join(root, 'employee-b')
      const ref = await new LocalAttachmentStore(new Context(), { root: firstRoot }).saveImage({ data: png, mediaType: 'image/png' })
      expect((await new LocalAttachmentStore(new Context(), { root: firstRoot }).readImage(ref)).data).toEqual(png)
      await expect(new LocalAttachmentStore(new Context(), { root: secondRoot }).readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('distinguishes missing, corrupt and mismatched attachment references', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-attachment-corruption-'))
    try {
      const store = new LocalAttachmentStore(new Context(), { root: directory })
      const ref = await store.saveImage({ data: png, mediaType: 'image/png' })
      const hash = String(ref.attachmentId).slice(7)
      await writeFile(join(directory, `${hash}.image`), Buffer.from('corrupt'))
      await expect(store.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
      const healed = await store.saveImage({ data: png, mediaType: 'image/png' })
      expect((await store.readImage(healed)).data).toEqual(png)
      await rm(join(directory, `${hash}.image`))
      await expect(store.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
      const restored = await store.saveImage({ data: png, mediaType: 'image/png' })
      await expect(store.readImage({ ...restored, width: 2 })).rejects.toMatchObject({ code: 'INVALID_ATTACHMENT_REF' })
      await expect(store.readImage(restored, AbortSignal.abort())).rejects.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not return a reference when the attachment directory becomes unwritable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-attachment-write-failure-'))
    const root = join(directory, 'images')
    try {
      const store = new LocalAttachmentStore(new Context(), { root })
      await rename(root, join(directory, 'old-images'))
      await writeFile(root, 'not a directory')
      await expect(store.saveImage({ data: png, mediaType: 'image/png' })).rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
      expect(await readdir(join(directory, 'old-images'))).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects an oversized corrupted cache without reading the entire file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-attachment-oversized-'))
    try {
      const store = new LocalAttachmentStore(new Context(), { root: directory })
      const ref = await store.saveImage({ data: png, mediaType: 'image/png' })
      const file = await open(join(directory, `${String(ref.attachmentId).slice(7)}.image`), 'r+')
      try { await file.truncate(IMAGE_LIMITS.maxImageBytes + 1) } finally { await file.close() }
      await expect(store.readImage(ref)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not replace an existing valid attachment after a second save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-attachment-idempotent-'))
    try {
      const store = new LocalAttachmentStore(new Context(), { root: directory })
      const first = await store.saveImage({ data: png, mediaType: 'image/png' })
      const second = await store.saveImage({ data: png, mediaType: 'image/png' })
      expect(second.attachmentId).toBe(first.attachmentId)
      expect((await store.readImage(first)).data).toEqual(png)
      expect(await readdir(directory)).toEqual([`${String(first.attachmentId).slice(7)}.image`])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects non-PNG content', () => {
    expect(() => pngMetadata(Buffer.from('not-an-image'))).toThrow(/valid PNG/)
  })

  it('reads JPEG frame dimensions for DingTalk images', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9])
    expect(jpegMetadata(jpeg)).toEqual({ width: 1280, height: 720, hasAlpha: false })
  })
})
