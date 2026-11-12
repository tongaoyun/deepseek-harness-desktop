// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { KnowledgeDocuments } from '../src/client/KnowledgeDocuments.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const document = { id: 'doc', knowledgeBaseId: 'base', filename: '业务资料.md', mediaType: 'text/markdown',
  sizeBytes: 10, status: 'READY', chunkCount: 1, updatedAt: '2026-11-09T00:00:00Z', folderId: null }
const folder = { id: 'folder', name: '目标目录', parentId: null, updatedAt: document.updatedAt }

async function mountMove() {
  const first = Promise.withResolvers<unknown>()
  const retry = Promise.withResolvers<unknown>()
  let writes = 0
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => {
    if (method === 'knowledge.documents.upload.pending') return { ok: true, result: [] }
    if (method === 'knowledge.documents.move') return { ok: true, result: await (++writes === 1 ? first.promise : retry.promise) }
    if (method === 'knowledge.folders.get') return { ok: true, result: folder }
    const folders = method === 'knowledge.folders.list'
    const rows = folders ? (payload as { parentId: string | null }).parentId === null ? [folder] : [] : [document]
    return { ok: true, result: { items: rows, total: rows.length, page: 1, size: 20 } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const product = localDetail(items([{ id: 'base', name: '业务资料库', scope: 'PERSONAL', canManage: true }])[0]!)
  const view = render(<KnowledgeDocuments product={product} renderFactorySlot={() => null} t={key => zh[key]} />)
  onTestFinished(() => { view.unmount(); first.resolve(undefined); retry.resolve(undefined) })
  await screen.findByRole('button', { name: document.filename })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeMoveDocument }))
  const dialog = screen.getByRole('dialog', { name: zh.knowledgeMoveDocument })
  const form = within(dialog)
  fireEvent.click(await form.findByRole('button', { name: folder.name }))
  const confirm = form.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeMove })
  await waitFor(() => { expect(confirm.disabled).toBe(false) })
  return { first, retry, invoke, writes: () => writes, dialog, form, confirm }
}

it.each(['network', 'invalid-receipt'] as const)('pins a double-clicked move through %s failure and keeps its retry controls stable', async (outcome) => {
  const { first, retry, invoke, writes, dialog, form, confirm } = await mountMove()
  const cancel = form.getByRole('button', { name: zh.cancel })
  const close = form.getByRole('button', { name: zh.close })
  const root = form.getByRole('button', { name: zh.knowledgeRootFolder })
  confirm.focus()
  act(() => { confirm.click(); confirm.click(); fireEvent.click(root); fireEvent.click(cancel); fireEvent.click(close) })
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(globalThis.document.activeElement).toBe(confirm)
  expect(confirm.disabled).toBe(false)
  expect(confirm.getAttribute('aria-disabled')).toBe('true')
  await waitFor(() => { expect(writes()).toBe(1) })
  await act(async () => {
    if (outcome === 'network') first.reject(new Error('Connection lost'))
    else first.resolve({ documentId: document.id, folderId: null, moved: true })
  })
  const notice = await form.findByRole('alert')
  expect(globalThis.document.activeElement).toBe(confirm)
  expect(form.getByRole('button', { name: folder.name }).getAttribute('aria-current')).toBe('page')
  await waitFor(() => { expect(confirm.disabled).toBe(false) })
  act(() => { confirm.click(); confirm.click(); fireEvent.click(cancel) })
  fireEvent.keyDown(confirm, { key: 'Escape' })
  expect(screen.getByRole('dialog')).toBe(dialog)
  const calls = invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.move')
  expect(calls).toHaveLength(2)
  expect(calls[1]?.[2]).toEqual(calls[0]?.[2])
  expect(calls[0]?.[2]).toEqual({ knowledgeBaseId: 'base', documentId: document.id, folderId: folder.id,
    expectedFolderId: null, expectedUpdatedAt: document.updatedAt, operationId: expect.any(String) as string })
  expect(form.getByRole('alert')).toBe(notice)
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(form.getByRole('button', { name: zh.knowledgeMove })).toBe(confirm)
  expect(confirm.getAttribute('aria-busy')).toBe('true')
  expect(confirm.classList.contains('product-control-pending')).toBe(true)
  expect(cancel.classList.contains('product-control-pending')).toBe(true)
  expect(cancel).toHaveProperty('disabled', false)
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  expect(cancel.getAttribute('aria-busy')).not.toBe('true')
  expect({ outcome, error: notice.textContent, action: confirm.textContent, busy: confirm.getAttribute('aria-busy'),
    cancelLocked: cancel.getAttribute('aria-disabled') === 'true', focused: globalThis.document.activeElement === confirm }).toMatchSnapshot()
  await act(async () => { retry.resolve({ documentId: document.id, folderId: folder.id, moved: true }) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(writes()).toBe(2)
})

it('clears a dismissed move failure and opens the next confirmation without stale feedback', async () => {
  const { first, form, confirm } = await mountMove()
  fireEvent.click(confirm)
  await act(async () => { first.reject(new Error('Connection lost')) })
  await form.findByRole('alert')
  fireEvent.click(form.getByRole('button', { name: zh.cancel }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeMoveDocument }))
  const dialog = screen.getByRole('dialog', { name: zh.knowledgeMoveDocument })
  expect(within(dialog).queryByRole('alert')).toBeNull()
})
