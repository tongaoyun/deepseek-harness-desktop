import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, symlink, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, onTestFinished } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { LibraryUploads } from '../src/library-upload.ts'
const libraryId = '11111111-1111-4111-8111-111111111111'
const entryId = '22222222-2222-4222-8222-222222222222'
const timestamp = '2026-11-13T01:00:00Z'
const key = 'library-upload-regression-key'
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'library-upload-test-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, '中文资料.md'); await writeFile(path, '资料 {{literal}}')
  let employee: string | undefined = 'employee'
  const picker = vi.fn(async () => [path])
  const upload = vi.fn(async (init?: RequestInit) => {
    const form = init?.body
    if (!(form instanceof FormData)) throw new Error('Missing multipart upload')
    const file = form.get('file')
    if (!(file instanceof File)) throw new Error('Missing selected file')
    const bytes = new Uint8Array(await file.arrayBuffer())
    return { id: entryId, libraryId, parentId: form.get('parentId') ?? null, name: file.name, kind: 'FILE',
      sha256: createHash('sha256').update(bytes).digest('hex'), mediaType: 'application/octet-stream', sizeBytes: bytes.byteLength,
      favorite: false, version: 1, createdAt: timestamp, updatedAt: timestamp }
  })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'token', fetch: async (input, init) => {
    const url = new URL((typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
    return Response.json({ success: true, data: url.pathname.endsWith('/file-policy') ? 1024 : await upload(init) })
  } })
  onTestFinished(() =>{  api.close() })
  const uploads = new LibraryUploads(() => employee, picker, 1024, 1000)
  onTestFinished(() =>{  uploads.close() })
  const invoke = (method: string, input = {}, signal = new AbortController().signal) => uploads.invoke(method, input, api, 'employee', signal)
  const select = async () => { const result = await invoke('library.files.upload.select') as { selectionId: string }[]; return result[0]!.selectionId }
  return { path, directory, uploads, picker, upload, invoke, select, changeEmployee: () => { employee = 'other'; uploads.resetIdentity() } }
}
it('uploads complete Chinese files and replays the same receipt without a second write', async () => {
  const f = await fixture(), selectionId = await f.select()
  const input = { selectionId, libraryId, parentId: null, key }
  const result = await f.invoke('library.files.upload', input)
  expect(result).toMatchObject({ name: '中文资料.md' })
  await expect(f.invoke('library.files.upload', input)).resolves.toEqual(result)
  expect(f.upload).toHaveBeenCalledOnce()
  await expect(f.invoke('library.files.upload', { ...input, key: 'another-library-upload-key' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  await f.invoke('library.files.upload.discard', { selectionId })
  await expect(f.invoke('library.files.upload', input)).rejects.toMatchObject({ code: 'LIBRARY_FILE_INVALID' })
})
it('retries an unknown result with the same key and exact bytes, while rejecting duplicate requests', async () => {
  const f = await fixture(), selectionId = await f.select(), pending = Promise.withResolvers<never>()
  f.upload.mockImplementationOnce(async () => pending.promise)
  const input = { selectionId, libraryId, parentId: null, key }
  const first = expect(f.invoke('library.files.upload', input)).rejects.toThrow()
  await vi.waitFor(() =>{  expect(f.upload).toHaveBeenCalledOnce() })
  await expect(f.invoke('library.files.upload', input)).rejects.toThrow('progress')
  pending.reject(new Error('Connection lost'))
  await first
  await f.invoke('library.files.upload', input)
  expect(f.upload).toHaveBeenCalledTimes(2)
  expect(f.upload.mock.calls.map(([init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([key, key])
})
it.each(['changed', 'symlink'] as const)('rejects a %s file after selection before any upload', async (kind) => {
  const f = await fixture(), selectionId = await f.select()
  if (kind === 'changed') await writeFile(f.path, 'different')
  else { await rm(f.path); await symlink(join(f.directory, 'absent'), f.path) }
  await expect(f.invoke('library.files.upload', { selectionId, libraryId, parentId: null, key })).rejects.toThrow()
  expect(f.upload).not.toHaveBeenCalled()
})
it('rejects a same-size rewrite after selection even when its modification time is restored, then permits reselection', async () => {
  const f = await fixture()
  const timestamp = new Date('2026-01-01T00:00:00.000Z')
  await utimes(f.path, timestamp, timestamp)
  const before = await stat(f.path), selectionId = await f.select()
  await writeFile(f.path, Buffer.alloc(before.size, 0x78))
  await utimes(f.path, before.atime, before.mtime)
  const after = await stat(f.path)
  expect(after.size).toBe(before.size)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(after.ctimeMs).not.toBe(before.ctimeMs)
  await expect(f.invoke('library.files.upload', { selectionId, libraryId, parentId: null, key }))
    .rejects.toMatchObject({ code: 'LIBRARY_FILE_INVALID' })
  expect(f.upload).not.toHaveBeenCalled()
  const next = await f.select()
  await expect(f.invoke('library.files.upload', { selectionId: next, libraryId, parentId: null, key }))
    .resolves.toMatchObject({ sha256: createHash('sha256').update(Buffer.alloc(before.size, 0x78)).digest('hex') })
  expect(f.upload).toHaveBeenCalledOnce()
})
it('expires idle handles and prevents the next employee from reusing a selection', async () => {
  const f = await fixture(), selectionId = await f.select()
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1001)
  try { await expect(f.invoke('library.files.upload', { selectionId, libraryId, parentId: null, key })).rejects.toMatchObject({ code: 'LIBRARY_FILE_INVALID' }) }
  finally { now.mockRestore() }
  const next = await f.select(); f.changeEmployee()
  await expect(f.invoke('library.files.upload', { selectionId: next, libraryId, parentId: null, key })).rejects.toMatchObject({ code: 'LIBRARY_ACCESS_REVOKED' })
  expect(f.upload).not.toHaveBeenCalled()
})
it('does not publish a cancelled native picker result', async () => {
  const f = await fixture(), pending = Promise.withResolvers<string[]>(), controller = new AbortController()
  f.picker.mockImplementationOnce(() => pending.promise)
  const read = expect(f.invoke('library.files.upload.select', {}, controller.signal)).rejects.toThrow()
  await vi.waitFor(() =>{  expect(f.picker).toHaveBeenCalledOnce() })
  controller.abort(); pending.resolve([f.path]); await read
  expect(f.upload).not.toHaveBeenCalled()
})

it('takes conversation origin only from the validated main-owned deliverable selection', async () => {
  let origin: FormDataEntryValue | null = null
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'token', fetch: async (input, init) => {
    if ((typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes('/file-policy')) return Response.json({ success: true, data: 1024 })
    const form = init?.body
    if (!(form instanceof FormData)) throw new Error('Missing upload')
    origin = form.get('sourceSessionId')
    return Response.json({ success: true, data: { id: entryId, libraryId, parentId: null, name: '成果.md', kind: 'FILE', sha256: createHash('sha256').update('result').digest('hex'), mediaType: 'text/markdown', sizeBytes: 6, favorite: false, version: 1, createdAt: timestamp, updatedAt: timestamp } })
  } })
  const readArchive = vi.fn(async () => ({ name: '成果.md', dataBase64: Buffer.from('result').toString('base64') }))
  const uploads = new LibraryUploads(() => 'employee', async () => [], 1024, 1000, readArchive)
  onTestFinished(() => { uploads.close(); api.close() })
  const signal = new AbortController().signal
  const selected = await uploads.invoke('library.files.archive.select', { sessionId: 'native-source', seq: 4, index: 0 }, api, 'employee', signal) as { selectionId: string }[]
  const input = { selectionId: selected[0]!.selectionId, libraryId, parentId: null, key }
  await expect(uploads.invoke('library.files.upload', { ...input, sourceSessionId: 'forged' }, api, 'employee', signal)).rejects.toThrow()
  await uploads.invoke('library.files.upload', input, api, 'employee', signal)
  expect(origin).toBe('native-source')
  expect(readArchive).toHaveBeenCalledWith({ sessionId: 'native-source', seq: 4, index: 0, maxBytes: 1024 }, signal)
})
