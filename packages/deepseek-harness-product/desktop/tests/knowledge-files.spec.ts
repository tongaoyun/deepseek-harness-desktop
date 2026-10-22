import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import type { KnowledgeFileChunk, KnowledgeFileTransfer } from '@deepseek-harness/product/protocol'
import { KnowledgeFiles } from '../src/knowledge-files.ts'
import { KNOWLEDGE_FILE_CHUNK_BYTES, resolveKnowledgeFilePolicy } from '../src/knowledge-file-policy.ts'

const identity = { knowledgeBaseId: 'personal', documentId: 'document' }
const employee = { authenticated: true, employeeId: 'employee-a' }

async function fixture(data = new Uint8Array(KNOWLEDGE_FILE_CHUNK_BYTES + 3)) {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-files-'))
  let employeeId = employee.employeeId
  let revoked = false
  let version = 'v1'
  let updatedAt = '2026-10-10T00:00:00Z'
  let filename = 'original.pdf'
  let sourceType = 'file'
  let sizeBytes = data.byteLength
  const calls: string[] = []
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'main-only-token', getEmployeeId: () => employeeId,
    fetch: async (url, init) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      calls.push(path)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer main-only-token')
      if (revoked) return Response.json({ success: false, errCode: 'KNOWLEDGE_ACCESS_REVOKED', errMessage: 'Revoked' }, { status: 403 })
      if (path.endsWith('/metadata')) return Response.json({ success: true, data: { ...identity, id: identity.documentId, filename,
        sourceType, contentVersion: version, updatedAt, sizeBytes,
        previewMaxBytes: 50 * 1024 * 1024, downloadMaxBytes: 250 * 1024 * 1024 } })
      return new Response(data, { headers: { 'content-type': 'application/pdf' } })
    } })
  const saveDialog = vi.fn(async (_filename: string) => join(directory, 'saved.pdf'))
  const openPath = vi.fn(async (_path: string) => '')
  const renderOffice = vi.fn<(identity: Readonly<{ knowledgeBaseId: string; documentId: string }>, signal: AbortSignal) => Promise<unknown>>(async () => { throw new Error('not used') })
  const files = new KnowledgeFiles({ directory: join(directory, 'private'), policy: resolveKnowledgeFilePolicy(),
    getEmployeeId: () => employeeId, renderOffice, saveDialog, openPath })
  onTestFinished(async () => { await files.close(); api.close(); await rm(directory, { recursive: true, force: true }) })
  const invoke = (method: Parameters<KnowledgeFiles['invoke']>[0], payload: Readonly<Record<string, unknown>>, signal?: AbortSignal) => files.invoke(method, payload, api,
    { ...employee, employeeId }, signal)
  return { files, api, invoke, directory, calls, saveDialog, openPath, renderOffice,
    revoke: () => { revoked = true }, version: () => { version = 'v2' }, employee: () => { employeeId = 'employee-b' },
    indexing: () => { updatedAt = '2026-10-10T00:01:00Z' },
    size: (value: number) => { sizeBytes = value },
    filename: (value: string) => { filename = value }, sourceType: (value: string) => { sourceType = value } }
}

it.each(['knowledge.documents.preview.open', 'knowledge.documents.download', 'knowledge.documents.openExternal'] as const)(
  'rejects incomplete or enlarged originals before exposing bytes through %s', async (method) => {
    const data = new Uint8Array([1, 2, 3])
    const h = await fixture(data)
    for (const size of [4, 2, 0]) {
      h.size(size)
      await expect(h.invoke(method, identity)).rejects.toMatchObject({ code: 'KNOWLEDGE_PREVIEW_SOURCE_CHANGED', retryable: true })
      expect(await readdir(join(h.directory, 'private'))).toEqual([])
      expect(h.saveDialog).not.toHaveBeenCalled()
      expect(h.openPath).not.toHaveBeenCalled()
    }
    h.size(data.byteLength)
    const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
    const chunk = await h.invoke('knowledge.documents.preview.read', { transferId: opened.transferId, offset: 0 }) as KnowledgeFileChunk
    expect(chunk.data).toEqual(data)
  },
)

it('keeps manual Markdown readable when file-size metadata does not describe its text', async () => {
  const h = await fixture(new TextEncoder().encode('# Original'))
  h.sourceType('manual'); h.size(0)
  const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  expect(opened.byteLength).toBe(10)
})

it('streams original bytes into private storage and returns bounded structured-clone chunks', async () => {
  const data = new Uint8Array(KNOWLEDGE_FILE_CHUNK_BYTES + 3); data.fill(71)
  const h = await fixture(data)
  const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  expect(opened).toMatchObject({ byteLength: data.length, chunkSize: KNOWLEDGE_FILE_CHUNK_BYTES, fileName: 'original.pdf' })
  expect(JSON.stringify(opened)).not.toMatch(/token|https:|private|employee-a/u)
  const first = await h.invoke('knowledge.documents.preview.read', { transferId: opened.transferId, offset: 0 }) as KnowledgeFileChunk
  expect(first.data).toBeInstanceOf(Uint8Array)
  expect(first.data).toEqual(data.subarray(0, KNOWLEDGE_FILE_CHUNK_BYTES))
  expect(first.eof).toBe(false)
  const last = await h.invoke('knowledge.documents.preview.read', { transferId: opened.transferId, offset: first.data.length }) as KnowledgeFileChunk
  expect(last).toEqual({ offset: first.data.length, eof: true, data: data.subarray(first.data.length) })
  const names = await readdir(join(h.directory, 'private'))
  const mode = await stat(join(h.directory, 'private', names[0]!, 'original.pdf'))
  expect(mode.mode & 0o777).toBe(0o600)
  await h.invoke('knowledge.documents.preview.close', { transferId: opened.transferId })
  expect(await readdir(join(h.directory, 'private'))).toEqual([])
})

it.each(['permission', 'version', 'employee'] as const)('destroys prior bytes when %s changes', async (change) => {
  const h = await fixture()
  const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  if (change === 'permission') h.revoke()
  else if (change === 'version') h.version()
  else { h.employee(); await h.files.resetIdentity() }
  await expect(h.invoke('knowledge.documents.preview.read', { transferId: opened.transferId, offset: 0 }))
    .rejects.toMatchObject({ code: change === 'permission' ? 'KNOWLEDGE_ACCESS_REVOKED'
      : change === 'version' ? 'KNOWLEDGE_PREVIEW_SOURCE_CHANGED' : 'KNOWLEDGE_PREVIEW_EXPIRED' })
  expect(await readdir(join(h.directory, 'private'))).toEqual([])
})

it('lets a revoked employee close a file without a fresh permission request', async () => {
  const h = await fixture()
  const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  const calls = h.calls.length
  h.revoke()
  await h.invoke('knowledge.documents.preview.close', { transferId: opened.transferId })
  expect(h.calls).toHaveLength(calls)
})

it.each([
  ['CON.pdf', '_CON.pdf'],
  ['con.report.pdf', '_con.report.pdf'],
  ['PrN.pdf', '_PrN.pdf'],
  ['AUX.pdf', '_AUX.pdf'],
  ['NUL.pdf', '_NUL.pdf'],
  ['COM1.pdf', '_COM1.pdf'],
  ['lpt9.pdf', '_lpt9.pdf'],
  ['COM¹.pdf', '_COM¹.pdf'],
  ['LPT².pdf', '_LPT².pdf'],
  ['CONIN$.pdf', '_CONIN$.pdf'],
  ['CONOUT$.pdf', '_CONOUT$.pdf'],
  ['CON .pdf', '_CON.pdf'],
  [`CON${' '.repeat(300)}report.pdf`, '_CON.pdf'],
  [`NUL.${'a'.repeat(300)}.pdf`, `_NUL.${'a'.repeat(231)}.pdf`],
  ['report.pdf. ', 'report.pdf'],
  ['报告.pdf ', '报告.pdf'],
  ['COM0.pdf', 'COM0.pdf'],
  ['company.pdf', 'company.pdf'],
])('uses a portable filename for preview, download and external opening: %s', async (filename, expected) => {
  const data = new Uint8Array([1, 2, 3])
  const h = await fixture(data)
  h.filename(filename)
  const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  expect(opened.fileName).toBe(expected)
  expect(Buffer.byteLength(opened.fileName)).toBeLessThanOrEqual(240)
  const chunk = await h.invoke('knowledge.documents.preview.read', { transferId: opened.transferId, offset: 0 }) as KnowledgeFileChunk
  expect(chunk.data).toEqual(data)
  await h.invoke('knowledge.documents.preview.close', { transferId: opened.transferId })

  await h.invoke('knowledge.documents.download', identity)
  expect(h.saveDialog).toHaveBeenCalledWith(expected)
  expect(await readFile(join(h.directory, 'saved.pdf'))).toEqual(Buffer.from(data))
  await h.invoke('knowledge.documents.openExternal', identity)
  const path = h.openPath.mock.calls[0]?.[0]
  expect(path).toBeDefined()
  expect(basename(path!)).toBe(expected)
  expect(await readFile(path!)).toEqual(Buffer.from(data))
})

it('removes a trailing dot exposed when an extensionless filename reaches the byte limit', async () => {
  const h = await fixture(new Uint8Array([1]))
  h.filename(`${'a'.repeat(239)}.${'b'.repeat(40)}`)
  const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  expect(opened.fileName).toBe('a'.repeat(239))
})

it('keeps reading the same original when indexing changes the document timestamp', async () => {
  const data = new Uint8Array([1, 2, 3])
  const h = await fixture(data)
  const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  h.indexing()
  await expect(h.invoke('knowledge.documents.preview.read', { transferId: opened.transferId, offset: 0 }))
    .resolves.toEqual({ data, offset: 0, eof: true })
})

it('accepts only sequential bounded conversion chunks and verifies the PDF before exposing it', async () => {
  const h = await fixture(new Uint8Array(4)); h.filename('original.docx')
  const transfer = await h.invoke('runtime.knowledge.preview.write.open', identity) as KnowledgeFileTransfer
  const pdf = Buffer.from('%PDF-1.7\noriginal\n%%EOF\n')
  await h.invoke('runtime.knowledge.preview.write.append', { transferId: transfer.transferId, offset: 0, dataBase64: pdf.toString('base64') })
  const completed = await h.invoke('runtime.knowledge.preview.write.commit', { transferId: transfer.transferId, missingFonts: ['Example'] }) as KnowledgeFileTransfer
  expect(completed).toMatchObject({ byteLength: pdf.length, mediaType: 'application/pdf', missingFonts: ['Example'] })
  const chunk = await h.invoke('runtime.knowledge.preview.readChunk', { transferId: transfer.transferId, offset: 0 })
  expect(chunk).toEqual({ offset: 0, eof: true, dataBase64: pdf.toString('base64') })
})

it('opens only the completed rendered transfer belonging to the requested original', async () => {
  const h = await fixture(new Uint8Array(4)); h.filename('original.docx')
  h.renderOffice.mockImplementation(async () => {
    const opened = await h.invoke('runtime.knowledge.preview.write.open', identity) as KnowledgeFileTransfer
    const pdf = Buffer.from('%PDF-1.7\noriginal\n%%EOF\n')
    await h.invoke('runtime.knowledge.preview.write.append', { transferId: opened.transferId, offset: 0, dataBase64: pdf.toString('base64') })
    return h.invoke('runtime.knowledge.preview.write.commit', { transferId: opened.transferId })
  })
  const opened = await h.invoke('knowledge.documents.preview.open', { ...identity, rendered: true }) as KnowledgeFileTransfer
  expect(opened.mediaType).toBe('application/pdf')
  expect(opened.maxBytes).toBe(100 * 1024 * 1024)
  await h.invoke('knowledge.documents.preview.close', { transferId: opened.transferId })
  h.renderOffice.mockImplementation(async () => h.invoke('knowledge.documents.preview.open', identity))
  await expect(h.invoke('knowledge.documents.preview.open', { ...identity, rendered: true })).rejects.toMatchObject({ code: 'KNOWLEDGE_PREVIEW_SOURCE_CHANGED' })
  expect(await readdir(join(h.directory, 'private'))).toEqual([])
})

it.each(['offset', 'oversize', 'invalid-pdf'] as const)('rejects invalid converted %s and removes the incomplete file', async (failure) => {
  const h = await fixture(new Uint8Array(4)); h.filename('original.docx')
  const transfer = await h.invoke('runtime.knowledge.preview.write.open', identity) as KnowledgeFileTransfer
  const write = { transferId: transfer.transferId, offset: failure === 'offset' ? 4 : 0,
    dataBase64: Buffer.from(failure === 'oversize' ? new Uint8Array(KNOWLEDGE_FILE_CHUNK_BYTES + 1) : 'invalid').toString('base64') }
  if (failure === 'invalid-pdf') {
    await h.invoke('runtime.knowledge.preview.write.append', write)
    await expect(h.invoke('runtime.knowledge.preview.write.commit', { transferId: transfer.transferId })).rejects.toMatchObject({ code: 'KNOWLEDGE_PREVIEW_INVALID' })
  } else await expect(h.invoke('runtime.knowledge.preview.write.append', write)).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
  expect(await readdir(join(h.directory, 'private'))).toEqual([])
})

it('downloads the original through a native save dialog and clears private staging', async () => {
  const data = new Uint8Array([1, 2, 3])
  const h = await fixture(data)
  expect(await h.invoke('knowledge.documents.download', identity)).toEqual({ cancelled: false })
  expect(h.calls.some(path => path.endsWith('/download'))).toBe(true)
  expect(h.saveDialog).toHaveBeenCalledWith('original.pdf')
  expect(await readFile(join(h.directory, 'saved.pdf'))).toEqual(Buffer.from(data))
  expect(await readdir(join(h.directory, 'private'))).toEqual([])
})

it.each([
  { filename: 'Meeting notes', sourceType: 'manual', exported: 'Meeting notes.md' },
  { filename: 'notes.markdown', sourceType: 'file', exported: 'notes.markdown' },
])('uses the original export extension for download and system-open: $filename', async ({ filename, sourceType, exported }) => {
  const h = await fixture(new TextEncoder().encode('# Notes'))
  h.filename(filename); h.sourceType(sourceType)
  await expect(h.invoke('knowledge.documents.download', identity)).resolves.toEqual({ cancelled: false })
  expect(h.saveDialog).toHaveBeenCalledWith(exported)
  await expect(h.invoke('knowledge.documents.openExternal', identity)).resolves.toEqual({ opened: true })
  expect(h.openPath.mock.calls.map(([path]) => basename(path))).toEqual([exported])
  const transfer = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  expect(transfer.fileName).toBe(exported)
  h.sourceType('url')
  await expect(h.invoke('knowledge.documents.preview.read', { transferId: transfer.transferId, offset: 0 }))
    .rejects.toMatchObject({ code: 'KNOWLEDGE_PREVIEW_SOURCE_CHANGED' })
})

it('bounds Unicode export names by UTF-8 bytes while retaining the Markdown suffix', async () => {
  const h = await fixture(new TextEncoder().encode('# Notes'))
  h.filename('\u4e2d'.repeat(100)); h.sourceType('manual')
  const transfer = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  expect(Buffer.byteLength(transfer.fileName)).toBeLessThanOrEqual(240)
  expect(transfer.fileName.endsWith('.md')).toBe(true)
  await h.invoke('knowledge.documents.preview.close', { transferId: transfer.transferId })
  await h.invoke('knowledge.documents.download', identity)
  const suggested = h.saveDialog.mock.calls[0]?.[0]
  expect(suggested).toBe(transfer.fileName)
})

it.each(['cancel', 'unload'] as const)('finishes %s with the native save dialog still open and ignores a late choice', async (action) => {
  const h = await fixture(new Uint8Array([1, 2, 3]))
  const shown = Promise.withResolvers<undefined>()
  const dialog = Promise.withResolvers<string>()
  h.saveDialog.mockImplementation(() => { shown.resolve(undefined); return dialog.promise })
  const controller = new AbortController()
  const pending = h.invoke('knowledge.documents.download', identity, controller.signal)
  const failure = expect(pending).rejects.toThrow()
  await shown.promise
  if (action === 'cancel') controller.abort(new Error('Cancelled'))
  else await h.files.close()
  await failure
  expect(await readdir(join(h.directory, 'private'))).toEqual([])
  const destination = join(h.directory, 'late-save.pdf')
  dialog.resolve(destination)
  await dialog.promise
  await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps external originals privately until lifecycle cleanup and refuses executable files', async () => {
  const h = await fixture(new Uint8Array([1, 2, 3]))
  expect(await h.invoke('knowledge.documents.openExternal', identity)).toEqual({ opened: true })
  expect(h.openPath).toHaveBeenCalledTimes(1)
  h.filename('untrusted.exe')
  await expect(h.invoke('knowledge.documents.openExternal', identity)).rejects.toMatchObject({ code: 'KNOWLEDGE_EXTERNAL_OPEN_UNSUPPORTED' })
  expect(h.openPath).toHaveBeenCalledTimes(1)
  await h.files.close()
  expect(await readdir(join(h.directory, 'private'))).toEqual([])
})

it('startup cleanup removes only owned transfer paths and unlinks a symlink without following it', async () => {
  const h = await fixture(new Uint8Array([1]))
  const privateDirectory = join(h.directory, 'private')
  const outside = join(h.directory, 'outside.txt')
  await writeFile(outside, 'retained')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(privateDirectory)
  await symlink(outside, join(privateDirectory, 'transfer-abcdef'))
  await writeFile(join(privateDirectory, 'unowned'), 'retained')
  const opened = await h.invoke('knowledge.documents.preview.open', identity) as KnowledgeFileTransfer
  expect(await readFile(outside, 'utf8')).toBe('retained')
  expect(await readdir(privateDirectory)).toContain('unowned')
  expect(await readdir(privateDirectory)).not.toContain('transfer-abcdef')
  await h.invoke('knowledge.documents.preview.close', { transferId: opened.transferId })
})

it('aligns file policies with official defaults and validates deployment overrides', () => {
  expect(resolveKnowledgeFilePolicy()).toMatchObject({ previewMaxBytes: 32 * 1024 * 1024, spreadsheetMaxBytes: 16 * 1024 * 1024,
    officeInputMaxBytes: 50 * 1024 * 1024, officeOutputMaxBytes: 100 * 1024 * 1024, uploadMaxBytes: 50 * 1024 * 1024 })
  expect(resolveKnowledgeFilePolicy({ previewMaxBytes: 1024 }).previewMaxBytes).toBe(1024)
  expect(() => resolveKnowledgeFilePolicy({ downloadMaxBytes: -1 })).toThrow('downloadMaxBytes')
  expect(() => resolveKnowledgeFilePolicy({ unknown: 1 })).toThrow('unknown')
})

it.each(['cancel', 'unload'] as const)('cancels a still-arriving original and removes staging on %s', async (action) => {
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-files-cancel-'))
  const cancel = vi.fn()
  const started = Promise.withResolvers<undefined>()
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'token',
    fetch: async url => (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/metadata')
      ? Response.json({ success: true, data: { ...identity, id: identity.documentId,
        filename: 'original.pdf', contentVersion: 'v1', sizeBytes: 8, previewMaxBytes: 1024, downloadMaxBytes: 1024 } })
      : new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2])); started.resolve(undefined) }, cancel,
      })) })
  const files = new KnowledgeFiles({ directory, policy: resolveKnowledgeFilePolicy(), getEmployeeId: () => employee.employeeId,
    renderOffice: async () => ({}), saveDialog: async () => undefined, openPath: async () => '' })
  onTestFinished(async () => { await files.close(); api.close(); await rm(directory, { recursive: true, force: true }) })
  const controller = new AbortController()
  const pending = files.invoke('knowledge.documents.preview.open', identity, api, employee, controller.signal)
  const failure = expect(pending).rejects.toThrow()
  await started.promise
  if (action === 'cancel') controller.abort(new Error('Reader closed'))
  else await files.close()
  await failure
  expect(cancel).toHaveBeenCalled()
  expect(await readdir(directory)).toEqual([])
})

it('checks the spreadsheet-specific cap before reading any original bytes', async () => {
  const h = await fixture(new Uint8Array(17 * 1024 * 1024))
  h.filename('oversize.xlsx')
  await expect(h.invoke('knowledge.documents.preview.open', identity)).rejects.toMatchObject({ code: 'KNOWLEDGE_PREVIEW_TOO_LARGE' })
  expect(h.calls.every(path => path.endsWith('/metadata'))).toBe(true)
  expect(h.saveDialog).not.toHaveBeenCalled()
})

it('rejects path and owner claims before fetching any file', async () => {
  const h = await fixture()
  await expect(h.invoke('knowledge.documents.preview.open', { ...identity, path: '/secret', employeeId: 'someone-else' }))
    .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
  expect(h.calls).toEqual([])
})
