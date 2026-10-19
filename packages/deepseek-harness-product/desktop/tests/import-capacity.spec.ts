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

it('keeps prepared uploads in the same capacity budget while allowing their retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-upload-capacity-'))
  const path = join(root, 'sample.md')
  await writeFile(path, '# Sample')
  const picker = Promise.withResolvers<string | undefined>()
  const overflowPicker = Promise.withResolvers<'opened'>()
  const select = vi.fn(() => {
    if (select.mock.calls.length > 16) overflowPicker.resolve('opened')
    return select.mock.calls.length <= 15 ? Promise.resolve(path) : picker.promise
  })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-token',
    fetch: async (url) => {
      if ((url instanceof Request ? url.url : url.toString()).endsWith('/knowledge-file-limits')) return Response.json({ success: true, data: { uploadMaxBytes: 1000 } })
      throw new Error('Upload receipt lost')
    } })
  const uploads = new KnowledgeUploads(() => identity.employeeId, select, 1000)
  const operations: Promise<unknown>[] = []
  onTestFinished(async () => {
    uploads.close(); picker.resolve(undefined)
    await Promise.allSettled(operations); api.close()
    await rm(root, { recursive: true, force: true })
  })
  const send = (index: number) => {
    const operation = uploads.send('base', `retained-upload-${index}`, 'STANDARD', null, api)
    operations.push(operation)
    return operation
  }
  for (let index = 0; index < 15; index++) await expect(send(index)).rejects.toThrow('receipt lost')
  const entered = Promise.withResolvers<undefined>()
  select.mockImplementation(() => { entered.resolve(undefined); return picker.promise })
  const last = send(15)
  await entered.promise
  select.mockImplementation(() => { overflowPicker.resolve('opened'); return picker.promise })
  const overflow = send(16)
  expect(await Promise.race([overflow.then(() => 'accepted', () => 'rejected'), overflowPicker.promise])).toBe('rejected')
  const lastFailure = expect(last).rejects.toThrow('receipt lost')
  picker.resolve(path)
  await lastFailure
  expect(uploads.pending('base')).toHaveLength(16)
  await expect(send(0)).rejects.toThrow('receipt lost')
  expect(select).toHaveBeenCalledTimes(16)
  await expect(send(17)).rejects.toMatchObject({ code: 'KNOWLEDGE_UPLOAD_PENDING_LIMIT' })
  uploads.discard('base', 'retained-upload-0')
  await expect(send(18)).rejects.toThrow('receipt lost')
  expect(select).toHaveBeenCalledTimes(17)
  expect(uploads.pending('base')).toHaveLength(16)
})

it('reserves native upload selections before concurrent pickers and frees slots after cancellation', async () => {
  const ready = Promise.withResolvers<undefined>()
  const picker = Promise.withResolvers<string | undefined>()
  const overflowPicker = Promise.withResolvers<'opened'>()
  const select = vi.fn(() => {
    if (select.mock.calls.length === 16) ready.resolve(undefined)
    if (select.mock.calls.length > 16) overflowPicker.resolve('opened')
    return picker.promise
  })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-token',
    fetch: async () => Response.json({ success: true, data: { uploadMaxBytes: 1000 } }) })
  const uploads = new KnowledgeUploads(() => identity.employeeId, select, 1000)
  const operations: Promise<unknown>[] = []
  onTestFinished(async () => {
    uploads.close(); picker.resolve(undefined)
    await Promise.allSettled(operations); api.close()
  })
  const send = (index: number) => {
    const operation = uploads.send('base', `upload-operation-${index}`, 'STANDARD', null, api)
    operations.push(operation)
    return operation
  }
  for (let index = 0; index < 16; index++) void send(index)
  await ready.promise
  const overflow = send(16)
  expect(await Promise.race([overflow.then(() => 'accepted', () => 'rejected'), overflowPicker.promise])).toBe('rejected')
  await expect(overflow).rejects.toMatchObject({ code: 'KNOWLEDGE_UPLOAD_PENDING_LIMIT' })
  picker.resolve(undefined)
  await Promise.all(operations.slice(0, 16))
  await expect(send(17)).resolves.toEqual({ cancelled: true })
  expect(select).toHaveBeenCalledTimes(17)
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
