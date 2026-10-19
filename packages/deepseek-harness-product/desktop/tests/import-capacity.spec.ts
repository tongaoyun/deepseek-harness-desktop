import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ExtensionAuthoring } from '../src/extension-authoring.ts'
import { KnowledgeUploads } from '../src/knowledge-upload.ts'

const identity = { authenticated: true, employeeId: 'employee-one' }

it.each(['dismissed', 'failed', 'aborted'] as const)('counts pending import pickers and releases %s reservations', async (outcome) => {
  const root = await mkdtemp(join(tmpdir(), 'extension-import-capacity-'))
  const picker = Promise.withResolvers<string | undefined>()
  const overflowPicker = Promise.withResolvers<'opened'>()
  const selectImport = vi.fn(() => {
    if (selectImport.mock.calls.length > 4) overflowPicker.resolve('opened')
    return picker.promise
  })
  const authoring = new ExtensionAuthoring({ directory: root, selectImport,
    installSkill: async () => undefined, saveConnector: async () => undefined })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => undefined })
  const controller = new AbortController()
  const operations: Promise<unknown>[] = []
  onTestFinished(async () => {
    controller.abort(); picker.resolve(undefined)
    await Promise.allSettled(operations); await authoring.close(); api.close()
    await rm(root, { recursive: true, force: true })
  })
  const inspect = (signal = controller.signal) => {
    const operation = authoring.invoke('extensions.import.inspect', { kind: 'skill', source: 'directory' }, api, identity, signal)
    operations.push(operation)
    return operation
  }
  for (let index = 0; index < 4; index++) void inspect()
  expect(selectImport).toHaveBeenCalledTimes(4)
  const overflow = inspect()
  expect(await Promise.race([overflow.then(() => 'accepted', () => 'rejected'), overflowPicker.promise])).toBe('rejected')
  const settled = Promise.allSettled(operations.slice(0, 4))
  if (outcome === 'aborted') controller.abort(new Error('Import cancelled'))
  else if (outcome === 'failed') picker.reject(new Error('Picker failed'))
  else picker.resolve(undefined)
  expect((await settled).map(result => result.status)).toEqual(Array.from({ length: 4 }, () => outcome === 'dismissed' ? 'fulfilled' : 'rejected'))
  selectImport.mockImplementation(async () => undefined)
  await expect(inspect(new AbortController().signal)).resolves.toEqual({ cancelled: true })
  expect(selectImport).toHaveBeenCalledTimes(5)
})

it('counts an entire native selection atomically and preserves existing upload retries at capacity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-capacity-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const paths = Array.from({ length: 17 }, (_, index) => join(root, `sample-${index}.md`))
  await Promise.all(paths.map(path => writeFile(path, '# Sample')))
  const select = vi.fn(async () => paths.slice(0, 15))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-token',
    fetch: async url => (url instanceof Request ? url.url : url.toString()).endsWith('/knowledge-file-limits')
      ? Response.json({ success: true, data: { uploadMaxBytes: 1000 } }) : Promise.reject(new Error('Upload receipt lost')) })
  const uploads = new KnowledgeUploads(() => identity.employeeId, select, 1000)
  onTestFinished(() => { uploads.close(); api.close() })
  const initial = await uploads.choose('base', 'STANDARD', null)
  select.mockResolvedValue(paths.slice(15))
  await expect(uploads.choose('base', 'STANDARD', null)).rejects.toMatchObject({ code: 'KNOWLEDGE_UPLOAD_PENDING_LIMIT' })
  expect(uploads.pending('base')).toEqual(initial)
  select.mockResolvedValue(paths.slice(15, 16))
  await uploads.choose('base', 'STANDARD', null)
  expect(uploads.pending('base')).toHaveLength(16)
  await expect(uploads.choose('base', 'STANDARD', null)).rejects.toMatchObject({ code: 'KNOWLEDGE_UPLOAD_PENDING_LIMIT' })
  await expect(uploads.send('base', initial[0]!.operationId, 'STANDARD', null, api)).rejects.toThrow('receipt lost')
  uploads.discard('base', initial[0]!.operationId)
  await uploads.choose('other-base', 'STANDARD', null)
  expect(uploads.pending('base')).toHaveLength(15)
  expect(uploads.pending('other-base')).toHaveLength(1)
  expect(select).toHaveBeenCalledTimes(4)
})

it.each(['cancel', 'failure', 'abort'] as const)('allows one native picker and releases its reservation after %s', async (outcome) => {
  const picker = Promise.withResolvers<readonly string[] | undefined>()
  const select = vi.fn(() => picker.promise)
  const uploads = new KnowledgeUploads(() => identity.employeeId, select, 1000)
  const controller = new AbortController()
  const first = uploads.choose('base', 'STANDARD', null, controller.signal)
  onTestFinished(async () => { uploads.close(); picker.resolve(undefined); await first.catch(() => undefined) })
  await expect(uploads.choose('other-base', 'STANDARD', null)).rejects.toMatchObject({ code: 'IDEMPOTENCY_OPERATION_IN_PROGRESS' })
  const settled = Promise.allSettled([first])
  if (outcome === 'failure') picker.reject(new Error('Picker failed'))
  else { if (outcome === 'abort') controller.abort(); picker.resolve(undefined) }
  expect((await settled)[0]?.status).toBe(outcome === 'cancel' ? 'fulfilled' : 'rejected')
  select.mockResolvedValue(undefined)
  await expect(uploads.choose('base', 'STANDARD', null)).resolves.toEqual([])
  expect(select).toHaveBeenCalledTimes(2)
})

it('counts completed package previews together with in-flight inspections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-preview-capacity-'))
  await writeFile(join(root, 'SKILL.md'), '---\nname: sample-skill\ndescription: Sample skill\n---\nInstructions.')
  const picker = Promise.withResolvers<string | undefined>()
  const overflowPicker = Promise.withResolvers<'opened'>()
  const selectImport = vi.fn(() => {
    if (selectImport.mock.calls.length > 4) overflowPicker.resolve('opened')
    return selectImport.mock.calls.length <= 3 ? Promise.resolve(root) : picker.promise
  })
  const authoring = new ExtensionAuthoring({ directory: join(root, 'conversations'), selectImport,
    installSkill: async () => undefined, saveConnector: async () => undefined })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => undefined })
  const controller = new AbortController()
  const operations: Promise<unknown>[] = []
  onTestFinished(async () => {
    controller.abort(); picker.resolve(undefined)
    await Promise.allSettled(operations); await authoring.close(); api.close()
    await rm(root, { recursive: true, force: true })
  })
  const inspect = () => {
    const operation = authoring.invoke('extensions.import.inspect', { kind: 'skill', source: 'directory' }, api, identity, controller.signal)
    operations.push(operation)
    return operation
  }
  for (let index = 0; index < 3; index++) await inspect()
  void inspect()
  const overflow = inspect()
  expect(await Promise.race([overflow.then(() => 'accepted', () => 'rejected'), overflowPicker.promise])).toBe('rejected')
})
