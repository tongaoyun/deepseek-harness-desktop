// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { KnowledgeUploadDialog } from '../src/client/KnowledgeUploadDialog.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

const selections = Array.from({ length: 3 }, (_, index) => ({ operationId: `upload-operation-${index}`, filename: `file-${index}.md`,
  pdfParseMode: 'STANDARD' as const, folderId: 'folder' }))
const props = { knowledgeBaseId: 'personal', selections,
  onBusyChange: vi.fn(), onAccepted: vi.fn(), onDenied: vi.fn(), onClose: vi.fn(),
  t: (key: DeepSeekHarnessProductKey) => zh[key] }
const document = { id: 'file', knowledgeBaseId: 'personal', filename: 'file.md', mediaType: 'text/markdown', sizeBytes: 10,
  status: 'QUEUED', chunkCount: 0, folderId: 'folder', updatedAt: '2026-10-20T00:00:00Z' }
function transport(handler: (method: string, payload: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: Record<string, unknown>,
    _requestId?: string, _timeout?: number) => {
    try { return { ok: true, result: await handler(method, payload) } }
    catch (failure) { return { ok: false, failure: productFailure(failure) } }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel, uploads: () => invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload') }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('uploads selected files sequentially, records partial success, and retries only the chosen failed file', async () => {
  let failed = false
  let active = 0
  const api = transport(async (method, payload) => {
    if (method !== 'knowledge.documents.upload') return { discarded: true }
    active++; expect(active).toBe(1)
    await Promise.resolve(); active--
    if (payload.operationId === selections[1]!.operationId && !failed) {
      failed = true; throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Lost receipt', true)
    }
    return document
  })
  render(<KnowledgeUploadDialog {...props} />)
  expect(api.uploads()).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await waitFor(() => { expect(screen.getAllByText(zh.knowledgeUploadAccepted)).toHaveLength(2) })
  const list = screen.getByRole('list', { name: zh.knowledgeUploadFiles })
  expect(within(list).getAllByRole('listitem').map(row => row.textContent)).toMatchInlineSnapshot(`
    [
      "file-0.md已上传，处理状态见资料列表",
      "file-1.md上传结果未确认，可重试原文件；移除前请检查资料列表重试上传移除",
      "file-2.md已上传，处理状态见资料列表",
    ]
  `)
  expect(api.uploads().map(call => call[2].operationId)).toEqual(selections.map(row => row.operationId))
  const failedRow = within(list).getAllByRole('listitem')[1]!
  fireEvent.click(within(failedRow).getByRole('button', { name: zh.knowledgeRetryUpload }))
  await waitFor(() => { expect(screen.getAllByText(zh.knowledgeUploadAccepted)).toHaveLength(3) })
  expect(api.uploads()).toHaveLength(4)
  expect(api.uploads()[3]![2]).toEqual(api.uploads()[1]![2])
  expect(props.onAccepted).toHaveBeenCalledTimes(3)
})

it('keeps permanent failures visible, skips their retries, and removes selections without another upload', async () => {
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.upload') throw new ProductError('KNOWLEDGE_FILE_CHANGED', 'Private path', false)
    return { discarded: true }
  })
  render(<KnowledgeUploadDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await waitFor(() => { expect(screen.getAllByRole('alert')).toHaveLength(3) })
  expect(screen.queryByRole('button', { name: zh.knowledgeRetryUpload })).toBeNull()
  expect(screen.queryByText(/Private path/u)).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: zh.knowledgeUploadRemove })[0]!)
  await screen.findByText(zh.knowledgeUploadRemoved)
  expect(api.uploads()).toHaveLength(3)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload.discard').map(call => call[2]))
    .toEqual([{ knowledgeBaseId: 'personal', operationId: selections[0]!.operationId }])
})

it.each(['KNOWLEDGE_ACCESS_DENIED', 'KNOWLEDGE_MANAGEMENT_FORBIDDEN'])('stops the remaining queue on %s', async (code) => {
  const api = transport(async () => { throw new ProductError(code, 'Permission revoked', false) })
  render(<KnowledgeUploadDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await waitFor(() => { expect(props.onDenied).toHaveBeenCalledOnce() })
  expect(api.uploads()).toHaveLength(1)
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload.discard')).toBe(false)
})

it('cancels the in-flight upload on unmount and retains remaining selections without sending them', async () => {
  const pending = Promise.withResolvers<unknown>()
  const api = transport(async () => pending.promise)
  const view = render(<KnowledgeUploadDialog {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await waitFor(() => { expect(api.uploads()).toHaveLength(1) })
  view.unmount()
  expect(api.cancel).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve(document); await pending.promise })
  expect(api.uploads()).toHaveLength(1)
  expect(props.onAccepted).not.toHaveBeenCalled()
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload.discard')).toBe(false)
  expect(props.onBusyChange).toHaveBeenLastCalledWith(false)
})

it('retries only release with its original identity after discard fails', async () => {
  let fails = true
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.upload') return document
    if (fails) { fails = false; throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Acknowledgement lost', true) }
    return { discarded: true }
  })
  render(<KnowledgeUploadDialog {...props} selections={selections.slice(0, 1)} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await screen.findByRole('alert')
  fireEvent.click(within(screen.getByRole('listitem')).getByRole('button', { name: zh.retry }))
  await screen.findByText(zh.knowledgeUploadAccepted)
  expect(api.uploads()).toHaveLength(1)
  const releases = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload.discard')
  expect(releases).toHaveLength(2)
  expect(releases[1]![2]).toEqual(releases[0]![2])
})

it.each(['library', 'destination', 'identity', 'metadata'] as const)('retains the original selection after an upload receipt has invalid %s', async (invalid) => {
  let valid = false
  const receipt = { ...document, folderId: 'folder' }
  const malformed = invalid === 'library' ? { ...receipt, knowledgeBaseId: 'another-library' }
    : invalid === 'destination' ? { ...receipt, folderId: 'another-folder' }
      : invalid === 'identity' ? { ...receipt, id: '' } : { ...receipt, status: '' }
  const api = transport(async method => method === 'knowledge.documents.upload' ? valid ? receipt : malformed : { discarded: true })
  render(<KnowledgeUploadDialog {...props} selections={selections.slice(0, 1)} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await screen.findByRole('alert')
  expect(props.onAccepted).not.toHaveBeenCalled()
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.upload.discard')).toBe(false)
  expect(screen.getByRole('list', { name: zh.knowledgeUploadFiles }).textContent).toMatchSnapshot()
  valid = true
  fireEvent.click(within(screen.getByRole('listitem')).getByRole('button', { name: zh.knowledgeRetryUpload }))
  await screen.findByText(zh.knowledgeUploadAccepted)
  expect(api.uploads()).toHaveLength(2)
  expect(api.uploads()[1]![2]).toEqual(api.uploads()[0]![2])
})

it('retries release after a lost acknowledgement without uploading the file again', async () => {
  let released = false
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.upload') {
      if (released) throw new ProductError('KNOWLEDGE_UPLOAD_SELECTION_MISSING', 'Selection already released', false)
      return { ...document, folderId: 'folder' }
    }
    if (!released) { released = true; throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Release completed but reply lost', true) }
    return { discarded: true }
  })
  render(<KnowledgeUploadDialog {...props} selections={selections.slice(0, 1)} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await screen.findByRole('alert')
  fireEvent.click(within(screen.getByRole('listitem')).getByRole('button', { name: zh.retry }))
  await screen.findByText(zh.knowledgeUploadAccepted)
  expect(api.uploads()).toHaveLength(1)
  const releases = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload.discard')
  expect(releases).toHaveLength(2)
  expect(releases[1]![2]).toEqual(releases[0]![2])
  expect(props.onAccepted).toHaveBeenCalledOnce()
})

it.each(['lost', 'malformed'] as const)('retains removal intent after a %s release acknowledgement', async (failure) => {
  let first = true
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.upload') throw new Error('Removal must not upload')
    if (first) {
      first = false
      if (failure === 'lost') throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Release reply lost', true)
      return { discarded: false }
    }
    return { discarded: true }
  })
  render(<KnowledgeUploadDialog {...props} selections={selections.slice(0, 1)} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUploadRemove }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert').textContent).toContain(zh.knowledgeUploadRemoveFailed)
  fireEvent.click(within(screen.getByRole('listitem')).getByRole('button', { name: zh.retry }))
  await screen.findByText(zh.knowledgeUploadRemoved)
  expect(api.uploads()).toHaveLength(0)
  expect(api.invoke.mock.calls.map(call => call[2])).toEqual([
    { knowledgeBaseId: 'personal', operationId: selections[0]!.operationId },
    { knowledgeBaseId: 'personal', operationId: selections[0]!.operationId },
  ])
})

it.each([null, {}, { discarded: false }])('retries only release after an invalid release receipt %j', async (receipt) => {
  let first = true
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.upload') return document
    if (first) { first = false; return receipt }
    return { discarded: true }
  })
  render(<KnowledgeUploadDialog {...props} selections={selections.slice(0, 1)} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await screen.findByRole('alert')
  expect(screen.queryByText(zh.knowledgeUploadAccepted)).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain(zh.knowledgeUploadReleaseFailed)
  expect(screen.getByRole('status').textContent).toBe(zh.knowledgeUploadProgress.replace('{count}', '1').replace('{total}', '1'))
  fireEvent.click(within(screen.getByRole('listitem')).getByRole('button', { name: zh.retry }))
  await screen.findByText(zh.knowledgeUploadAccepted)
  expect(api.uploads()).toHaveLength(1)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload.discard')).toHaveLength(2)
  expect(props.onAccepted).toHaveBeenCalledOnce()
})
