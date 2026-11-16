import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import type { LibraryFileChunk, LibraryFileTransfer } from '@deepseek-harness/product/protocol'
import { LibraryFiles } from '../src/library-files.ts'
import { resolveLibraryFilePolicy } from '../src/library-file-policy.ts'
const libraryId = '11111111-1111-4111-8111-111111111111'
const entryId = '22222222-2222-4222-8222-222222222222'
const bytes = Buffer.from('中文资料 {{literal}}')
const sha256 = createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'library-files-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  let employee = 'alice'
  let destination: string | undefined
  let accessed = 0
  let content: Buffer = bytes
  const metadata = { id: entryId, libraryId, parentId: null, name: '中文资料.md', kind: 'FILE', sha256,
    mediaType: 'text/markdown', sizeBytes: bytes.length, version: 1,
    createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' }
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'token', fetch: async (input) => {
    if ((typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).endsWith('/access')) { accessed++; return Response.json({ success: true, data: true }) }
    if ((typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes('/content?')) return new Response(Uint8Array.from(content), { headers: { 'Content-Type': 'text/markdown' } })
    return Response.json({ success: true, data: metadata })
  } })
  onTestFinished(() =>{  api.close() })
  const files = new LibraryFiles({ directory, policy: resolveLibraryFilePolicy({ previewMaxBytes: 4, downloadMaxBytes: 1024 }),
    getEmployeeId: () => employee, renderOffice: async () => { throw new Error('Not Office') },
    saveDialog: async () => destination, openPath: async () => '' })
  onTestFinished(() => files.close())
  const invoke = (method: Parameters<LibraryFiles['invoke']>[0], input = {}) => files.invoke(method, input, api,
    { authenticated: true, employeeId: 'alice' })
  return { directory, files, invoke, metadata, get accessed() { return accessed }, downloadTo: (value: string) => { destination = value }, replace: (value: Buffer) => { content = value }, switchEmployee: () => { employee = 'bob' } }
}
it('admits a complete attachment under its download policy and closes its private transfer', async () => {
  const f = await fixture()
  await expect(f.invoke('library.files.preview.open', { libraryId, entryId })).rejects.toMatchObject({ code: 'LIBRARY_PREVIEW_TOO_LARGE' })
  const transfer = await f.invoke('library.files.preview.open', { libraryId, entryId, attachment: true, sha256 }) as LibraryFileTransfer
  const chunk = await f.invoke('library.files.preview.read', { transferId: transfer.transferId, offset: 0 }) as LibraryFileChunk
  expect(Buffer.from(chunk.data)).toEqual(bytes)
  expect(chunk.eof).toBe(true)
  await f.invoke('library.files.preview.close', { transferId: transfer.transferId })
  expect(await readdir(f.directory)).toEqual([])
})
it.each(['digest', 'length'] as const)('rejects a mismatched %s and removes incomplete bytes', async (mismatch) => {
  const f = await fixture()
  f.replace(mismatch === 'digest' ? Buffer.alloc(bytes.length, 65) : bytes.subarray(1))
  await expect(f.invoke('library.files.preview.open', { libraryId, entryId, attachment: true, sha256 }))
    .rejects.toMatchObject({ code: 'LIBRARY_PREVIEW_SOURCE_CHANGED' })
  expect(await readdir(f.directory)).toEqual([])
})
it('revokes an open transfer when the employee changes or its exact source changes', async () => {
  const f = await fixture()
  const transfer = await f.invoke('library.files.preview.open', { libraryId, entryId, attachment: true, sha256 }) as LibraryFileTransfer
  f.metadata.sha256 = 'b'.repeat(64)
  await expect(f.invoke('library.files.preview.read', { transferId: transfer.transferId, offset: 0 }))
    .rejects.toMatchObject({ code: 'LIBRARY_PREVIEW_SOURCE_CHANGED' })
  expect(await readdir(f.directory)).toEqual([])
  f.metadata.sha256 = sha256
  const next = await f.invoke('library.files.preview.open', { libraryId, entryId, attachment: true, sha256 }) as LibraryFileTransfer
  f.switchEmployee()
  await expect(f.invoke('library.files.preview.read', { transferId: next.transferId, offset: 0 }))
    .rejects.toMatchObject({ code: 'LIBRARY_ACCESS_DENIED' })
  await f.files.resetIdentity()
  expect(await readdir(f.directory)).toEqual([])
})

it('downloads the exact selected version and retains cancellation as a separate result', async () => {
  const f = await fixture()
  await expect(f.invoke('library.files.download', { libraryId, entryId, sha256: 'b'.repeat(64) }))
    .rejects.toMatchObject({ code: 'LIBRARY_PREVIEW_SOURCE_CHANGED' })
  await expect(f.invoke('library.files.download', { libraryId, entryId, sha256 })).resolves.toEqual({ cancelled: true })
  expect(await readdir(f.directory)).toEqual([])
})

it('records successful employee access before saving exact download bytes, without counting cancellations', async () => {
  const f = await fixture()
  await f.invoke('library.files.download', { libraryId, entryId, sha256 })
  expect(f.accessed).toBe(0)
  const destination = join(f.directory, 'saved.md')
  f.downloadTo(destination)
  await expect(f.invoke('library.files.download', { libraryId, entryId, sha256 })).resolves.toEqual({ cancelled: false })
  expect(await readFile(destination)).toEqual(bytes)
  expect(f.accessed).toBe(1)
})
