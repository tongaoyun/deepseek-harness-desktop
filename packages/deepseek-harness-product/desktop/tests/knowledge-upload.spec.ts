import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { knowledgeUploadDialogOptions, uploadKnowledgeFile, KnowledgeUploads } from '../src/knowledge-upload.ts'

const uploadPolicy = { maxBytes: 50 * 1024 * 1024 }

it('retains a dispatched upload when its page cancels and retries it without another picker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-navigation-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'policy.md')
  await writeFile(path, '# Original')
  const select = vi.fn(async () => [path])
  const dispatched = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  let writes = 0
  const keys: string[] = []
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'employee',
    fetch: async (url, init) => {
      if ((url instanceof Request ? url.url : url.toString()).endsWith('/knowledge-file-limits')) {
        return Response.json({ success: true, data: { uploadMaxBytes: 1000 } })
      }
      writes++
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '')
      if (writes === 1) return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) throw new Error('Upload signal is required')
        signal.addEventListener('abort', () => { reject(new Error('Page left')) }, { once: true })
        dispatched.resolve(undefined)
      })
      return Response.json({ success: true, data: { id: 'document', status: 'QUEUED' } })
    } })
  const uploads = new KnowledgeUploads(() => 'employee', select, 1000)
  const [selected] = await uploads.choose('base', 'STANDARD', null)
  if (!selected) throw new Error('Missing native selection')
  const first = uploads.send('base', selected.operationId, 'STANDARD', null, api, controller.signal)
  onTestFinished(async () => { controller.abort(); await first.catch(() => undefined); uploads.close(); api.close() })
  await dispatched.promise
  const rejected = expect(first).rejects.toThrow()
  controller.abort(new Error('Page left'))
  await rejected
  expect(uploads.pending('base')).toEqual([{ operationId: selected.operationId, filename: 'policy.md', pdfParseMode: 'STANDARD', folderId: null }])
  await expect(uploads.send('base', selected.operationId, 'STANDARD', null, api)).resolves.toMatchObject({ id: 'document' })
  expect(select).toHaveBeenCalledOnce()
  expect(writes).toBe(2)
  expect(keys).toEqual([selected.operationId, selected.operationId])
})

it('reuses the native file and operation after a lost server or IPC receipt, and refuses changed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-retry-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'policy.md')
  await writeFile(path, '# Original')
  const select = vi.fn(async () => [path])
  let fail = true
  const keys: string[] = []
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    if ((_url instanceof Request ? _url.url : _url.toString()).endsWith('/knowledge-file-limits')) return Response.json({ success: true, data: { uploadMaxBytes: 1000 } })
    keys.push(new Headers(init?.headers).get('idempotency-key') ?? '')
    if (fail) { fail = false; throw new Error('Lost receipt') }
    return Response.json({ success: true, data: { id: 'document', status: 'QUEUED' } })
  })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'private-token', fetch: transport })
  const uploads = new KnowledgeUploads(() => 'employee', select, 1000)
  onTestFinished(() => { uploads.close(); api.close() })
  const [selected] = await uploads.choose('base', 'STANDARD', 'folder')
  if (!selected) throw new Error('Missing native selection')
  await expect(uploads.send('base', selected.operationId, 'STANDARD', 'folder', api)).rejects.toThrow()
  expect(uploads.pending('base')).toEqual([{ operationId: selected.operationId, filename: 'policy.md', pdfParseMode: 'STANDARD', folderId: 'folder' }])
  expect(uploads.pending('other-base')).toEqual([])
  expect(JSON.stringify(uploads.pending('base'))).not.toContain(root)
  await expect(uploads.send('base', selected.operationId, 'STANDARD', 'folder', api)).resolves.toEqual({ id: 'document', status: 'QUEUED' })
  // A main-process success is retained until the renderer acknowledges it.
  await uploads.send('base', selected.operationId, 'STANDARD', 'folder', api)
  expect(select).toHaveBeenCalledTimes(1)
  expect(keys).toEqual([selected.operationId, selected.operationId, selected.operationId])
  await expect(uploads.send('base', selected.operationId, 'TEXT', 'folder', api)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  await writeFile(path, '# Changed!')
  await expect(uploads.send('base', selected.operationId, 'STANDARD', 'folder', api)).rejects.toMatchObject({ code: 'KNOWLEDGE_FILE_CHANGED' })
  expect(keys).toHaveLength(3)
  uploads.discard('base', selected.operationId)
  expect(uploads.pending('base')).toEqual([])
  const [next] = await uploads.choose('base', 'STANDARD', 'folder')
  await uploads.send('base', next!.operationId, 'STANDARD', 'folder', api)
  expect(select).toHaveBeenCalledTimes(2)
})

it('drops selections on employee changes and cancels preparation on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-identity-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'policy.md')
  await writeFile(path, '# Original')
  let employee = 'first'
  const select = vi.fn(async () => [path])
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => employee,
    fetch: async url => (url instanceof Request ? url.url : url.toString()).endsWith('/knowledge-file-limits')
      ? Response.json({ success: true, data: { uploadMaxBytes: 1000 } }) : Promise.reject(new Error('Lost receipt')) })
  const uploads = new KnowledgeUploads(() => employee, select, 1000)
  onTestFinished(() => { uploads.close(); api.close() })
  const [selected] = await uploads.choose('base', 'STANDARD', null)
  if (!selected) throw new Error('Missing native selection')
  await expect(uploads.send('base', selected.operationId, 'STANDARD', null, api)).rejects.toThrow()
  employee = 'second'
  expect(uploads.pending('base')).toEqual([])
  await expect(uploads.send('base', selected.operationId, 'STANDARD', null, api)).rejects.toThrow()
  expect(select).toHaveBeenCalledTimes(1)
  uploads.close()
  expect(uploads.pending('base')).toEqual([])
  await expect(uploads.send('base', selected.operationId, 'STANDARD', null, api)).rejects.toThrow()
  expect(select).toHaveBeenCalledTimes(1)
})

it.each(['close', 'employee-change'] as const)('blocks a late native selection after %s and releases its active operation', async (action) => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-pending-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'policy.md')
  await writeFile(path, '# Original')
  const entered = Promise.withResolvers<undefined>()
  const picker = Promise.withResolvers<readonly string[]>()
  let employee = 'first'
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { uploadMaxBytes: 1000 } }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => employee, fetch: transport })
  const uploads = new KnowledgeUploads(() => employee, () => { entered.resolve(undefined); return picker.promise }, 1000)
  const pending = uploads.choose('base', 'STANDARD', null)
  onTestFinished(async () => { uploads.close(); picker.resolve([path]); await pending.catch(() => undefined); api.close() })
  await entered.promise
  await expect(uploads.choose('base', 'STANDARD', null))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_OPERATION_IN_PROGRESS' })
  if (action === 'close') uploads.close()
  else { employee = 'second'; uploads.resetIdentity() }
  const rejected = expect(pending).rejects.toThrow()
  picker.resolve([path])
  await rejected
  expect(transport).not.toHaveBeenCalled()
})

it('uploads a user-selected file with its basename and stable retry identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'policy.md')
  await writeFile(path, '# Policy')
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { id: 'document', status: 'QUEUED' } }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'private-token', fetch: transport })
  onTestFinished(() => { api.close() })
  const result = await uploadKnowledgeFile(path, 'base', 'stable-operation-0001', 'STANDARD', api, undefined,
    { ...uploadPolicy, folderId: 'folder-1' })
  expect(result).toEqual({ id: 'document', status: 'QUEUED' })
  const body = transport.mock.calls[0]?.[1]?.body
  expect(body).toBeInstanceOf(FormData)
  if (!(body instanceof FormData)) throw new Error('Multipart required')
  expect(body.get('pdfParseMode')).toBe('STANDARD')
  expect(body.get('folderId')).toBe('folder-1')
  expect(body.get('process_config')).toBeNull()
  const file = body.get('file')
  if (!(file instanceof File)) throw new Error('File required')
  expect(file.name).toBe('policy.md')
  expect(await file.text()).toBe('# Policy')
  expect(JSON.stringify(result)).not.toContain(root)
})

it('rejects empty files, directories, symlinks and cancellation without uploading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-invalid-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'empty.md'), '')
  await writeFile(join(root, 'real.md'), 'content')
  await symlink(join(root, 'real.md'), join(root, 'link.md'))
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: {} }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined, fetch: transport })
  onTestFinished(() => { api.close() })
  for (const path of [root, join(root, 'empty.md'), join(root, 'link.md')]) {
    await expect(uploadKnowledgeFile(path, 'base', 'stable-operation-0001', 'STANDARD', api, undefined, uploadPolicy)).rejects.toThrow()
  }
  const controller = new AbortController()
  controller.abort(new Error('Cancelled file picker'))
  await expect(uploadKnowledgeFile(join(root, 'real.md'), 'base', 'stable-operation-0001', 'STANDARD', api, controller.signal, uploadPolicy)).rejects.toThrow('Cancelled')
  expect(transport).not.toHaveBeenCalled()
})

it('restricts text extraction to native-selected PDF files and forwards only the finite parsing mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-pdf-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'policy.PDF')
  await writeFile(path, '%PDF-1.4 text')
  await writeFile(join(root, 'policy.md'), '# Policy')
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { id: 'pdf', status: 'QUEUED' } }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'private-token', fetch: transport })
  onTestFinished(() => { api.close() })
  expect(knowledgeUploadDialogOptions('TEXT')).toEqual({ properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  expect(knowledgeUploadDialogOptions('STANDARD')).toEqual({ properties: ['openFile', 'multiSelections'] })
  await expect(uploadKnowledgeFile(join(root, 'policy.md'), 'base', 'stable-operation-0001', 'TEXT', api, undefined, uploadPolicy))
    .rejects.toMatchObject({ code: 'KNOWLEDGE_FILE_INVALID' })
  expect(transport).not.toHaveBeenCalled()
  await uploadKnowledgeFile(path, 'base', 'stable-operation-0001', 'TEXT', api, undefined, uploadPolicy)
  const body = transport.mock.calls[0]?.[1]?.body
  if (!(body instanceof FormData)) throw new Error('Multipart required')
  expect(body.get('pdfParseMode')).toBe('TEXT')
  expect(body.get('process_config')).toBeNull()
  expect(body.get('engine')).toBeNull()
})

it('enforces the configured byte limit before reading and sends only validated folder identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-policy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'policy.txt')
  await writeFile(path, 'four')
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { id: 'document' } }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined, fetch: transport })
  onTestFinished(() => { api.close() })
  await expect(uploadKnowledgeFile(path, 'base', 'stable-operation-0001', 'STANDARD', api, undefined, { maxBytes: 3 }))
    .rejects.toMatchObject({ code: 'KNOWLEDGE_FILE_TOO_LARGE' })
  await expect(uploadKnowledgeFile(path, 'base', 'stable-operation-0001', 'STANDARD', api, undefined,
    { maxBytes: 4, folderId: '../private' })).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
  expect(transport).not.toHaveBeenCalled()
  await uploadKnowledgeFile(path, 'base', 'stable-operation-0001', 'STANDARD', api, undefined, { maxBytes: 4, folderId: null })
  const body = transport.mock.calls[0]?.[1]?.body
  if (!(body instanceof FormData)) throw new Error('Multipart required')
  expect(body.get('folderId')).toBeNull()
})

it('retains an entire selection before preparation and isolates invalid files from subsequent uploads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-multi-upload-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const paths = [join(root, 'empty.md'), join(root, 'one.md'), join(root, 'two.md')]
  await Promise.all(paths.map((path, index) => writeFile(path, index === 0 ? '' : `# File ${index}`)))
  const select = vi.fn(async () => [...paths, paths[1]!])
  const writes: string[] = []
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'employee',
    fetch: async (url, init) => {
      if ((url instanceof Request ? url.url : url.toString()).endsWith('/knowledge-file-limits')) {
        return Response.json({ success: true, data: { uploadMaxBytes: 1000 } })
      }
      writes.push(new Headers(init?.headers).get('idempotency-key') ?? '')
      return Response.json({ success: true, data: { id: `document-${writes.length}`, status: 'QUEUED' } })
    } })
  const uploads = new KnowledgeUploads(() => 'employee', select, 1000)
  onTestFinished(() => { uploads.close(); api.close() })
  const selections = await uploads.choose('base', 'STANDARD', 'fixed-folder')
  expect(selections.map(row => row.filename)).toEqual(['empty.md', 'one.md', 'two.md'])
  expect(new Set(selections.map(row => row.operationId)).size).toBe(3)
  expect(uploads.pending('base')).toEqual(selections)
  expect(JSON.stringify(selections)).not.toContain(root)
  await expect(uploads.send('base', selections[0]!.operationId, 'STANDARD', 'fixed-folder', api))
    .rejects.toMatchObject({ code: 'KNOWLEDGE_FILE_INVALID' })
  expect(uploads.pending('base')).toEqual(selections)
  for (const selected of selections.slice(1)) {
    await uploads.send('base', selected.operationId, 'STANDARD', 'fixed-folder', api)
    uploads.discard('base', selected.operationId)
  }
  expect(writes).toEqual(selections.slice(1).map(row => row.operationId))
  expect(uploads.pending('base')).toEqual(selections.slice(0, 1))
  await expect(uploads.send('other-base', selections[0]!.operationId, 'STANDARD', 'fixed-folder', api))
    .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
  uploads.discard('base', selections[0]!.operationId)
  await expect(uploads.send('base', selections[0]!.operationId, 'STANDARD', 'fixed-folder', api))
    .rejects.toMatchObject({ code: 'KNOWLEDGE_UPLOAD_SELECTION_MISSING' })
  expect(select).toHaveBeenCalledOnce()
})
