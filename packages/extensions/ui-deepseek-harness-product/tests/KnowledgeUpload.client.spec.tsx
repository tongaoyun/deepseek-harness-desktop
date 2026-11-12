// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { KnowledgeUploadDialog } from '../src/client/KnowledgeUploadDialog.tsx'
import { en, zh, NS, type DeepSeekHarnessProductKey } from '../src/locales.ts'

const localeContext = new Context()
const locale = new LocaleRuntime(localeContext)
locale.register(NS, { en, zh })
locale.setLocale('zh')

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
    try { return { ok: true, result: method === 'knowledge.folders.get'
      ? { id: payload.folderId, knowledgeBaseId: 'personal', name: '资料', parentId: null, updatedAt: '2026-11-05T00:00:00Z' } : await handler(method, payload) } }
    catch (failure) { return { ok: false, failure: productFailure(failure) } }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel, uploads: () => invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload') }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); locale.setLocale('zh') })
afterAll(async () => { await localeContext.fiber.dispose() })

it.each((['queue', 'upload-retry', 'release-retry', 'remove'] as const).flatMap(stage =>
  [false, true].map(elsewhere => ({ stage, elsewhere }))))(
  'recovers upload $stage focus after its action is removed (elsewhere=$elsewhere)', async ({ stage, elsewhere }) => {
    const response = Promise.withResolvers<undefined>()
    const retry = stage.endsWith('retry')
    const method = stage === 'queue' || stage === 'upload-retry' ? 'knowledge.documents.upload' : 'knowledge.documents.upload.discard'
    let calls = 0
    const api = transport(async (name) => {
      if (name === method) {
        if (++calls === 1 && retry) throw new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Reply lost', true)
        await response.promise
      }
      return name === 'knowledge.documents.upload' ? document : { discarded: true }
    })
    const view = render(<KnowledgeUploadDialog {...props} selections={selections.slice(0, 1)} />)
    onTestFinished(() => { view.unmount(); response.resolve(undefined) })
    if (retry) {
      fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
      await screen.findByRole('alert')
    }
    const label = stage === 'queue' ? zh.knowledgeUpload : stage === 'remove' ? zh.knowledgeUploadRemove
      : stage === 'upload-retry' ? zh.knowledgeRetryUpload : zh.retry
    const action = stage === 'queue' ? screen.getByRole<HTMLButtonElement>('button', { name: label })
      : within(screen.getByRole('listitem')).getByRole<HTMLButtonElement>('button', { name: label })
    action.focus()
    act(() => { action.click(); action.click() })
    const headerClose = screen.getAllByRole<HTMLButtonElement>('button', { name: zh.close })[0]!
    if (elsewhere) headerClose.focus()
    await act(async () => { response.resolve(undefined) })
    const footerClose = screen.getAllByRole<HTMLButtonElement>('button', { name: zh.close }).at(-1)!
    expect(action.isConnected).toBe(false)
    expect(globalThis.document.activeElement).toBe(elsewhere ? headerClose : footerClose)
    expect(calls).toBe(retry ? 2 : 1)
    expect(api.uploads()).toHaveLength(stage === 'remove' ? 0 : stage === 'upload-retry' ? 2 : 1)
    expect({ result: screen.getByRole('listitem').textContent, focus: elsewhere ? 'header-close' : 'footer-close' }).toMatchSnapshot()
  },
)

it('keeps focus on another upload row when the current removal completes', async () => {
  const response = Promise.withResolvers<undefined>()
  transport(async () => { await response.promise; return { discarded: true } })
  const view = render(<KnowledgeUploadDialog {...props} selections={selections.slice(0, 2)} />)
  onTestFinished(() => { view.unmount(); response.resolve(undefined) })
  const rows = screen.getAllByRole('listitem')
  const removing = within(rows[0]!).getByRole<HTMLButtonElement>('button', { name: zh.knowledgeUploadRemove })
  const other = within(rows[1]!).getByRole<HTMLButtonElement>('button', { name: zh.knowledgeUploadRemove })
  removing.focus(); fireEvent.click(removing)
  other.focus()
  await act(async () => { response.resolve(undefined) })
  expect(removing.isConnected).toBe(false)
  expect(globalThis.document.activeElement).toBe(other)
  expect(screen.getByRole('button', { name: zh.knowledgeUpload })).toBeDefined()
})

it.each(['upload', 'release', 'discard'] as const)('updates %s failures in the current language without changing retry identity', async (stage) => {
  const pending = Promise.withResolvers<unknown>()
  const retryResponse = Promise.withResolvers<undefined>()
  const method = stage === 'upload' ? 'knowledge.documents.upload' : 'knowledge.documents.upload.discard'
  let fail = true
  const api = transport(async (name) => {
    if (name === method) { if (fail) return pending.promise; await retryResponse.promise }
    return name === 'knowledge.documents.upload' ? document : { discarded: true }
  })
  const t = locale.bind(NS)
  const queueProps = { ...props, selections: selections.slice(0, 1), t }
  const view = render(<KnowledgeUploadDialog {...queueProps} />)
  onTestFinished(() => { view.unmount(); pending.resolve(document); retryResponse.resolve(undefined) })
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: stage === 'discard' ? zh.knowledgeUploadRemove : zh.knowledgeUpload })
  submit.focus()
  fireEvent.click(submit)
  await waitFor(() => { expect(api.invoke.mock.calls.some(call => call[1] === method)).toBe(true) })
  expect(submit.isConnected).toBe(true)
  expect(globalThis.document.activeElement).toBe(submit)
  expect(submit.disabled).toBe(false)
  expect(submit.getAttribute('aria-disabled')).toBe('true')
  expect(submit.getAttribute('aria-busy')).toBe('true')
  if (stage === 'discard') {
    const upload = screen.getByRole('button', { name: zh.knowledgeUpload })
    expect(upload.getAttribute('aria-busy')).toBe('false')
  }
  locale.setLocale('en')
  view.rerender(<KnowledgeUploadDialog {...queueProps} />)
  await act(async () => { pending.reject(new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Private transport details', true)) })
  const key = stage === 'upload' ? 'knowledgeUploadFailed' : stage === 'release' ? 'knowledgeUploadReleaseFailed' : 'knowledgeUploadRemoveFailed'
  expect((await screen.findByRole('alert')).textContent).toBe(`${en[key]} (IDEMPOTENCY_OPERATION_UNKNOWN)`)
  locale.setLocale('zh')
  view.rerender(<KnowledgeUploadDialog {...queueProps} />)
  expect(screen.getByRole('alert').textContent).toBe(`${zh[key]} (IDEMPOTENCY_OPERATION_UNKNOWN)`)
  expect(screen.getByRole('listitem').textContent).toMatchSnapshot()
  expect(api.cancel).not.toHaveBeenCalled()
  fail = false
  const error = screen.getByRole('alert')
  const retry = within(screen.getByRole('listitem')).getByRole<HTMLButtonElement>('button', { name: stage === 'upload' ? zh.knowledgeRetryUpload : zh.retry })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(error)
  expect(retry.isConnected).toBe(true)
  expect(globalThis.document.activeElement).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect({ error: error.textContent, action: retry.textContent, busy: retry.getAttribute('aria-busy'),
    focused: globalThis.document.activeElement === retry }).toMatchSnapshot()
  await act(async () => { retryResponse.resolve(undefined) })
  await screen.findByText(stage === 'discard' ? zh.knowledgeUploadRemoved : zh.knowledgeUploadAccepted)
  const attempts = api.invoke.mock.calls.filter(call => call[1] === method)
  expect(attempts).toHaveLength(2)
  expect(attempts[1]![2]).toEqual(attempts[0]![2])
  expect(api.uploads()).toHaveLength(stage === 'upload' ? 2 : stage === 'release' ? 1 : 0)
})

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
      "file-0.md保存位置知识库 / 资料已上传，处理状态见资料列表",
      "file-1.md保存位置知识库 / 资料上传结果未确认，可重试原文件；移除前请检查资料列表重试上传移除",
      "file-2.md保存位置知识库 / 资料已上传，处理状态见资料列表",
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
  expect(api.cancel).toHaveBeenCalledWith('product', api.uploads()[0]![3])
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
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload.discard').map(call => call[2])).toEqual([
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

it('changes PDF handling before upload and sends only the replacement native operation', async () => {
  const original = { operationId: 'original-upload-operation', filename: '中文模板.pdf', pdfParseMode: 'STANDARD' as const,
    folderId: 'folder', canConfigure: true as const }
  const replacement = { ...original, operationId: 'replacement-upload-operation', pdfParseMode: 'TEXT' as const }
  const api = transport(async method => method === 'knowledge.documents.upload.configure' ? replacement
    : method === 'knowledge.documents.upload' ? document : { discarded: true })
  render(<KnowledgeUploadDialog {...props} selections={[original]} />)
  fireEvent.click(screen.getByText(zh.knowledgePdfHandling, { selector: 'summary' }))
  const select = screen.getByRole('combobox', { name: zh.knowledgePdfHandling })
  select.focus()
  fireEvent.change(select, { target: { value: 'TEXT' } })
  await screen.findByText(zh.knowledgePdfTextHint)
  expect(screen.getByRole('combobox')).toBe(select)
  expect(select.closest('details')).toHaveProperty('open', true)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.upload.configure').map(call => call[2]))
    .toEqual([{ knowledgeBaseId: 'personal', operationId: original.operationId, pdfParseMode: 'TEXT' }])
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  await screen.findByText(zh.knowledgeUploadAccepted)
  expect(api.uploads().map(call => call[2])).toEqual([{ knowledgeBaseId: 'personal', operationId: replacement.operationId, pdfParseMode: 'TEXT', folderId: 'folder' }])
  expect(screen.queryByRole('combobox')).toBeNull()
})

it.each(['lost', 'invalid'] as const)('blocks uploads after a %s PDF configuration receipt until recovery', async (failure) => {
  const original = { operationId: 'original-upload-operation', filename: '模板.pdf', pdfParseMode: 'STANDARD' as const,
    folderId: 'folder', canConfigure: true as const }
  const api = transport(async () => {
    if (failure === 'lost') throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Lost receipt', true)
    return { ...original, pdfParseMode: 'TEXT' }
  })
  const view = render(<KnowledgeUploadDialog {...props} selections={[original]} />)
  fireEvent.click(screen.getByText(zh.knowledgePdfHandling, { selector: 'summary' }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'TEXT' } })
  await screen.findByText(zh.knowledgeUploadOptionsUnconfirmed)
  expect(screen.getByRole('button', { name: zh.knowledgeUpload })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: zh.knowledgeUploadRemove })).toHaveProperty('disabled', true)
  expect(api.uploads()).toEqual([])
  view.rerender(<KnowledgeUploadDialog {...props} selections={[original]} t={key => en[key]} />)
  expect(screen.getByRole('alert').textContent).toBe(en.knowledgeUploadOptionsUnconfirmed)
  expect(screen.getByRole('button', { name: en.knowledgeUpload })).toHaveProperty('disabled', true)
  expect(api.cancel).not.toHaveBeenCalled()
  fireEvent.click(screen.getAllByRole('button', { name: en.close }).at(-1)!)
  expect(props.onClose).toHaveBeenCalledOnce()
})
