// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeBatchDialog, type KnowledgeBatchAction } from '../src/client/KnowledgeBatchDialog.tsx'
import type { KnowledgeDocument } from '../src/client/knowledge-data.ts'
import { KnowledgeWorkspace } from '../src/client/KnowledgeWorkspace.tsx'
import { renderKnowledgeWorkspace } from './knowledge-workspace-fixture.client.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import { en, zh, NS, type DeepSeekHarnessProductKey } from '../src/locales.ts'

const localeContext = new Context()
const locale = new LocaleRuntime(localeContext)
locale.register(NS, { en, zh })
locale.setLocale('zh')

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const updatedAt = '2026-10-19T00:00:00Z'
const files = Array.from({ length: 3 }, (_, index) => ({
  id: `file-${index + 1}`, knowledgeBaseId: 'personal', filename: `资料${index + 1}.md`,
  folderId: null, mediaType: 'text/markdown', sizeBytes: 20, status: 'READY', chunkCount: 1, updatedAt, canManage: false,
}))
const folder = { id: 'folder', name: '项目文档', parentId: null, updatedAt }
const page = (values: readonly unknown[], total = values.length, number = 1) => ({ items: values, total, size: 20, page: number })
const props = { entries: items([{ id: 'personal', name: '个人库', scope: 'PERSONAL', canManage: true }]),
  loading: false, authRequired: false, onRefresh: vi.fn(), onSignIn: vi.fn(),
  renderFactorySlot: () => null, t }
const dialogProps = { knowledgeBaseId: 'personal', documents: files, onBusyChange: vi.fn(),
  onAccepted: vi.fn<(document: KnowledgeDocument, action: KnowledgeBatchAction) => void>(), onAccessDenied: vi.fn(), onClose: vi.fn(), t }

function transport(handler: (method: string, payload: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: Record<string, unknown>, _requestId?: string) => {
    if (method === 'knowledge.documents.upload.pending') return { ok: true, result: [] }
    if (method === 'knowledge.folders.list') {
      const all = payload.parentId === null ? [folder] : []
      const number = Number(payload.page)
      return { ok: true, result: page(all.slice((number - 1) * 20, number * 20), all.length, number) }
    }
    if (method === 'knowledge.folders.get') return { ok: true, result: folder }
    return { ok: true, result: await handler(method, payload) }
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel, writes: () => invoke.mock.calls.filter(call => ['knowledge.documents.move', 'knowledge.documents.delete', 'knowledge.documents.reindex'].includes(call[1])) }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); locale.setLocale('zh') })
afterAll(async () => { await localeContext.fiber.dispose() })

it.each((['move', 'delete', 'reindex'] as const).flatMap(action =>
  (['accepted', 'conflict'] as const).flatMap(outcome => [false, true].map(elsewhere => ({ action, outcome, elsewhere })))))(
  'recovers batch $action focus when $outcome removes its action (elsewhere=$elsewhere)', async ({ action, outcome, elsewhere }) => {
    const response = Promise.withResolvers<unknown>()
    const api = transport(async () => response.promise)
    const file = { ...files[0]!, folderId: action === 'move' ? folder.id : null }
    const view = render(<KnowledgeBatchDialog {...dialogProps} documents={[file]} action={action} />)
    onTestFinished(() => { view.unmount(); response.resolve(undefined) })
    const label = action === 'move' ? zh.knowledgeMove : action === 'delete' ? zh.deleteResource : zh.knowledgeReindex
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: label })
    await waitFor(() => { expect(submit.disabled).toBe(false) })
    submit.focus()
    act(() => { submit.click(); submit.click() })
    const headerClose = screen.getAllByRole<HTMLButtonElement>('button', { name: zh.close })[0]!
    if (elsewhere) headerClose.focus()
    await act(async () => {
      if (outcome === 'conflict') response.reject(new ProductError('KNOWLEDGE_DOCUMENT_CONFLICT', 'Version changed', false))
      else response.resolve(action === 'move' ? { documentId: files[0]!.id, folderId: null, moved: true }
        : action === 'delete' ? { documentId: files[0]!.id, status: 'DELETING', taskId: 'delete-task' } : { ...files[0], status: 'QUEUED' })
    })
    const footerClose = screen.getAllByRole<HTMLButtonElement>('button', { name: zh.close }).at(-1)!
    expect(submit.isConnected).toBe(false)
    expect(document.activeElement).toBe(elsewhere ? headerClose : footerClose)
    expect(api.writes()).toHaveLength(1)
    expect({ action, outcome, focus: elsewhere ? 'header-close' : 'footer-close',
      result: screen.getByRole('list', { name: zh.knowledgeBatchFiles }).textContent }).toMatchSnapshot()
  },
)

it.each(['delete', 'reindex'] as const)('retains the last %s action and its failure while retrying once', async (action) => {
  const first = Promise.withResolvers<unknown>()
  const retryResponse = Promise.withResolvers<unknown>()
  let attempts = 0
  const api = transport(async () => ++attempts === 1 ? first.promise : retryResponse.promise)
  const view = render(<KnowledgeBatchDialog {...dialogProps} documents={files.slice(0, 1)} action={action} />)
  onTestFinished(() => { view.unmount(); first.resolve(undefined); retryResponse.resolve(undefined) })
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: action === 'delete' ? zh.deleteResource : zh.knowledgeReindex })
  const cancel = screen.getByRole<HTMLButtonElement>('button', { name: zh.cancel })
  submit.focus()
  fireEvent.click(submit)
  expect(submit.isConnected).toBe(true)
  expect(document.activeElement).toBe(submit)
  expect(submit.disabled).toBe(false)
  expect(submit.getAttribute('aria-disabled')).toBe('true')
  expect(submit.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(cancel)
  expect(cancel.disabled).toBe(false)
  expect(cancel.getAttribute('aria-disabled')).toBe('true')
  expect(dialogProps.onClose).not.toHaveBeenCalled()
  await act(async () => { first.reject(new Error('Offline')) })
  const error = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeBatchRetry })
  expect(retry).toBe(submit)
  expect(document.activeElement).toBe(retry)
  act(() => { retry.click(); retry.click() })
  expect(attempts).toBe(2)
  expect(screen.getByRole('alert')).toBe(error)
  expect(retry.isConnected).toBe(true)
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect({ error: error.textContent, action: retry.textContent, busy: retry.getAttribute('aria-busy'),
    focused: document.activeElement === retry }).toMatchSnapshot()
  await act(async () => { retryResponse.resolve(action === 'delete' ? { documentId: files[0]!.id, status: 'DELETING', taskId: 'delete-task' }
    : { ...files[0], status: 'QUEUED' }) })
  await screen.findByText(zh.knowledgeBatchAccepted)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.writes()).toHaveLength(2)
  expect(api.writes()[1]?.[2]).toEqual(api.writes()[0]?.[2])
})

it('updates partial batch failures in the current language and retries only the unconfirmed file', async () => {
  const pending = Promise.withResolvers<unknown>()
  let fail = true
  const api = transport(async (_method, payload) => payload.documentId === 'file-2' && fail ? pending.promise
    : { ...files[0]!, id: payload.documentId, status: 'QUEUED' })
  const batchProps = { ...dialogProps, documents: files.slice(0, 2), t: locale.bind(NS) }
  const view = render(<KnowledgeBatchDialog {...batchProps} action="reindex" />)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReindex }))
  await waitFor(() => { expect(api.writes()).toHaveLength(2) })
  locale.setLocale('en')
  view.rerender(<KnowledgeBatchDialog {...batchProps} action="reindex" />)
  await act(async () => { pending.reject(new Error('Private transport details')) })
  expect((await screen.findByRole('alert')).textContent).toBe(en.knowledgeChangeFailed)
  locale.setLocale('zh')
  view.rerender(<KnowledgeBatchDialog {...batchProps} action="reindex" />)
  expect(screen.getByRole('alert').textContent).toBe(zh.knowledgeChangeFailed)
  expect(screen.getByRole('list', { name: zh.knowledgeBatchFiles }).textContent).toMatchInlineSnapshot('"资料1.md已确认资料2.md操作未完成，请重试。"')
  expect(api.cancel).not.toHaveBeenCalled()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeBatchRetry }))
  await screen.findByText(zh.knowledgeBatchProgress.replace('{count}', '2').replace('{total}', '2'))
  expect(api.writes()).toHaveLength(3)
  expect(api.writes()[2]![2]).toEqual(api.writes()[1]![2])
  expect(dialogProps.onAccepted.mock.calls.map(call => call[0].id)).toEqual(['file-1', 'file-2'])
})

it('selects only manageable files on this page and clears selection on pagination, filtering, and navigation', async () => {
  const api = transport(async (_method, payload) => page(payload.page === 2 ? [{ ...files[0], id: 'next-file', filename: '第二页.md' }] : [
    ...files, { ...files[0], id: 'deleting', filename: '删除中.md', status: 'DELETING' },
  ], 26, Number(payload.page)))
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
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
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const content = within(container.querySelector<HTMLElement>('[data-knowledge-content]')!)
  await content.findByRole('button', { name: files[0]!.filename })
  fireEvent.click(content.getByRole('checkbox', { name: zh.knowledgeSelectDocument.replace('{name}', files[0]!.filename) }))
  expect(content.getByRole<HTMLInputElement>('checkbox', { name: zh.knowledgeSelectPage }).indeterminate).toBe(true)
  fireEvent.click(content.getByRole('checkbox', { name: zh.knowledgeSelectPage }))
  expect(content.getByRole('button', { name: zh.knowledgeBatchReindex }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeClearSelection }))
  expect(content.getByRole<HTMLInputElement>('checkbox', { name: zh.knowledgeSelectPage }).checked).toBe(false)
})

it.each((['move', 'delete', 'reindex'] as const).flatMap(action => (['cancel', 'close', 'escape'] as const).map(dismiss => ({ action, dismiss }))))(
  'preserves selection and focus without refreshing after $dismiss of an unsubmitted $action batch', async ({ action, dismiss }) => {
    const api = transport(async () => page(files))
    const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
    const content = within(container.querySelector<HTMLElement>('[data-knowledge-content]')!)
    await content.findByRole('button', { name: files[0]!.filename })
    const selection = content.getByRole<HTMLInputElement>('checkbox', { name: zh.knowledgeSelectPage })
    fireEvent.click(selection)
    const label = t(action === 'move' ? 'knowledgeBatchMove' : action === 'delete' ? 'knowledgeBatchDelete' : 'knowledgeBatchReindex')
    const trigger = content.getByRole<HTMLButtonElement>('button', { name: label })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: label })
    const reads = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list').length
    if (dismiss === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' })
    else fireEvent.click(within(dialog).getByRole('button', { name: t(dismiss) }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(selection.checked).toBe(true)
    expect(content.getByRole('button', { name: label })).toBe(trigger)
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list')).toHaveLength(reads)
    expect(api.writes()).toHaveLength(0)
    expect({ action, dismiss, selected: selection.checked, focusedAction: document.activeElement?.textContent }).toMatchSnapshot()
  },
)

it('keeps files unchanged before confirmation and refreshes the list after a submitted deletion', async () => {
  const deleted = new Set<string>()
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.documents.delete') { deleted.add(String(payload.documentId)); return { documentId: payload.documentId, taskId: `delete-${payload.documentId}`, status: 'DELETING' } }
    return page(files.filter(file => !deleted.has(file.id)))
  })
  const { container } = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
  const content = within(container.querySelector<HTMLElement>('[data-knowledge-content]')!)
  await content.findByRole('button', { name: files[0]!.filename })
  fireEvent.click(content.getByRole('checkbox', { name: zh.knowledgeSelectPage }))
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeBatchDelete }))
  let dialog = within(screen.getByRole('dialog', { name: zh.knowledgeBatchDelete }))
  fireEvent.click(dialog.getByRole('button', { name: zh.cancel }))
  expect(api.writes()).toHaveLength(0)
  await content.findByRole('button', { name: files[0]!.filename })
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeBatchDelete }))
  dialog = within(screen.getByRole('dialog', { name: zh.knowledgeBatchDelete }))
  fireEvent.click(dialog.getByRole('button', { name: zh.deleteResource }))
  await dialog.findByText(zh.knowledgeBatchProgress.replace('{count}', '3').replace('{total}', '3'))
  fireEvent.click(dialog.getAllByRole('button', { name: zh.close }).at(-1)!)
  await waitFor(() => { expect(content.queryByRole('button', { name: files[0]!.filename })).toBeNull() })
  expect(content.queryByRole('group', { name: zh.knowledgeBatchActions })).toBeNull()
  expect(api.writes()).toHaveLength(3)
})

it.each([
  ...(['move', 'delete', 'reindex'] as const).flatMap(action => [false, true].map(elsewhere => ({ action, elsewhere, backdrop: false }))),
  { action: 'delete' as const, elsewhere: false, backdrop: true },
])(
  'returns from a completed $action batch without losing browsing focus (elsewhere=$elsewhere, backdrop=$backdrop)', async ({ action, elsewhere, backdrop }) => {
    const response = Promise.withResolvers<undefined>()
    const refreshed = Promise.withResolvers<undefined>()
    let submitted = false
    const api = transport(async (method, payload) => {
      if (method === 'knowledge.documents.list') {
        if (submitted) await refreshed.promise
        return page(submitted && action !== 'reindex' ? [] : files.slice(0, 1))
      }
      await response.promise
      submitted = true
      return action === 'move' ? { documentId: payload.documentId, folderId: payload.folderId, moved: true }
        : action === 'delete' ? { documentId: payload.documentId, taskId: 'delete-task', status: 'DELETING' }
          : { ...files[0], status: 'QUEUED' }
    })
    const view = renderKnowledgeWorkspace(<KnowledgeWorkspace {...props} />)
    onTestFinished(() => { view.unmount(); response.resolve(undefined); refreshed.resolve(undefined) })
    const content = within(view.container.querySelector<HTMLElement>('[data-knowledge-content]')!)
    await content.findByRole('button', { name: files[0]!.filename })
    const search = content.getByRole<HTMLInputElement>('searchbox', { name: zh.knowledgeFindFiles })
    fireEvent.change(search, { target: { value: '未提交的草稿' } })
    fireEvent.click(content.getByRole('checkbox', { name: zh.knowledgeSelectPage }))
    const label = t(action === 'move' ? 'knowledgeBatchMove' : action === 'delete' ? 'knowledgeBatchDelete' : 'knowledgeBatchReindex')
    const trigger = content.getByRole<HTMLButtonElement>('button', { name: label })
    trigger.focus(); fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: label })
    const form = within(dialog)
    if (action === 'move') fireEvent.click(await form.findByRole('button', { name: folder.name }))
    const confirm = form.getByRole<HTMLButtonElement>('button', {
      name: t(action === 'move' ? 'knowledgeMove' : action === 'delete' ? 'deleteResource' : 'knowledgeReindex'),
    })
    await waitFor(() => { expect(confirm.disabled).toBe(false) })
    confirm.focus(); act(() => { confirm.click(); confirm.click() })
    await act(async () => { response.resolve(undefined) })
    const close = form.getAllByRole<HTMLButtonElement>('button', { name: zh.close }).at(-1)!
    if (elsewhere) {
      search.focus(); search.setSelectionRange(1, 3)
      fireEvent.keyDown(search, { key: 'Escape' })
    } else if (backdrop) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      expect(document.activeElement).toBe(document.body)
      fireEvent.click(dialog.parentElement!.querySelector<HTMLElement>('[aria-hidden="true"]')!)
    } else { close.focus(); fireEvent.click(close) }
    expect(screen.queryByRole('dialog')).toBeNull()
    const heading = content.getByRole('heading', { name: '个人库', level: 1 })
    expect(document.activeElement).toBe(elsewhere ? search : heading)
    await act(async () => { refreshed.resolve(undefined) })
    expect(document.activeElement).toBe(elsewhere ? search : heading)
    expect(content.getByRole('searchbox', { name: zh.knowledgeFindFiles })).toBe(search)
    expect(search.value).toBe('未提交的草稿')
    if (elsewhere) expect([search.selectionStart, search.selectionEnd]).toEqual([1, 3])
    expect(content.queryByRole('group', { name: zh.knowledgeBatchActions })).toBeNull()
    expect(api.writes()).toHaveLength(1)
  },
)

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

it.each(['network', 'invalid-receipt'] as const)('retains the confirmed batch destination after same-batch clicks and %s failure', async (outcome) => {
  const first = Promise.withResolvers<unknown>()
  const retryResponse = Promise.withResolvers<unknown>()
  let attempts = 0
  const api = transport(async () => ++attempts === 1 ? first.promise : retryResponse.promise)
  const view = render(<KnowledgeBatchDialog {...dialogProps} documents={files.slice(0, 1)} action="move" />)
  onTestFinished(() => { view.unmount(); first.resolve(undefined); retryResponse.resolve(undefined) })
  fireEvent.click(await screen.findByRole('button', { name: folder.name }))
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeMove })
  await waitFor(() => { expect(submit.disabled).toBe(false) })
  const root = screen.getByRole('button', { name: zh.knowledgeRootFolder })
  const cancel = screen.getByRole('button', { name: zh.cancel })
  submit.focus()
  act(() => { submit.click(); submit.click(); fireEvent.click(root); fireEvent.click(cancel) })
  expect(document.activeElement).toBe(submit)
  expect(submit.disabled).toBe(false)
  expect(submit.getAttribute('aria-disabled')).toBe('true')
  expect(api.writes()).toHaveLength(1)
  expect(dialogProps.onClose).not.toHaveBeenCalled()
  await act(async () => {
    if (outcome === 'network') first.reject(new Error('Response lost'))
    else first.resolve({ documentId: files[0]!.id, folderId: null, moved: true })
  })
  const error = await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: folder.name }).getAttribute('aria-current')).toBe('page')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeBatchRetry })
  await waitFor(() => { expect(retry.disabled).toBe(false) })
  act(() => { retry.click(); retry.click(); fireEvent.click(root) })
  expect(screen.getByRole('alert')).toBe(error)
  expect(retry).toBe(submit)
  expect(document.activeElement).toBe(retry)
  expect(api.writes()).toHaveLength(2)
  expect(api.writes()[1]![2]).toEqual(api.writes()[0]![2])
  expect({ outcome, error: error.textContent, action: retry.textContent, focused: document.activeElement === retry,
    destination: screen.getByRole('button', { name: folder.name }).getAttribute('aria-current') }).toMatchSnapshot()
  await act(async () => { retryResponse.resolve({ documentId: files[0]!.id, folderId: folder.id, moved: true }) })
  await screen.findByText(zh.knowledgeBatchProgress.replace('{count}', '1').replace('{total}', '1'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.writes()).toHaveLength(2)
  expect(dialogProps.onAccepted).toHaveBeenCalledOnce()
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
