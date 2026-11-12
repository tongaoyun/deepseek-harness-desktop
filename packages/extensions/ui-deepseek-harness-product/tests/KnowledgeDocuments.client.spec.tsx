// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { StrictMode } from 'react'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeDocuments } from '../src/client/KnowledgeDocuments.tsx'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { en, zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
import { createPreviewFixture, originalMetadata, renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const document = {
  id: 'doc-1', knowledgeBaseId: 'policy', filename: '业务规范.md', mediaType: 'text/markdown',
  sizeBytes: 1024, status: 'READY', chunkCount: 1, updatedAt: '2026-10-10T00:00:00Z', sourceType: 'manual',
}
const page = (items: readonly unknown[], total = items.length, number = 1, size = 20) => ({ items, page: number, size, total })
const library = (canManage = false) => localDetail(items([{ id: 'policy', name: '业务规范', scope: 'PERSONAL', ownerName: '张三', canManage }])[0]!)

function transport(handler: (method: string, payload: unknown) => Promise<unknown>) {
  const preview = createPreviewFixture()
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown, _requestId?: string) => {
    if (method === 'knowledge.documents.upload.pending') return { ok: true, result: [] }
    if (method === 'knowledge.documents.previewMetadata') return { ok: true, result: originalMetadata('policy', 'doc-1') }
    return { ok: true, result: await preview(method, payload, handler) }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it.each(['reader', 'content search'] as const)('returns from %s to the same materials controls, selection, and focus', async (destination) => {
  const api = transport(async method => method === 'knowledge.documents.list' ? page([document]) : page([]))
  const view = render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  const file = await screen.findByRole('button', { name: document.filename })
  const search = screen.getByRole<HTMLInputElement>('searchbox', { name: zh.knowledgeFindFiles })
  fireEvent.change(search, { target: { value: '未提交的筛选词' } })
  const selection = screen.getByRole<HTMLInputElement>('checkbox', { name: zh.knowledgeSelectDocument.replace('{name}', document.filename) })
  fireEvent.click(selection)
  const contentSearch = screen.getByRole('button', { name: zh.knowledgeContentSearch })
  const main = view.container.querySelector<HTMLElement>('[data-knowledge-content]')!
  main.scrollTop = 240
  fireEvent.click(destination === 'reader' ? file : contentSearch)
  expect(screen.queryByRole('searchbox', { name: zh.knowledgeFindFiles })).toBeNull()
  expect(search.isConnected).toBe(true)
  expect(file.isConnected).toBe(true)
  const back = screen.getByRole('button', { name: destination === 'reader' ? zh.knowledgeBackToFolder : zh.knowledgeBackToMaterials })
  if (destination === 'content search') expect(globalThis.document.activeElement).toBe(screen.getByRole('searchbox', { name: zh.knowledgeContentSearch }))
  fireEvent.click(back)
  expect(screen.getByRole('searchbox', { name: zh.knowledgeFindFiles })).toBe(search)
  expect(search.value).toBe('未提交的筛选词')
  expect(screen.getByRole('checkbox', { name: zh.knowledgeSelectDocument.replace('{name}', document.filename) })).toBe(selection)
  expect(selection.checked).toBe(true)
  expect(screen.getByRole('button', { name: document.filename })).toBe(file)
  expect(screen.getByRole('button', { name: zh.knowledgeContentSearch })).toBe(contentSearch)
  expect(globalThis.document.activeElement).toBe(destination === 'reader' ? file : contentSearch)
  expect(main.scrollTop).toBe(240)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(1)
  expect({ query: search.value, selected: selection.checked, focused: globalThis.document.activeElement?.textContent }).toMatchSnapshot('Restored materials')
})

it.each(['reader', 'header', 'outside'] as const)('returns from an externally removed document without taking focus elsewhere (focus=%s)', async (focus) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const api = transport(async method => method === 'knowledge.documents.list'
    ? ++reads === 1 ? page([document]) : response.promise : page([]))
  const product = library(true)
  const onBack = vi.fn()
  const content = (revision: number) => <><KnowledgeDocuments renderFactorySlot={renderKnowledgePreview}
    product={product} refreshRevision={revision} onBack={onBack} t={t} /><button type="button">其他操作</button></>
  const view = render(content(0))
  onTestFinished(() => { view.unmount(); response.resolve(page([])) })
  const file = await screen.findByRole('button', { name: document.filename })
  const search = screen.getByRole<HTMLInputElement>('searchbox', { name: zh.knowledgeFindFiles })
  fireEvent.change(search, { target: { value: '未提交的筛选词' } })
  const main = view.container.querySelector<HTMLElement>('[data-knowledge-content]')!
  main.scrollTop = 240
  fireEvent.click(file)
  const back = screen.getByRole('button', { name: zh.knowledgeBackToFolder })
  const other = screen.getByRole('button', { name: '其他操作' })
  const target = focus === 'reader' ? back : focus === 'header' ? screen.getByRole('button', { name: zh.knowledge }) : other
  expect(globalThis.document.activeElement).toBe(back)
  target.focus()
  view.rerender(content(1))
  await waitFor(() => { expect(reads).toBe(2) })
  expect(globalThis.document.activeElement).toBe(target)
  await act(async () => { response.resolve(page([])) })
  expect(view.container.querySelector('[data-knowledge-inline-reader]')).toBeNull()
  expect(screen.queryByRole('button', { name: document.filename })).toBeNull()
  const heading = screen.getByRole('heading', { name: product.name, level: 1 })
  expect(globalThis.document.activeElement).toBe(focus === 'reader' ? heading : target)
  expect(screen.getByRole('searchbox', { name: zh.knowledgeFindFiles })).toBe(search)
  expect(search.value).toBe('未提交的筛选词')
  expect(main.scrollTop).toBe(240)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(2)
  expect({ draft: search.value, focused: globalThis.document.activeElement?.textContent,
    readerVisible: view.container.querySelector('[data-knowledge-inline-reader]') !== null }).toMatchSnapshot('Removed document navigation')
})

it.each(['knowledge.documents.list', 'knowledge.folders.list', 'knowledge.documents.get'] as const)('retains the %s failure while retrying without rebuilding the controls', async (method) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const value = method === 'knowledge.documents.get' ? { ...document, canManage: true, manualContent: '恢复的可编辑正文' }
    : method === 'knowledge.documents.list' ? page([document]) : page([])
  const api = transport(async (requested) => {
    if (requested !== method) return requested === 'knowledge.documents.list' ? page([document]) : page([])
    if (++reads === 1) throw new Error('Offline')
    return response.promise
  })
  const view = method === 'knowledge.documents.get'
    ? render(<KnowledgeEditor knowledgeBaseId="policy" target={{ kind: 'markdown', document }} onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
    : render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  onTestFinished(() => { view.unmount(); response.resolve(value) })
  const notice = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(globalThis.document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(screen.queryByRole('status', { name: zh.knowledgeLoadingMaterials })).toBeNull()
  fireEvent.click(retry)
  expect(api.invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(2)
  expect({ message: notice.textContent, action: retry.textContent }).toMatchSnapshot('Pending material retry')
  await act(async () => { response.resolve(value) })
  expect(screen.queryByRole('alert')).toBeNull()
  if (method === 'knowledge.documents.get') expect(await screen.findByRole('textbox', { name: zh.knowledgeMarkdownContent })).toHaveProperty('value', '恢复的可编辑正文')
  else expect(await screen.findByRole('button', { name: document.filename })).toBeDefined()
})

it('keeps selection actions and the refresh icon stable during automatic processing reads', async () => {
  vi.useFakeTimers()
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  transport(async method => method === 'knowledge.documents.list'
    ? ++reads === 1 ? page([document, { ...document, id: 'processing', filename: '处理中.pdf', status: 'PROCESSING' }]) : response.promise
    : page([]))
  await act(async () => { render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />) })
  fireEvent.click(screen.getByRole('checkbox', { name: zh.knowledgeSelectDocument.replace('{name}', document.filename) }))
  const move = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeBatchMove })
  const refresh = screen.getByRole('button', { name: zh.refresh })
  const icon = refresh.querySelector('svg')
  const changes: MutationRecord[] = []
  const observer = new MutationObserver(records => changes.push(...records))
  observer.observe(move, { attributes: true, childList: true, subtree: true })
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(reads).toBe(2)
    expect(move.disabled).toBe(false)
    expect(refresh.querySelector('svg')).toBe(icon)
    expect(refresh.classList.contains('product-control-pending')).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: zh.knowledgeSelectPage }).disabled).toBe(false)
    expect(changes).toHaveLength(0)
    fireEvent.click(move)
    expect(screen.getByRole('dialog')).toBeDefined()
  } finally {
    observer.disconnect()
    await act(async () => { response.resolve(page([document])) })
  }
})

it('retains the current folder title and add action while refreshing its path', async () => {
  const response = Promise.withResolvers<unknown>()
  let refreshing = false
  const folder = { id: 'contracts', name: '合同资料', parentId: null, updatedAt: document.updatedAt }
  transport(async (method, payload) => {
    if (method === 'knowledge.folders.get') return refreshing ? response.promise : folder
    if (method === 'knowledge.folders.list') return page((payload as { parentId: string | null }).parentId === null ? [folder] : [])
    return page([])
  })
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: folder.name }))
  const heading = await screen.findByRole('heading', { name: folder.name })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeAddMaterial }).disabled).toBe(false) })
  refreshing = true
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  expect(screen.getByRole('heading', { name: folder.name })).toBe(heading)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeAddMaterial }).disabled).toBe(false)
  await act(async () => { response.resolve({ ...folder, name: '业务合同' }) })
  expect(await screen.findByRole('heading', { name: '业务合同' })).toBe(heading)
})

it.each(['empty', 'matching'] as const)('keeps the materials toolbar and heading focus through clearing a %s filter', async (result) => {
  const response = Promise.withResolvers<unknown>()
  let waiting = false
  const api = transport(async (method, payload) => {
    if (method !== 'knowledge.documents.list') return page([])
    const { query } = payload as { query?: string }
    if (query) return page(result === 'empty' ? [] : [document])
    return waiting ? response.promise : page([document])
  })
  const view = render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  onTestFinished(() => { view.unmount(); response.resolve(page([document])) })
  await screen.findByRole('button', { name: document.filename })
  const search = screen.getByRole<HTMLInputElement>('searchbox', { name: zh.knowledgeFindFiles })
  const heading = screen.getByRole('heading', { level: 1 })
  fireEvent.change(search, { target: { value: 'filtered' } })
  fireEvent.click(screen.getByRole('button', { name: zh.search }))
  if (result === 'empty') await screen.findByText(zh.noSearchResults)
  else await screen.findByRole('button', { name: document.filename })
  const clear = screen.getByRole('button', { name: zh.knowledgeClearFilters })
  waiting = true
  clear.focus()
  fireEvent.click(clear)
  await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(3) })
  expect(search.isConnected).toBe(true)
  expect(screen.getByRole('searchbox', { name: zh.knowledgeFindFiles })).toBe(search)
  expect(screen.queryByRole('status', { name: zh.knowledgeLoadingMaterials })).toBeNull()
  expect(globalThis.document.activeElement).toBe(heading)
  expect({ search: search.value, focused: heading.textContent, loadingPlaceholder: screen.queryByRole('status', { name: zh.knowledgeLoadingMaterials }) !== null }).toMatchSnapshot()
  await act(async () => { response.resolve(page([document])) })
  expect(await screen.findByRole('button', { name: document.filename })).toBeDefined()
  expect(globalThis.document.activeElement).toBe(heading)
})

it('browses paginated materials and filters at the server without changing task selection', async () => {
  const api = transport(async (method, payload) => {
    const { page: number } = payload as { page: number }
    return method === 'knowledge.documents.list' ? page([document], 41, number) : page([], 0, number)
  })
  await act(async () => { render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />) })
  await screen.findByRole('button', { name: document.filename })
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeAddMaterial })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.nextPage }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'policy', page: 2, size: 20, folderId: null,
  }, expect.any(String)) })
  fireEvent.change(screen.getByRole('searchbox', { name: zh.knowledgeFindFiles }), { target: { value: '合同' } })
  fireEvent.click(screen.getByRole('button', { name: zh.search }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'policy', page: 1, size: 20, folderId: null, query: '合同',
  }, expect.any(String)) })
  fireEvent.change(screen.getByRole('combobox', { name: zh.knowledgeFormat }), { target: { value: 'pdf' } })
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'policy', page: 1, size: 20, folderId: null, query: '合同', format: 'pdf',
  }, expect.any(String)) })
})

it.each(['library', 'page', 'duplicate'] as const)('hides the complete document page on a %s mismatch and allows retry', async (mismatch) => {
  let invalid = true
  transport(async (method) => {
    if (method !== 'knowledge.documents.list') return page([])
    if (!invalid) return page([document])
    return page([document, { ...document, id: mismatch === 'duplicate' ? document.id : 'untrusted-doc',
      filename: '不应显示的资料.md', knowledgeBaseId: mismatch === 'library' ? 'another-base' : 'policy' }], 2,
    mismatch === 'page' ? 2 : 1)
  })
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  await screen.findByText(zh.knowledgeListFailed)
  expect(screen.queryByRole('button', { name: document.filename })).toBeNull()
  expect(screen.queryByText('不应显示的资料.md')).toBeNull()
  if (mismatch === 'library') expect(screen.getByRole('alert').outerHTML).toMatchSnapshot()
  invalid = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByRole('button', { name: document.filename })
  expect(screen.queryByText(zh.knowledgeListFailed)).toBeNull()
})

it.each(['page', 'size', 'duplicate'] as const)('hides folders and documents when the folder response has a %s mismatch', async (mismatch) => {
  let invalid = true
  const folder = { id: 'folder', name: '不应显示的文件夹', parentId: null, updatedAt: '2026-11-07T00:00:00Z' }
  transport(async method => method === 'knowledge.folders.list'
    ? invalid ? page(mismatch === 'duplicate' ? [folder, folder] : [folder], 2, mismatch === 'page' ? 2 : 1,
      mismatch === 'size' ? 10 : 20) : page([])
    : page([document]))
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  await screen.findByText(zh.knowledgeFoldersFailed)
  expect(screen.queryByRole('button', { name: document.filename })).toBeNull()
  expect(screen.queryByText(folder.name)).toBeNull()
  invalid = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByRole('button', { name: document.filename })
  expect(screen.queryByText(zh.knowledgeFoldersFailed)).toBeNull()
})

it('shows the localized failed index state without exposing parser diagnostics in library details', async () => {
  const failureMessage = 'anydoc malformed archive; internal source path: /private/parser/uploads/document.docx'
  transport(async method => method === 'knowledge.documents.list' ? page([{ ...document, status: 'FAILED', failureMessage }]) : page([]))
  const { container } = render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  const file = await screen.findByRole('button', { name: document.filename })
  expect(file.hasAttribute('disabled')).toBe(false)
  expect(within(screen.getByRole('table')).getByText(zh.knowledgeIndexFailed)).toBeDefined()
  expect(container.textContent).not.toContain(failureMessage)
})

it('lets managers stop active processing and reprocess while preserving original reading', async () => {
  let status = 'PROCESSING'
  let failed = true
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.list') return page([{ ...document, status }])
    if (method === 'knowledge.documents.cancel') {
      if (failed) throw new Error('Temporary outage')
      status = 'CANCELLED'
      return { ...document, status }
    }
    return page([])
  })
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  await screen.findByRole('button', { name: document.filename })
  expect(within(screen.getByRole('table')).getByText(zh.knowledgeProcessing).getAttribute('title')).toBe(zh.knowledgeProcessingHint)
  const actions = () => screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) })
  fireEvent.click(actions())
  expect(screen.getByRole('menuitem', { name: zh.knowledgeReindex }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeStopProcessing }))
  await screen.findByText(zh.knowledgeChangeFailed)
  failed = false
  fireEvent.click(actions())
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeStopProcessing }))
  await within(screen.getByRole('table')).findByText(zh.knowledgeCancelled)
  const calls = api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.cancel')
  expect(calls).toHaveLength(2)
  expect(calls[0]?.[2]).toEqual(calls[1]?.[2])
  fireEvent.click(actions())
  expect(screen.queryByRole('menuitem', { name: zh.knowledgeStopProcessing })).toBeNull()
  expect(screen.getByRole('menuitem', { name: zh.knowledgeReindex }).hasAttribute('disabled')).toBe(false)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeReadDocument }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.knowledgeBackToFolder })).toBeDefined() })
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.open')).toBe(true) })
})

it('keeps active files readable without showing processing management to ordinary employees', async () => {
  const api = transport(async method => method === 'knowledge.documents.list' ? page([{ ...document, status: 'QUEUED' }]) : page([]))
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  await screen.findByRole('button', { name: document.filename })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  expect(screen.queryByRole('menuitem', { name: zh.knowledgeStopProcessing })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeReadDocument }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.knowledgeBackToFolder })).toBeDefined() })
  expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.cancel')).toBe(false)
})

it('does not promise an original file for a webpage still processing', async () => {
  transport(async method => method === 'knowledge.documents.list' ? page([{ ...document, status: 'PROCESSING', sourceType: 'url' }]) : page([]))
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  await screen.findByRole('button', { name: document.filename })
  expect(within(screen.getByRole('table')).getByText(zh.knowledgeProcessing).getAttribute('title')).toBeNull()
})

it('reads document passages and cancels outstanding content requests when closed', async () => {
  let content!: (value: unknown) => void
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.list') return page([document])
    if (method === 'knowledge.documents.preview.open') return new Promise((resolve) => { content = resolve })
    return page([])
  })
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: document.filename }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.knowledgeBackToFolder })).toBeDefined() })
  const request = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  expect(request).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeBackToFolder }))
  expect(api.cancel).toHaveBeenCalledWith('product', request?.[3])
  await act(async () => { content(page([{ id: 'chunk', documentId: document.id, content: '旧正文', locator: '第 1 页' }])) })
  expect(screen.queryByText('旧正文')).toBeNull()
})

it('preserves edits and the idempotency key after a failed manual document save', async () => {
  const saved = vi.fn()
  let failed = true
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.get') return { ...document, manualContent: '# 原正文', canManage: true }
    if (failed) throw new Error('Temporary outage')
    return document
  })
  const editorProps = { knowledgeBaseId: 'policy', target: { kind: 'markdown' as const, document }, onClose: vi.fn(), onSaved: saved }
  const view = render(<KnowledgeEditor {...editorProps} t={t} />)
  const body = await screen.findByDisplayValue('# 原正文')
  fireEvent.change(body, { target: { value: '# 修改后的正文' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await screen.findByText(zh.knowledgeSaveFailed)
  expect(screen.getByDisplayValue('# 修改后的正文')).toBeDefined()
  expect(saved).not.toHaveBeenCalled()
  view.rerender(<KnowledgeEditor {...editorProps} t={key => en[key]} />)
  expect(screen.getByRole('alert').textContent).toBe(en.knowledgeSaveFailed)
  expect(screen.getByRole('textbox', { name: en.knowledgeMarkdownContent })).toHaveProperty('value', '# 修改后的正文')
  expect(screen.getByRole('alert').textContent).toMatchInlineSnapshot('"Save did not complete. Your edits are preserved. Retry."')
  failed = false
  fireEvent.click(screen.getByRole('button', { name: en.knowledgeRetrySave }))
  await waitFor(() => { expect(saved).toHaveBeenCalledOnce() })
  const calls = api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.save')
  expect(calls).toHaveLength(2)
  expect(calls[0]?.[2]).toEqual(calls[1]?.[2])
  expect(calls[0]?.[2]).toMatchObject({ knowledgeBaseId: 'policy', documentId: document.id, expectedUpdatedAt: document.updatedAt,
    title: '业务规范', content: '# 修改后的正文', operationId: expect.any(String) as string })
})

it.each(['markdown', 'url'] as const)('preserves %s creation destination and edits after an unconfirmed placement', async (kind) => {
  const saved = vi.fn()
  const api = transport(async () => { throw new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Remote result unknown', false) })
  render(<KnowledgeEditor knowledgeBaseId="policy" target={{ kind, folderId: 'folder' }} onClose={vi.fn()} onSaved={saved} t={t} />)
  fireEvent.change(screen.getByLabelText(kind === 'url' ? zh.knowledgeOptionalTitle : zh.knowledgeDocumentTitle), { target: { value: 'Notes' } })
  fireEvent.change(screen.getByLabelText(kind === 'markdown' ? zh.knowledgeMarkdownContent : zh.knowledgeWebsiteUrl),
    { target: { value: kind === 'markdown' ? '# Notes' : 'https://example.test' } })
  fireEvent.click(screen.getByRole('button', { name: kind === 'url' ? zh.knowledgeStartImport : zh.knowledgeSave }))
  await screen.findByText(`${zh.knowledgeOperationUnknown} (IDEMPOTENCY_OPERATION_UNKNOWN)`)
  expect(screen.getByDisplayValue(kind === 'markdown' ? '# Notes' : 'https://example.test')).toBeDefined()
  expect(saved).not.toHaveBeenCalled()
  expect(api.invoke).toHaveBeenCalledWith('product', kind === 'markdown' ? 'knowledge.documents.save' : 'knowledge.documents.importUrl',
    expect.objectContaining({ knowledgeBaseId: 'policy', folderId: 'folder', title: 'Notes', operationId: expect.any(String) as string }), expect.any(String))
})

it('exposes upload and creation only to a library manager and accepts native picker cancellation', async () => {
  const api = transport(async method => method === 'knowledge.documents.upload.select' ? [] : page([]))
  render(<StrictMode><KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} /></StrictMode>)
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeAddMaterial }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeUpload }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.knowledgeAddMaterial }).hasAttribute('disabled')).toBe(false) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.upload.select', {
    knowledgeBaseId: 'policy', pdfParseMode: 'STANDARD', folderId: null,
  }, expect.any(String), 300_000)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeNewDocument }))
  await screen.findByRole('dialog', { name: zh.knowledgeNewDocument })
})

it('offers no-OCR PDF extraction without accepting a renderer file path or changing the task', async () => {
  const api = transport(async method => method === 'knowledge.documents.upload.select'
    ? [{ operationId: 'pdf-upload-operation-1', filename: 'policy.pdf', pdfParseMode: 'STANDARD', folderId: null, canConfigure: true }]
    : method === 'knowledge.documents.upload.configure' ? { operationId: 'pdf-configured-operation-1', filename: 'policy.pdf', pdfParseMode: 'TEXT', folderId: null, canConfigure: true }
      : method === 'knowledge.documents.upload' ? { ...document, filename: 'policy.pdf', status: 'QUEUED' }
        : method === 'knowledge.documents.upload.discard' ? { discarded: true } : page([]))
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeAddMaterial }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeUpload }))
  const dialog = within(await screen.findByRole('dialog', { name: zh.knowledgeUploadFiles }))
  fireEvent.click(dialog.getByText(zh.knowledgePdfHandling, { selector: 'summary' }))
  fireEvent.change(dialog.getByRole('combobox', { name: zh.knowledgePdfHandling }), { target: { value: 'TEXT' } })
  await waitFor(() => { expect(dialog.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeUpload }).disabled).toBe(false) })
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeUpload }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.upload', {
    knowledgeBaseId: 'policy', operationId: expect.any(String) as string, pdfParseMode: 'TEXT', folderId: null,
  }, expect.any(String), 300_000) })
  await screen.findByText(zh.knowledgeUploadAccepted)
  expect(api.invoke.mock.calls.some(row => row[1].startsWith('tasks.'))).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([
  ['KNOWLEDGE_DOCUMENT_DUPLICATE', 'knowledgeDocumentDuplicate'],
  ['KNOWLEDGE_PARSE_MODE_INVALID', 'knowledgeParseModeInvalid'],
] as const)('explains %s without suggesting that another upload changes existing parsing', async (code, key) => {
  transport(async (method) => {
    if (method === 'knowledge.documents.upload.select') throw new ProductError(code, 'Private upstream response', false)
    return page([])
  })
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeAddMaterial }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeUpload }))
  expect((await screen.findByRole('alert')).textContent).toContain(zh[key])
  expect(screen.getByRole('alert').textContent).not.toContain('Private upstream')
  expect(screen.getByRole('alert').textContent).not.toContain(zh.knowledgeUploadFailed)
})

it('keeps folder browsing scoped to stable folder IDs and retains server-side permissions', async () => {
  const api = transport(async (method, payload) => method === 'knowledge.folders.list' && typeof payload === 'object' && payload !== null && 'parentId' in payload && payload.parentId === null
    ? page([{ id: 'folder-1', name: '业务制度', parentId: null, updatedAt: '2026-10-17T00:00:00Z' }]) : page([]))
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  fireEvent.click((await screen.findAllByRole('button', { name: '业务制度' }))[0]!)
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'policy', page: 1, size: 20, folderId: 'folder-1',
  }, expect.any(String)) })
  fireEvent.click(screen.getByRole('button', { name: '业务规范' }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'policy', page: 1, size: 20, folderId: null,
  }, expect.any(String)) })
  expect(screen.queryByRole('button', { name: zh.knowledgeRenameFolder })).toBeNull()
})

it('retains the delete confirmation and operation identity after a temporary failure', async () => {
  let failed = true
  let deleted = false
  const response = Promise.withResolvers<undefined>()
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.list') return page(deleted ? [] : [document])
    if (method === 'knowledge.documents.delete') {
      if (failed) throw new Error('Temporary outage')
      await response.promise
      deleted = true
      return { documentId: document.id, taskId: 'deletion-task', status: 'DELETING' }
    }
    return page([])
  })
  const documentProps = { renderFactorySlot: renderKnowledgePreview, product: library(true) }
  const view = render(<KnowledgeDocuments {...documentProps} t={t} />)
  onTestFinished(() => { view.unmount(); response.resolve(undefined) })
  fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.deleteResource }))
  fireEvent.click(screen.getByRole('button', { name: zh.deleteResource }))
  await screen.findByRole('dialog', { name: zh.knowledgeDeleteDocument })
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.deleteResource }).hasAttribute('disabled')).toBe(false) })
  const reads = api.invoke.mock.calls.length
  view.rerender(<KnowledgeDocuments {...documentProps} t={key => en[key]} />)
  expect(within(screen.getByRole('dialog', { name: en.knowledgeDeleteDocument })).getByRole('alert').textContent).toBe(en.knowledgeChangeFailed)
  expect(api.invoke).toHaveBeenCalledTimes(reads)
  failed = false
  const notice = within(screen.getByRole('dialog')).getByRole('alert')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: en.deleteResource })
  retry.focus()
  act(() => { retry.click(); retry.click(); fireEvent.keyDown(retry, { key: 'Escape' }) })
  expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.delete')).toHaveLength(2)
  expect(within(screen.getByRole('dialog')).getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: en.deletingResource })).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(globalThis.document.activeElement).toBe(retry)
  const cancel = screen.getByRole<HTMLButtonElement>('button', { name: en.cancel })
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  expect(cancel.disabled).toBe(false)
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(cancel)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect({ message: notice.textContent, action: retry.textContent, focused: globalThis.document.activeElement === retry }).toMatchSnapshot('Pending document deletion retry')
  await act(async () => { response.resolve(undefined) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  const calls = api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.delete')
  expect(calls).toHaveLength(2)
  expect(calls[0]?.[2]).toEqual(calls[1]?.[2])
  expect(calls[0]?.[2]).toMatchObject({ knowledgeBaseId: 'policy', documentId: document.id, operationId: expect.any(String) as string })
})

it.each([
  ['materials', false], ['materials', true], ['reader', false], ['reader', true],
] as const)('recovers document deletion focus from %s without taking focus elsewhere (%s)', async (source, elsewhere) => {
  const response = Promise.withResolvers<undefined>()
  const refreshed = Promise.withResolvers<unknown>()
  let reads = 0
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.list') return ++reads === 1 ? page([document]) : refreshed.promise
    if (method === 'knowledge.documents.delete') {
      await response.promise
      return { documentId: document.id, taskId: 'deletion-task', status: 'DELETING' }
    }
    return page([])
  })
  const product = library(true)
  const view = render(<><KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={product} t={t} />
    <input aria-label="其他操作" /></>)
  onTestFinished(() => { view.unmount(); response.resolve(undefined); refreshed.resolve(page([])) })
  const file = await screen.findByRole('button', { name: document.filename })
  const search = screen.getByRole<HTMLInputElement>('searchbox', { name: zh.knowledgeFindFiles })
  fireEvent.change(search, { target: { value: '未提交的筛选词' } })
  if (source === 'reader') fireEvent.click(file)
  const action = screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) })
  fireEvent.click(action)
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.deleteResource }))
  const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: zh.deleteResource })
  confirm.focus()
  act(() => { confirm.click(); confirm.click() })
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.delete')).toHaveLength(1)
  const other = screen.getByRole<HTMLInputElement>('textbox', { name: '其他操作' })
  if (elsewhere) { other.focus(); other.value = 'draft'; other.setSelectionRange(1, 3) }
  await act(async () => { response.resolve(undefined) })
  expect(screen.queryByRole('dialog')).toBeNull()
  const heading = screen.getByRole('heading', { name: product.name, level: 1 })
  expect(globalThis.document.activeElement).toBe(elsewhere ? other : heading)
  expect(screen.getByRole('searchbox', { name: zh.knowledgeFindFiles })).toBe(search)
  expect(search.value).toBe('未提交的筛选词')
  await act(async () => { refreshed.resolve(page([])) })
  expect(screen.queryByRole('button', { name: document.filename })).toBeNull()
  expect(globalThis.document.activeElement).toBe(elsewhere ? other : heading)
  if (elsewhere) expect([other.value, other.selectionStart, other.selectionEnd]).toEqual(['draft', 1, 3])
})

it('rechecks manager permissions before loading editable manual text', async () => {
  const api = transport(async () => ({ ...document, canManage: false }))
  render(<KnowledgeEditor knowledgeBaseId="policy" target={{ kind: 'markdown', document }} onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  await screen.findByText(zh.knowledgeReadFailed)
  expect(screen.getByRole('button', { name: zh.knowledgeSave }).hasAttribute('disabled')).toBe(true)
  expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.save')).toBe(false)
})

it.each(['delete', 'reindex', 'cancel'] as const)('retains the %s operation identity after a mismatched success receipt', async (action) => {
  let valid = false
  const row = { ...document, status: action === 'cancel' ? 'PROCESSING' : 'READY' }
  const method = `knowledge.documents.${action}`
  const receipt = action === 'delete' ? { documentId: document.id, taskId: 'deletion-task', status: 'DELETING' }
    : { ...row, status: action === 'cancel' ? 'CANCELLED' : 'QUEUED' }
  const api = transport(async name => name === 'knowledge.documents.list' ? page([row]) : name === method
    ? valid ? receipt : { ...receipt, ...action === 'delete' ? { documentId: 'another-document' } : { id: 'another-document' } } : page([]))
  render(<KnowledgeDocuments renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  const trigger = async () => {
    fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
    fireEvent.click(screen.getByRole('menuitem', { name: action === 'delete' ? zh.deleteResource : action === 'cancel' ? zh.knowledgeStopProcessing : zh.knowledgeReindex }))
    if (action === 'delete') fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.deleteResource }))
  }
  await trigger()
  const outcome = action === 'delete' ? within(screen.getByRole('dialog')) : screen
  await outcome.findByRole('alert')
  valid = true
  if (action === 'delete') fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.deleteResource }))
  else await trigger()
  await waitFor(() => { expect(screen.queryAllByRole('alert')).toHaveLength(0) })
  const writes = api.invoke.mock.calls.filter(call => call[1] === method)
  expect(writes).toHaveLength(2)
  expect(writes[0]![2]).toEqual(writes[1]![2])
})
