import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'
import { expect, it, onTestFinished } from 'vitest'
import { archivePath, ARCHIVE_LIMITS, readExtensionDirectory, readExtensionTar, readExtensionZip } from '../src/extension-archives.ts'

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'extension-archive-test-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}
const signal = (): AbortSignal => new AbortController().signal

it('rejects traversal, absolute paths, backslashes and empty segments', () => {
  for (const path of ['../secret', 'a/../secret', '/tmp/secret', 'C:/secret', 'a\\b', 'a//b', 'a/./b', 'a\0b']) {
    expect(() => archivePath(path)).toThrow()
  }
  expect(archivePath('./skills/review/')).toBe('skills/review')
})

it('reads resource directories without following links and honours cancellation', async () => {
  const root = await directory()
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'SKILL.md'), 'skill')
  await writeFile(join(root, 'assets/template.txt'), 'template')
  expect([...(await readExtensionDirectory(root, signal())).keys()].sort()).toEqual(['SKILL.md', 'assets/template.txt'])
  await symlink(join(root, 'SKILL.md'), join(root, 'assets/link'))
  await expect(readExtensionDirectory(root, signal())).rejects.toThrow('links')
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'))
  await expect(readExtensionDirectory(root, cancelled.signal)).rejects.toThrow('cancelled')
})

it('reads ZIP previews and rejects traversal, excess entries and compressed expansion bombs', async () => {
  const root = await directory()
  const filename = join(root, 'package.zip')
  await writeFile(filename, zipSync({ 'package/SKILL.md': new TextEncoder().encode('skill') }))
  expect((await readExtensionZip(filename, signal())).get('package/SKILL.md')?.toString()).toBe('skill')
  await writeFile(filename, zipSync({ '../secret': new Uint8Array([1]) }))
  await expect(readExtensionZip(filename, signal())).rejects.toThrow()
  await writeFile(filename, zipSync(Object.fromEntries(Array.from({ length: ARCHIVE_LIMITS.files + 1 }, (_, index) => [`f${index}`, new Uint8Array()]))))
  await expect(readExtensionZip(filename, signal())).rejects.toThrow('entries')
  const bomb = Buffer.from(zipSync({ bomb: new Uint8Array(1024) }))
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  bomb.writeUInt32LE(ARCHIVE_LIMITS.extractedBytes + 1, central + 24)
  await writeFile(filename, bomb)
  await expect(readExtensionZip(filename, signal())).rejects.toThrow('size')
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'))
  await expect(readExtensionZip(filename, cancelled.signal)).rejects.toThrow('cancelled')
})

it('rejects malformed or cancelled tar downloads', async () => {
  await expect(readExtensionTar(gzipSync('invalid tar'), signal())).rejects.toThrow()
  const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'))
  await expect(readExtensionTar(Buffer.alloc(0), cancelled.signal)).rejects.toThrow('cancelled')
})
