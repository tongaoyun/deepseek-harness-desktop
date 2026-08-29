import { describe, expect, it } from 'vitest'
import { pngMetadata } from './local-attachment-store-plugin.js'

describe('local screenshot attachment store', () => {
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
})
