/** Bounded content reads use real files and close handles on every outcome. */
import { promises as fs } from 'node:fs'
import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readContentFile } from '../src/content-files.ts'

async function fixture(content = Buffer.from([0, 1, 128, 255])) {
  const root = await mkdtemp(join(tmpdir(), 'content-file-'))
  const file = join(root, '中文模板.bin')
  await writeFile(file, content)
  const open = fs.open
  const handles: Awaited<ReturnType<typeof open>>[] = []
  const probe = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    handles.push(handle)
    return handle
  })
  onTestFinished(async () => {
    probe.mockRestore()
    await Promise.all(handles.map(handle => handle.close()))
    await rm(root, { recursive: true, force: true })
  })
  return { root, file, content, handles, open }
}

it.each([0, 4])('reads complete binary files at the exact %i-byte limit and closes the handle', async (size) => {
  const { file, content, handles } = await fixture(Buffer.from([0, 1, 128, 255]).subarray(0, size))
  expect(await readContentFile(file, size)).toEqual(content)
  expect(handles.map(handle => handle.fd)).toEqual([-1])
})

it('rejects a file one byte over the limit before starting a stream', async () => {
  const { file, content, handles } = await fixture()
  await expect(readContentFile(file, content.length - 1)).rejects.toMatchObject({ code: 'error.contentFile.tooLarge' })
  expect(handles.map(handle => handle.fd)).toEqual([-1])
})

it.each(['grow', 'shrink', 'rewrite', 'rewrite-preserving-mtime'] as const)('rejects %s after the size check without reading subsequent growth', async (change) => {
  const { file, content, handles, open } = await fixture()
  if (change === 'rewrite-preserving-mtime') await fs.utimes(file, new Date(1000), new Date(1000))
  let readBytes = 0
  const probe = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    handles.push(handle)
    const stat = handle.stat.bind(handle), createStream = handle.createReadStream.bind(handle)
    vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
      const info = await stat()
      await writeFile(file, change === 'grow' ? Buffer.alloc(1024 * 1024)
        : change === 'shrink' ? content.subarray(0, 1) : Buffer.alloc(content.length, 42))
      if (change === 'rewrite') await fs.utimes(file, info.atime, new Date(info.mtimeMs + 2000))
      if (change === 'rewrite-preserving-mtime') await fs.utimes(file, info.atime, info.mtime)
      return info
    })
    vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
      const stream = createStream(options)
      stream.on('data', (chunk) => { readBytes += Buffer.byteLength(chunk) })
      return stream
    })
    return handle
  })
  try {
    await expect(readContentFile(file, 1024 * 1024)).rejects.toMatchObject({ code: 'error.contentFile.changed' })
    expect(readBytes).toBe(change === 'grow' ? content.length + 1 : change === 'shrink' ? 1 : content.length)
    expect(handles.map(handle => handle.fd)).toEqual([-1])
  } finally { probe.mockRestore() }
  if (change.startsWith('rewrite')) expect(await readContentFile(file, content.length)).toEqual(Buffer.alloc(content.length, 42))
})

it('honors cancellation during the final file check and releases the handle for retry', async () => {
  const { file, content, handles, open } = await fixture()
  const controller = new AbortController(), reason = new Error('Content view closed')
  const probe = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), stat = handle.stat.bind(handle)
    handles.push(handle)
    vi.spyOn(handle, 'stat').mockImplementationOnce(() => stat()).mockImplementationOnce(async () => {
      const info = await stat()
      controller.abort(reason)
      return info
    })
    return handle
  })
  try {
    await expect(readContentFile(file, content.length, controller.signal)).rejects.toBe(reason)
    expect(handles.map(handle => handle.fd)).toEqual([-1])
  } finally { probe.mockRestore() }
  expect(await readContentFile(file, content.length)).toEqual(content)
})

it('cancels an active stream, closes its handle and permits a complete retry', async () => {
  const { file, content, handles, open } = await fixture(Buffer.alloc(1024 * 1024, 255))
  const controller = new AbortController(), reason = new Error('Content view closed')
  let readBytes = 0
  const probe = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args), createStream = handle.createReadStream.bind(handle)
    handles.push(handle)
    vi.spyOn(handle, 'createReadStream').mockImplementation((options) => {
      const stream = createStream(options)
      stream.once('data', (chunk) => { readBytes += Buffer.byteLength(chunk); controller.abort(reason) })
      return stream
    })
    return handle
  })
  try {
    const outcome = await readContentFile(file, content.length, controller.signal)
      .then(() => ({ completed: true }), (error: unknown) => ({ error }))
    expect(outcome).toHaveProperty('error')
    expect(controller.signal.aborted).toBe(true)
    expect(readBytes).toBeGreaterThan(0)
    expect(readBytes).toBeLessThan(content.length)
    expect(handles.map(handle => handle.fd)).toEqual([-1])
  } finally { probe.mockRestore() }
  expect(await readContentFile(file, content.length)).toEqual(content)
  expect(handles.every(handle => handle.fd === -1)).toBe(true)
})

it('rejects an already-cancelled request before opening a file', async () => {
  const { file, handles } = await fixture()
  const controller = new AbortController(), reason = new Error('Content view closed')
  controller.abort(reason)
  await expect(readContentFile(file, 4, controller.signal)).rejects.toBe(reason)
  expect(handles).toHaveLength(0)
})

it('rejects directories and final symbolic links without retaining a handle', async () => {
  const { root, file, handles } = await fixture()
  await expect(readContentFile(root, 1024 * 1024)).rejects.toMatchObject({ code: 'error.contentFile.invalid' })
  const link = join(root, 'linked.bin')
  await symlink(file, link)
  await expect(readContentFile(link, 1024 * 1024)).rejects.toMatchObject({ code: 'error.contentFile.invalid' })
  expect(handles).toHaveLength(0)
})

it('rejects a resource replaced between the path check and opening the file', async () => {
  const { root, file, content, handles, open } = await fixture()
  const probe = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    await rename(file, join(root, 'original.bin'))
    await writeFile(file, Buffer.alloc(content.length, 42))
    const handle = await open(...args)
    handles.push(handle)
    return handle
  })
  try {
    await expect(readContentFile(file, content.length)).rejects.toMatchObject({ code: 'error.contentFile.changed' })
    expect(handles.map(handle => handle.fd)).toEqual([-1])
  } finally { probe.mockRestore() }
})
