import { describe, expect, it } from 'vitest'
import { resolveXiaoyinProductServerUrl } from '../src/xiaoyin-product-config.ts'

describe('Xiaoyin product configuration', () => {
  it('reads the packaged resource and ignores process overrides', () => {
    const reads: string[] = []
    const result = resolveXiaoyinProductServerUrl({
      packaged: true,
      resourcesPath: '/installed/resources',
      appPath: '/installed/app.asar',
      environment: { XIAOYIN_SERVER_URL: 'https://untrusted.example.test' },
      readFile: (path) => { reads.push(path); return JSON.stringify({ version: 1, serverUrl: 'http://192.168.2.67:30081/' }) },
    })
    expect(result).toBe('http://192.168.2.67:30081')
    expect(reads).toEqual(['/installed/resources/xiaoyin/product.json'])
  })

  it('allows an unpackaged development override without reading the resource', () => {
    const result = resolveXiaoyinProductServerUrl({
      packaged: false,
      resourcesPath: '/unused',
      appPath: '/workspace/apps/desktop',
      environment: { XIAOYIN_SERVER_URL: 'https://xiaoyin.example.test' },
      readFile: () => { throw new Error('must not read') },
    })
    expect(result).toBe('https://xiaoyin.example.test')
  })

  it.each([
    [{ version: 2, serverUrl: 'https://xiaoyin.example.test' }, 'schema version 1'],
    [{ version: 1, serverUrl: 'file:///tmp/server' }, 'HTTP(S) origin'],
    [{ version: 1, serverUrl: 'https://xiaoyin.example.test/api' }, 'HTTP(S) origin'],
    [{ version: 1, serverUrl: 'https://user:secret@xiaoyin.example.test' }, 'HTTP(S) origin'],
  ])('rejects invalid packaged configuration %#', (document, message) => {
    expect(() => resolveXiaoyinProductServerUrl({
      packaged: true,
      resourcesPath: '/installed/resources',
      appPath: '/installed/app.asar',
      readFile: () => JSON.stringify(document),
    })).toThrow(message)
  })
})
