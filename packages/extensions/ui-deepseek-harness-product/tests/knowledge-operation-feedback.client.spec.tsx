// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { KnowledgeBaseEditor } from '../src/client/KnowledgeBaseEditor.tsx'
import { en, zh } from '../src/locales.ts'

const document = { id: 'doc', knowledgeBaseId: 'personal', filename: '原文.md', mediaType: 'text/markdown',
  sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-09T00:00:00Z', folderId: null,
  sourceType: 'manual', canManage: true, manualContent: '原始正文' }
const folder = { id: 'folder', name: '原目录', parentId: null, updatedAt: document.updatedAt }
const base = { id: 'personal', name: '原知识库', description: '', scope: 'PERSONAL', canManage: true, updatedAt: document.updatedAt }
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals() })

it.each(['markdown', 'url', 'folder', 'base-create', 'base-edit'] as const)(
  'keeps the %s suspension focused and distinct from saving through an identity failure', async (kind) => {
    const gates = [Promise.withResolvers<unknown>(), Promise.withResolvers<unknown>()]
    const method = kind === 'markdown' ? 'knowledge.documents.save' : kind === 'url' ? 'knowledge.documents.importUrl'
      : kind === 'folder' ? 'knowledge.folders.rename' : kind === 'base-create' ? 'knowledge.bases.create' : 'knowledge.bases.update'
    let reads = 0
    const invoke = vi.fn(async (_namespace: string, requested: string, _payload: unknown) => {
      if (requested === 'auth.getSession') return { ok: true, result: await gates[reads++]!.promise }
      if (requested === method) throw new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Outcome unconfirmed', true)
      return { ok: true, result: requested === 'knowledge.bases.get' ? base : document }
    })
    vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
    const onSaved = vi.fn(), onClose = vi.fn()
    const target = kind === 'folder' ? { kind: 'folder' as const, folder }
      : kind === 'markdown' ? { kind: 'markdown' as const, document } : { kind: 'url' as const }
    const form = (english = false) => {
      const props = { onSaved, onClose, t: (key: keyof typeof zh) => (english ? en : zh)[key] }
      return kind.startsWith('base-') ? <KnowledgeBaseEditor {...props} {...kind === 'base-edit' ? { knowledgeBaseId: 'personal' } : {}} />
        : <KnowledgeEditor {...props} knowledgeBaseId="personal" target={target} />
    }
    const view = render(form())
    onTestFinished(() => { view.unmount(); gates.forEach((gate) => { gate.resolve(undefined) }) })
    const field = await screen.findByRole('textbox', { name: kind.startsWith('base-') ? zh.knowledgeBaseName
      : kind === 'folder' ? zh.knowledgeFolderName : kind === 'url' ? zh.knowledgeWebsiteUrl : zh.knowledgeDocumentTitle })
    if (kind === 'markdown') await screen.findByDisplayValue(document.manualContent)
    fireEvent.change(field, { target: { value: kind === 'url' ? 'https://example.test/retained' : '保留草稿' } })
    fireEvent.click(screen.getByRole('button', { name: kind === 'base-create' ? zh.knowledgeCreate
      : kind === 'url' ? zh.knowledgeStartImport : zh.knowledgeSave }))
    const notice = await screen.findByRole('alert')
    const dialog = screen.getByRole('dialog')
    const keep = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSuspendSave })
    keep.focus()
    act(() => { keep.click(); keep.click(); fireEvent.keyDown(keep, { key: 'Escape' }) })
    expect(reads).toBe(1)
    expect(keep.disabled).toBe(false)
    expect(keep.getAttribute('aria-disabled')).toBe('true')
    expect(keep.getAttribute('aria-busy')).toBe('true')
    expect(globalThis.document.activeElement).toBe(keep)
    const save = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeRetrySave })
    expect(save.getAttribute('aria-busy')).toBe('false')
    expect(save.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(save)
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(screen.getByRole('alert')).toBe(notice)
    expect(screen.getByText(zh.knowledgeWaitForSave)).toBeTruthy()
    view.rerender(form(true))
    expect(reads).toBe(1)
    expect(screen.getByText(en.knowledgeWaitForSave)).toBeTruthy()
    await act(async () => { gates[0]!.reject(new Error('Identity unavailable')) })
    expect(keep.getAttribute('aria-busy')).toBe('false')
    expect(keep.getAttribute('aria-disabled')).toBe('false')
    expect(globalThis.document.activeElement).toBe(keep)
    expect(screen.getByRole('alert')).toBe(notice)
    act(() => { keep.click(); keep.click() })
    expect(reads).toBe(2)
    expect({ action: keep.textContent, busy: keep.getAttribute('aria-busy'), save: save.textContent,
      saving: save.getAttribute('aria-busy'), error: notice.textContent, waiting: screen.getByText(en.knowledgeWaitForSave).textContent,
      focused: globalThis.document.activeElement === keep }).toMatchSnapshot()
    await act(async () => { gates[1]!.resolve({ authenticated: true, employeeId: 'employee' }) })
    expect(onClose).toHaveBeenCalledOnce()
    expect(onSaved).not.toHaveBeenCalled()
    expect(sessionStorage.length).toBe(1)
    const stored = JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!) as { save: { method: string; payload: unknown } }
    const writes = invoke.mock.calls.filter(call => call[1] === method)
    expect(writes).toHaveLength(1)
    expect(stored.save).toEqual({ method, payload: writes[0]![2] })
  },
)

it.each(['markdown', 'url', 'folder', 'base-create', 'base-edit'] as const)(
  'keeps %s save feedback and locks repeated submission and dismissal before rendering', async (kind) => {
    const response = Promise.withResolvers<unknown>()
    const method = kind === 'markdown' ? 'knowledge.documents.save' : kind === 'url' ? 'knowledge.documents.importUrl'
      : kind === 'folder' ? 'knowledge.folders.rename' : kind === 'base-create' ? 'knowledge.bases.create' : 'knowledge.bases.update'
    let writes = 0
    const invoke = vi.fn(async (_namespace: string, requested: string, _payload: unknown) => {
      if (requested !== method) return { ok: true, result: requested === 'knowledge.bases.get' ? base : document }
      if (++writes === 1) throw new Error('Temporary outage')
      return { ok: true, result: await response.promise }
    })
    vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
    const onSaved = vi.fn(), onClose = vi.fn()
    const props = { onSaved, onClose, t: (key: keyof typeof zh) => zh[key] }
    const form = (english = false) => {
      const localized = { ...props, t: (key: keyof typeof zh) => (english ? en : zh)[key] }
      return kind === 'base-create' || kind === 'base-edit'
        ? <KnowledgeBaseEditor {...localized} {...kind === 'base-edit' ? { knowledgeBaseId: 'personal' } : {}} />
        : <KnowledgeEditor {...localized} knowledgeBaseId="personal" target={kind === 'folder' ? { kind, folder }
          : kind === 'markdown' ? { kind, document } : { kind }} />
    }
    const view = render(form())
    onTestFinished(() => { view.unmount(); response.resolve(document) })
    const field = await screen.findByRole('textbox', { name: kind.startsWith('base-') ? zh.knowledgeBaseName
      : kind === 'folder' ? zh.knowledgeFolderName : kind === 'url' ? zh.knowledgeWebsiteUrl : zh.knowledgeDocumentTitle })
    if (kind === 'markdown') await screen.findByDisplayValue(document.manualContent)
    fireEvent.change(field, { target: { value: kind === 'url' ? 'https://example.test/notes' : '保留草稿' } })
    const button = screen.getByRole<HTMLButtonElement>('button', { name: kind === 'url' ? zh.knowledgeStartImport
      : kind === 'base-create' ? zh.knowledgeCreate : zh.knowledgeSave })
    fireEvent.click(button)
    const notice = await screen.findByRole('alert')
    button.focus()
    act(() => { button.click(); button.click(); fireEvent.keyDown(button, { key: 'Escape' }) })
    expect(writes).toBe(2)
    expect(screen.getByRole('dialog')).not.toBeNull()
    expect(screen.queryByText(zh.knowledgeDiscardDraftConfirmation)).toBeNull()
    expect(screen.getByRole('alert')).toBe(notice)
    expect(onClose).not.toHaveBeenCalled()
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(globalThis.document.activeElement).toBe(button)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(button.classList.contains('product-control-pending')).toBe(true)
    view.rerender(form(true))
    expect(screen.getByRole('alert')).toBe(notice)
    expect({ error: notice.textContent, action: button.textContent,
      focused: globalThis.document.activeElement === button }).toMatchSnapshot()
    const receipt = kind === 'folder' ? { ...folder, name: '保留草稿' } : kind.startsWith('base-') ? { ...base, name: '保留草稿' } : document
    await act(async () => { response.resolve(receipt) })
    await waitFor(() => { expect(onSaved).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('alert')).toBeNull()
    const calls = invoke.mock.calls.filter(call => call[1] === method)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.[2]).toEqual(calls[0]?.[2])
  },
)

it('keeps conflict-read feedback and the save button idle until a fresh version is confirmed', async () => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, method: string) => {
    if (method !== 'knowledge.documents.get') throw new ProductError('KNOWLEDGE_DOCUMENT_CONFLICT', 'Changed')
    if (++reads === 1) return { ok: true, result: document }
    if (reads === 2) throw new Error('Offline')
    return { ok: true, result: await response.promise }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'markdown', document }}
    onClose={vi.fn()} onSaved={vi.fn()} t={key => zh[key]} />)
  onTestFinished(() => { view.unmount(); response.resolve(document) })
  await screen.findByDisplayValue(document.manualContent)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadLatest }))
  await screen.findByText(zh.knowledgeReadFailed)
  const notice = screen.getByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeReadLatest })
  act(() => { retry.click(); retry.click() })
  expect(reads).toBe(3)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.getByRole('button', { name: zh.knowledgeSave }).getAttribute('aria-busy')).toBe('false')
  expect(screen.queryByRole('button', { name: zh.knowledgeContinueDraft })).toBeNull()
  await act(async () => { response.resolve({ ...document, updatedAt: '2026-11-09T01:00:00Z' }) })
  await screen.findByRole('button', { name: zh.knowledgeContinueDraft })
  expect(screen.queryByRole('alert')).toBeNull()
})
