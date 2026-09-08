import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalAttachmentStore, { jpegMetadata, pngMetadata } from './local-attachment-store-plugin.js'

describe('local screenshot attachment store', () => {
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

  it('rejects non-PNG content', () => {
    expect(() => pngMetadata(Buffer.from('not-an-image'))).toThrow(/valid PNG/)
  })

  it('reads JPEG frame dimensions for DingTalk images', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9])
    expect(jpegMetadata(jpeg)).toEqual({ width: 1280, height: 720, hasAlpha: false })
  })
})
