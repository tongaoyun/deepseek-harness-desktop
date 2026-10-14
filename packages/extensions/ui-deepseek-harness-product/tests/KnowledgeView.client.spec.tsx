// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeDetail } from '../src/client/KnowledgeView.tsx'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { detail } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
import { createPreviewFixture, originalMetadata, renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const document = {
  id: 'doc-1', knowledgeBaseId: 'policy', filename: '业务规范.md', mediaType: 'text/markdown',
  sizeBytes: 1024, status: 'READY', chunkCount: 1, updatedAt: '2026-10-10T00:00:00Z', sourceType: 'manual',
}
const page = (items: readonly unknown[], total = items.length, number = 1, size = 20) => ({ items, page: number, size, total })
const library = (canManage = false) => detail({ id: 'policy', name: '业务规范', scope: 'PERSONAL', ownerName: '张三', canManage }, {})!

function transport(handler: (method: string, payload: unknown) => Promise<unknown>) {
  const preview = createPreviewFixture()
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown, _requestId?: string) => {
    if (method === 'knowledge.documents.previewMetadata') return { ok: true, result: originalMetadata('policy', 'doc-1') }
    return { ok: true, result: await preview(method, payload, handler) }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('browses paginated materials and filters at the server without changing task selection', async () => {
  const api = transport(async method => method === 'knowledge.documents.list' ? page([document], 41) : page([]))
  render(<KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  await screen.findByRole('button', { name: document.filename })
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeUpload })).toBeNull()
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

it('shows the localized failed index state without exposing parser diagnostics in library details', async () => {
  const failureMessage = 'anydoc malformed archive; internal source path: /private/parser/uploads/document.docx'
  transport(async method => method === 'knowledge.documents.list' ? page([{ ...document, status: 'FAILED', failureMessage }]) : page([]))
  const { container } = render(<KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  const file = await screen.findByRole('button', { name: document.filename })
  expect(file.hasAttribute('disabled')).toBe(false)
  expect(within(screen.getByRole('table')).getByText(zh.knowledgeIndexFailed)).toBeDefined()
  expect(container.textContent).not.toContain(failureMessage)
})

it('reads document passages and cancels outstanding content requests when closed', async () => {
  let content!: (value: unknown) => void
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.list') return page([document])
    if (method === 'knowledge.documents.preview.open') return new Promise((resolve) => { content = resolve })
    return page([])
  })
  render(<KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: document.filename }))
  await screen.findByRole('dialog', { name: document.filename })
  const request = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')
  expect(request).toBeDefined()
  fireEvent.click(screen.getAllByRole('button', { name: zh.close })[0]!)
  expect(api.cancel).toHaveBeenCalledWith('product', request?.[3])
  await act(async () => { content(page([{ id: 'chunk', documentId: document.id, content: '旧正文', locator: '第 1 页' }])) })
  expect(screen.queryByText('旧正文')).toBeNull()
})

it('searches one selected library and opens a retrieval source through the server', async () => {
  const hit = { sourceId: 'chunk-1', documentId: document.id, filename: document.filename, content: '合同依据', locator: '第 1 页' }
  const api = transport(async method => method === 'knowledge.search' ? [hit] : method === 'knowledge.sources.read'
    ? { ...hit, content: '完整来源' } : method === 'knowledge.documents.preview.open'
      ? page([{ id: 'chunk-all', documentId: document.id, content: '完整文档正文', locator: '第 1 页' }]) : page([]))
  render(<KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  fireEvent.click(screen.getByRole('tab', { name: zh.knowledgeRetrieval }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'policy' } })
  fireEvent.click(screen.getByRole('button', { name: zh.search }))
  fireEvent.click(await screen.findByRole('button', { name: document.filename }))
  await screen.findByText('完整来源')
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.search', {
    query: 'policy', knowledgeBaseIds: ['policy'], knowledgeBaseRefs: [], restrictToKnowledgeBaseRefs: true, limit: 8,
  }, expect.any(String))
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.sources.read', { sourceId: 'chunk-1' }, expect.any(String))
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
  await screen.findByText('完整文档正文')
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: 'policy', documentId: document.id,
  }, expect.any(String), 300_000)
})

it('preserves edits and the idempotency key after a failed manual document save', async () => {
  const saved = vi.fn()
  let failed = true
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.get') return { ...document, manualContent: '# 原正文', canManage: true }
    if (failed) throw new Error('Temporary outage')
    return document
  })
  render(<KnowledgeEditor knowledgeBaseId="policy" target={{ kind: 'markdown', document }} onClose={vi.fn()} onSaved={saved} t={t} />)
  const body = await screen.findByDisplayValue('# 原正文')
  fireEvent.change(body, { target: { value: '# 修改后的正文' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await screen.findByText(zh.knowledgeSaveFailed)
  expect(screen.getByDisplayValue('# 修改后的正文')).toBeDefined()
  expect(saved).not.toHaveBeenCalled()
  failed = false
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
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
  fireEvent.change(screen.getByLabelText(zh.knowledgeDocumentTitle), { target: { value: 'Notes' } })
  fireEvent.change(screen.getByLabelText(kind === 'markdown' ? zh.knowledgeMarkdownContent : zh.knowledgeWebsiteUrl),
    { target: { value: kind === 'markdown' ? '# Notes' : 'https://example.test' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await screen.findByText(`${zh.knowledgeOperationUnknown} (IDEMPOTENCY_OPERATION_UNKNOWN)`)
  expect(screen.getByDisplayValue(kind === 'markdown' ? '# Notes' : 'https://example.test')).toBeDefined()
  expect(saved).not.toHaveBeenCalled()
  expect(api.invoke).toHaveBeenCalledWith('product', kind === 'markdown' ? 'knowledge.documents.save' : 'knowledge.documents.importUrl',
    expect.objectContaining({ knowledgeBaseId: 'policy', folderId: 'folder', title: 'Notes', operationId: expect.any(String) as string }), expect.any(String))
})

it('exposes upload and creation only to a library manager and accepts native picker cancellation', async () => {
  const api = transport(async method => method === 'knowledge.documents.upload' ? { cancelled: true } : page([]))
  render(<StrictMode><KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} /></StrictMode>)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeUploadStandard }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.knowledgeUpload }).hasAttribute('disabled')).toBe(false) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.upload', {
    knowledgeBaseId: 'policy', operationId: expect.any(String) as string, pdfParseMode: 'STANDARD', folderId: null,
  }, expect.any(String), 300_000)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeNewDocument }))
  await screen.findByRole('dialog', { name: zh.knowledgeNewDocument })
})

it('offers no-OCR PDF extraction without accepting a renderer file path or changing the task', async () => {
  const api = transport(async method => method === 'knowledge.documents.upload' ? { ...document, filename: 'policy.pdf', status: 'QUEUED' } : page([]))
  render(<KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeUploadTextPdf }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.upload', {
    knowledgeBaseId: 'policy', operationId: expect.any(String) as string, pdfParseMode: 'TEXT', folderId: null,
  }, expect.any(String), 300_000) })
  expect(api.invoke.mock.calls.some(row => row[1].startsWith('tasks.'))).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([
  ['KNOWLEDGE_DOCUMENT_DUPLICATE', 'knowledgeDocumentDuplicate'],
  ['KNOWLEDGE_PARSE_MODE_INVALID', 'knowledgeParseModeInvalid'],
] as const)('explains %s without suggesting that another upload changes existing parsing', async (code, key) => {
  transport(async (method) => {
    if (method === 'knowledge.documents.upload') throw new ProductError(code, 'Private upstream response', false)
    return page([])
  })
  render(<KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeUpload }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.knowledgeUploadTextPdf }))
  expect((await screen.findByRole('alert')).textContent).toContain(zh[key])
  expect(screen.getByRole('alert').textContent).not.toContain('Private upstream')
  expect(screen.getByRole('alert').textContent).not.toContain(zh.knowledgeUploadFailed)
})

it('keeps folder browsing scoped to stable folder IDs and retains server-side permissions', async () => {
  const api = transport(async method => method === 'knowledge.folders.list' ? page([{ id: 'folder-1', name: '业务制度', parentId: null }]) : page([]))
  render(<KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library()} t={t} />)
  fireEvent.click((await screen.findAllByRole('button', { name: '业务制度' }))[0]!)
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'policy', page: 1, size: 20, folderId: 'folder-1',
  }, expect.any(String)) })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRootFolder }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.list', {
    knowledgeBaseId: 'policy', page: 1, size: 20, folderId: null,
  }, expect.any(String)) })
  expect(screen.queryByRole('button', { name: zh.knowledgeRenameFolder })).toBeNull()
})

it('retains the delete confirmation and operation identity after a temporary failure', async () => {
  let failed = true
  let deleted = false
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.list') return page(deleted ? [] : [document])
    if (method === 'knowledge.documents.delete') {
      if (failed) throw new Error('Temporary outage')
      deleted = true
      return { documentId: document.id, taskId: 'deletion-task', status: 'DELETING' }
    }
    return page([])
  })
  render(<KnowledgeDetail renderFactorySlot={renderKnowledgePreview} product={library(true)} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.deleteResource }))
  fireEvent.click(screen.getByRole('button', { name: zh.deleteResource }))
  await screen.findByRole('dialog', { name: zh.knowledgeDeleteDocument })
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.deleteResource }).hasAttribute('disabled')).toBe(false) })
  failed = false
  fireEvent.click(screen.getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  const calls = api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.delete')
  expect(calls).toHaveLength(2)
  expect(calls[0]?.[2]).toEqual(calls[1]?.[2])
  expect(calls[0]?.[2]).toMatchObject({ knowledgeBaseId: 'policy', documentId: document.id, operationId: expect.any(String) as string })
})

it('rechecks manager permissions before loading editable manual text', async () => {
  const api = transport(async () => ({ ...document, canManage: false }))
  render(<KnowledgeEditor knowledgeBaseId="policy" target={{ kind: 'markdown', document }} onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  await screen.findByText(zh.knowledgeReadFailed)
  expect(screen.getByRole('button', { name: zh.knowledgeSave }).hasAttribute('disabled')).toBe(true)
  expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.save')).toBe(false)
})
