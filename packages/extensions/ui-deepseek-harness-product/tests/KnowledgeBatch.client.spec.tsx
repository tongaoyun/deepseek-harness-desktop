// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeBatchDialog, type KnowledgeBatchAction } from '../src/client/KnowledgeBatchDialog.tsx'
import type { KnowledgeDocument } from '../src/client/knowledge-data.ts'
import { KnowledgeWorkspace } from '../src/client/KnowledgeWorkspace.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const updatedAt = '2026-10-19T00:00:00Z'
const files = Array.from({ length: 3 }, (_, index) => ({
  id: `file-${index + 1}`, knowledgeBaseId: 'personal', filename: `资料${index + 1}.md`,
  folderId: null, mediaType: 'text/markdown', sizeBytes: 20, status: 'READY', chunkCount: 1, updatedAt, canManage: false,
}))
const folder = { id: 'folder', name: '项目文档', parentId: null, updatedAt }
const page = (values: readonly unknown[], total = values.length, number = 1) => ({ items: values, total, size: 20, page: number })
const props = { entries: items([{ id: 'personal', name: '个人库', scope: 'PERSONAL', canManage: true }]),
  loading: false, authRequired: false, authPending: false, authError: false, onRefresh: vi.fn(), onSignIn: vi.fn(),
  renderFactorySlot: () => null, t }
const dialogProps = { knowledgeBaseId: 'personal', documents: files, onBusyChange: vi.fn(),
  onAccepted: vi.fn<(document: KnowledgeDocument, action: KnowledgeBatchAction) => void>(), onAccessDenied: vi.fn(), onClose: vi.fn(), t }

function transport(handler: (method: string, payload: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: Record<string, unknown>, _requestId?: string) => {
    if (method === 'knowledge.documents.upload.pending') return { ok: true, result: [] }
    if (method === 'knowledge.folders.list') return { ok: true, result: page(payload.parentId === null ? [folder] : []) }
    if (method === 'knowledge.folders.get') return { ok: true, result: folder }
    return { ok: true, result: await handler(method, payload) }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel, writes: () => invoke.mock.calls.filter(call => ['knowledge.documents.move', 'knowledge.documents.delete', 'knowledge.documents.reindex'].includes(call[1])) }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('selects only manageable files on this page and clears selection on pagination, filtering, and navigation', async () => {
  const api = transport(async (_method, payload) => page(payload.page === 2 ? [{ ...files[0], id: 'next-file', filename: '第二页.md' }] : [
    ...files, { ...files[0], id: 'deleting', filename: '删除中.md', status: 'DELETING' },
  ], 26, Number(payload.page)))
  const { container } = render(<KnowledgeWorkspace {...props} />)
  const content = within(container.querySelector<HTMLElement>('[data-knowledge-content]')!)
  await content.findByRole('button', { name: files[0]!.filename })
  fireEvent.click(content.getByRole('checkbox', { name: t('knowledgeSelectPage') }))
  expect(content.getAllByRole<HTMLInputElement>('checkbox').filter(node => node.checked)).toHaveLength(4)
  expect(content.getByRole('checkbox', { name: zh.knowledgeSelectDocument.replace('{name}', '删除中.md') }).hasAttribute('disabled')).toBe(true)
  expect(content.getByText(zh.knowledgeSelectedCount.replace('{count}', '3'))).toBeDefined()
  fireEvent.click(content.getByRole('button', { name: zh.nextPage }))
  await content.findByRole('button', { name: '第二页.md' })
  expect(content.queryByRole('group', { name: zh.knowledgeBatchActions })).toBeNull()
  fireEvent.click(content.getByRole('checkbox', { name: t('knowledgeSelectPage') }))
  fireEvent.change(content.getByRole('combobox', { name: zh.status }), { target: { value: 'FAILED' } })
  await waitFor(() => { expect(content.queryByRole('group', { name: zh.knowledgeBatchActions })).toBeNull() })
  await content.findByRole('button', { name: files[0]!.filename })
  fireEvent.click(content.getByRole('checkbox', { name: t('knowledgeSelectPage') }))
  fireEvent.click(content.getByRole('tab', { name: zh.knowledgeAllMaterials }))
  await waitFor(() => { expect(content.queryByRole('group', { name: zh.knowledgeBatchActions })).toBeNull() })
  expect(api.writes()).toHaveLength(0)
  expect(api.invoke.mock.calls.some(call => call[1].startsWith('tasks.'))).toBe(false)
})

it('shows mixed selection and prevents reprocessing a selection that includes active files', async () => {
  transport(async () => page([files[0], { ...files[1], status: 'PROCESSING' }]))
  const { container } = render(<KnowledgeWorkspace {...props} />)
  const content = within(container.querySelector<HTMLElement>('[data-knowledge-content]')!)
  await content.findByRole('button', { name: files[0]!.filename })
  fireEvent.click(content.getByRole('checkbox', { name: zh.knowledgeSelectDocument.replace('{name}', files[0]!.filename) }))
  expect(content.getByRole<HTMLInputElement>('checkbox', { name: zh.knowledgeSelectPage }).indeterminate).toBe(true)
  fireEvent.click(content.getByRole('checkbox', { name: zh.knowledgeSelectPage }))
  expect(content.getByRole('button', { name: zh.knowledgeBatchReindex }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeClearSelection }))
  expect(content.getByRole<HTMLInputElement>('checkbox', { name: zh.knowledgeSelectPage }).checked).toBe(false)
})

it('keeps files unchanged before confirmation and refreshes the list after a submitted deletion', async () => {
  const deleted = new Set<string>()
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.documents.delete') { deleted.add(String(payload.documentId)); return { documentId: payload.documentId, taskId: `delete-${payload.documentId}`, status: 'DELETING' } }
    return page(files.filter(file => !deleted.has(file.id)))
  })
  const { container } = render(<KnowledgeWorkspace {...props} />)
  const content = within(container.querySelector<HTMLElement>('[data-knowledge-content]')!)
  await content.findByRole('button', { name: files[0]!.filename })
  fireEvent.click(content.getByRole('checkbox', { name: zh.knowledgeSelectPage }))
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeBatchDelete }))
  let dialog = within(screen.getByRole('dialog', { name: zh.knowledgeBatchDelete }))
  fireEvent.click(dialog.getByRole('button', { name: zh.cancel }))
  expect(api.writes()).toHaveLength(0)
  await content.findByRole('button', { name: files[0]!.filename })
  fireEvent.click(content.getByRole('checkbox', { name: zh.knowledgeSelectPage }))
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeBatchDelete }))
  dialog = within(screen.getByRole('dialog', { name: zh.knowledgeBatchDelete }))
  fireEvent.click(dialog.getByRole('button', { name: zh.deleteResource }))
  await dialog.findByText(zh.knowledgeBatchProgress.replace('{count}', '3').replace('{total}', '3'))
  fireEvent.click(dialog.getAllByRole('button', { name: zh.close }).at(-1)!)
  await waitFor(() => { expect(content.queryByRole('button', { name: files[0]!.filename })).toBeNull() })
  expect(content.queryByRole('group', { name: zh.knowledgeBatchActions })).toBeNull()
  expect(api.writes()).toHaveLength(3)
})

it('confirms deletion and retries only a lost receipt with the original write identity', async () => {
  let fail = true
  const api = transport(async (_method, payload) => {
    if (payload.documentId === 'file-2' && fail) throw new Error('Private transport failure')
    return { documentId: payload.documentId, taskId: `delete-${payload.documentId}`, status: 'DELETING' }
  })
  render(<KnowledgeBatchDialog {...dialogProps} action="delete" />)
  expect(api.writes()).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: zh.deleteResource }))
  await screen.findByRole('button', { name: zh.knowledgeBatchRetry })
  expect(api.writes().map(call => call[2].documentId)).toEqual(['file-1', 'file-2', 'file-3'])
  expect(screen.getByRole('alert').textContent).toBe(zh.knowledgeChangeFailed)
  expect(dialogProps.onAccepted.mock.calls.map(call => call[0].id)).toEqual(['file-1', 'file-3'])
  expect(screen.getByRole('list', { name: zh.knowledgeBatchFiles }).textContent).toMatchInlineSnapshot('"资料1.md已确认资料2.md操作未完成，请重试。资料3.md已确认"')
  fail = false
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeBatchRetry }))
  await screen.findByText(zh.knowledgeBatchProgress.replace('{count}', '3').replace('{total}', '3'))
  expect(api.writes().map(call => call[2].documentId)).toEqual(['file-1', 'file-2', 'file-3', 'file-2'])
  expect(api.writes()[1]![2]).toEqual(api.writes()[3]![2])
  expect(new Set(api.writes().map(call => call[2].operationId)).size).toBe(3)
  expect(dialogProps.onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getAllByRole('button', { name: zh.close }).at(-1)!)
  expect(dialogProps.onClose).toHaveBeenCalledOnce()
})

it('pins move versions and destination during a retry and skips files already in that folder', async () => {
  let fail = true
  const api = transport(async (_method, payload) => {
    if (fail) throw new Error('Response lost')
    return { documentId: payload.documentId, folderId: payload.folderId, moved: true }
  })
  render(<KnowledgeBatchDialog {...dialogProps} documents={[{ ...files[0]!, folderId: folder.id }, files[1]!]} action="move" />)
  fireEvent.click(await screen.findByRole('button', { name: folder.name }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.knowledgeMove }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeMove }))
  await screen.findByRole('button', { name: zh.knowledgeBatchRetry })
  expect(api.writes()).toHaveLength(1)
  expect(api.writes()[0]![2]).toMatchObject({ documentId: 'file-2', folderId: folder.id, expectedFolderId: null, expectedUpdatedAt: updatedAt })
  expect(screen.getByRole('group', { name: zh.knowledgeDestinationFolder }).hasAttribute('disabled')).toBe(true)
  fail = false
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeBatchRetry }))
  await screen.findByText(zh.knowledgeBatchProgress.replace('{count}', '2').replace('{total}', '2'))
  expect(api.writes()).toHaveLength(2)
  expect(api.writes()[0]![2]).toEqual(api.writes()[1]![2])
})

it('reports a terminal version conflict without offering to repeat the obsolete write', async () => {
  const api = transport(async () => { throw new ProductError('KNOWLEDGE_DOCUMENT_CONFLICT', 'Private diagnostics', false) })
  render(<KnowledgeBatchDialog {...dialogProps} documents={[{ ...files[0]!, folderId: folder.id }]} action="move" />)
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.knowledgeMove }).hasAttribute('disabled')).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeMove }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: zh.knowledgeBatchRetry })).toBeNull()
  expect(api.writes()).toHaveLength(1)
})

it('stops subsequent writes when current authorization is revoked', async () => {
  const api = transport(async () => { throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Private access response', false) })
  render(<KnowledgeBatchDialog {...dialogProps} action="delete" />)
  fireEvent.click(screen.getByRole('button', { name: zh.deleteResource }))
  await waitFor(() => { expect(dialogProps.onAccessDenied).toHaveBeenCalledOnce() })
  expect(api.writes()).toHaveLength(1)
  expect(dialogProps.onAccepted).not.toHaveBeenCalled()
})

it('stops after management permission is removed while preserving library reading', async () => {
  const api = transport(async () => { throw new ProductError('KNOWLEDGE_MANAGEMENT_FORBIDDEN', 'Private management response', false) })
  render(<KnowledgeBatchDialog {...dialogProps} action="delete" />)
  fireEvent.click(screen.getByRole('button', { name: zh.deleteResource }))
  await screen.findByText(zh.knowledgeBatchReviewHint)
  expect(api.writes()).toHaveLength(1)
  expect(screen.queryByRole('button', { name: zh.knowledgeBatchRetry })).toBeNull()
  expect(dialogProps.onAccessDenied).not.toHaveBeenCalled()
  expect(dialogProps.onAccepted).not.toHaveBeenCalled()
})

it('cancels in-flight work on unload and never starts the next file', async () => {
  let resolve: ((value: unknown) => void) | undefined
  const pending = new Promise((resolvePromise) => { resolve = resolvePromise })
  const api = transport(async () => pending)
  const { unmount } = render(<KnowledgeBatchDialog {...dialogProps} action="reindex" />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReindex }))
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeBatchSubmitting }))
  await waitFor(() => { expect(api.writes()).toHaveLength(1) })
  const id = api.writes()[0]![3]
  unmount()
  expect(api.cancel).toHaveBeenCalledWith('product', id)
  expect(dialogProps.onBusyChange).toHaveBeenLastCalledWith(false)
  await act(async () => { resolve!({ status: 'QUEUED' }); await pending })
  expect(api.writes()).toHaveLength(1)
  expect(dialogProps.onAccepted).not.toHaveBeenCalled()
})

it.each(['move', 'delete', 'reindex'] as const)('keeps an invalid %s receipt unconfirmed and retries the original file request', async (action) => {
  let valid = false
  const file = { ...files[0]!, folderId: action === 'move' ? folder.id : null }
  const receipt = action === 'move' ? { documentId: file.id, folderId: null, moved: true }
    : action === 'delete' ? { documentId: file.id, taskId: 'deletion-task', status: 'DELETING' } : file
  const api = transport(async () => valid ? receipt : null)
  render(<KnowledgeBatchDialog {...dialogProps} documents={[file]} action={action} />)
  const button = action === 'move' ? zh.knowledgeMove : action === 'delete' ? zh.deleteResource : zh.knowledgeReindex
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: button }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: button }))
  await screen.findByRole('alert')
  expect(dialogProps.onAccepted).not.toHaveBeenCalled()
  expect(screen.getByRole('list', { name: zh.knowledgeBatchFiles }).textContent).toMatchSnapshot()
  valid = true
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeBatchRetry }))
  await waitFor(() => { expect(dialogProps.onAccepted).toHaveBeenCalledOnce() })
  expect(api.writes()).toHaveLength(2)
  expect(api.writes()[0]![2]).toEqual(api.writes()[1]![2])
})
