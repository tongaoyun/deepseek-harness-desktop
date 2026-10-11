import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { knowledgeUploadDialogOptions, uploadKnowledgeFile } from '../src/knowledge-upload.ts'

const uploadPolicy = { maxBytes: 50 * 1024 * 1024 }

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
  expect(knowledgeUploadDialogOptions('TEXT')).toEqual({ properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] })
  expect(knowledgeUploadDialogOptions('STANDARD')).toEqual({ properties: ['openFile'] })
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
