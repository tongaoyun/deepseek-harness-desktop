// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { LibraryEntry } from '@deepseek-harness/product/library'
import { ProductError } from '@deepseek-harness/product/errors'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LibraryBrowser } from '../src/client/LibraryBrowser.tsx'
import { LibraryFilePicker } from '../src/client/LibraryFilePicker.tsx'
import { LibraryPreview } from '../src/client/LibraryPreview.tsx'
import { LibraryMutation } from '../src/client/LibraryMutation.tsx'
import { TaskLibraryInput } from '../src/client/TaskLibraryInput.tsx'
import { zh } from '../src/locales.ts'
const library = { id: '11111111-1111-4111-8111-111111111111', name: '项目资料', scope: 'TEAM' as const,
  ownerId: 'employee', companyId: 'company', role: 'OWNER' as const, canManage: true, version: 1, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' }
const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null, name: '中文资料.md', kind: 'FILE' as const,
  sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, version: 1, createdAt: library.createdAt, updatedAt: library.updatedAt }
const t = makeTranslate(zh, commonZh)
const renderFactorySlot = (() => null)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture() {
  const read = vi.fn(async (method: string, _payload?: unknown): Promise<unknown> => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'library.get') return library
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.list') return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.entries.list') return { data: [file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    return true
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke: async (_namespace: string, method: string, payload?: unknown) => ({ ok: true, result: await read(method, payload) }), cancel: vi.fn(), subscribe: () => () => {} } })
  return read
}
it.each(['rename', 'editLibrary', 'delete', 'deleteLibrary'] as const)('recovers a conflicting %s with an explicit read before another write, retaining its draft and controls', async (kind) => {
  const read = fixture(), committed = vi.fn()
  const entryMutation = kind === 'rename' || kind === 'delete'
  const method = kind === 'rename' ? 'library.entries.update' : kind === 'editLibrary' ? 'library.update'
    : kind === 'delete' ? 'library.entries.delete' : 'library.delete'
  const recovery = Promise.withResolvers<unknown>()
  let failRead = true, writes = 0
  read.mockImplementation(async (operation) => {
    if (operation === method) {
      if (++writes === 1) throw new ProductError('LIBRARY_CONFLICT', 'Changed elsewhere', true)
      return entryMutation ? { ...file, version: 4 } : { ...library, version: 4 }
    }
    if (operation === 'library.get') {
      if (failRead) throw new Error('Metadata read unavailable')
      return entryMutation ? library : recovery.promise
    }
    if (operation === 'library.entries.get') return recovery.promise
    throw new Error(`Unexpected conflict method: ${operation}`)
  })
  render(<LibraryMutation kind={kind} {...(entryMutation ? { entry: file } : { location: { library, parentId: null } })}
    t={t} onClose={vi.fn()} onCommitted={committed} />)
  const draft = kind === 'rename' || kind === 'editLibrary' ? screen.getByRole<HTMLInputElement>('textbox') : undefined
  if (draft) { fireEvent.change(draft, { target: { value: '我保留的草稿' } }); draft.setSelectionRange(1, 4) }
  const save = screen.getByRole('button', { name: kind === 'delete' || kind === 'deleteLibrary' ? zh.deleteResource : zh.saveResource })
  save.focus(); fireEvent.click(save)
  const alert = await screen.findByRole('alert')
  const reread = screen.getByRole('button', { name: zh.libraryReread })
  fireEvent.click(save)
  expect(writes).toBe(1)
  reread.focus(); fireEvent.click(reread)
  expect({ readBusy: reread.getAttribute('aria-busy'), saveBusy: save.getAttribute('aria-busy'),
    saveLocked: save.getAttribute('aria-disabled') }).toMatchInlineSnapshot(`
    {
      "readBusy": "true",
      "saveBusy": "false",
      "saveLocked": "true",
    }
  `)
  await waitFor(() => { expect(alert.textContent).toBe(zh.libraryLoadFailed) })
  expect(document.activeElement).toBe(reread)
  failRead = false; fireEvent.click(reread); fireEvent.click(reread)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: zh.libraryReread })).toBe(reread)
  expect(document.activeElement).toBe(reread)
  expect(reread.getAttribute('aria-busy')).toBe('true')
  expect(save.getAttribute('aria-busy')).toBe('false')
  expect(writes).toBe(1)
  const parentId = '33333333-3333-4333-8333-333333333333'
  await act(async () => { recovery.resolve(entryMutation ? { ...file, name: '其他人修改的名称.md', parentId, version: 3 } : { ...library, version: 3 }) })
  if (draft) {
    expect(screen.getByRole('textbox')).toBe(draft)
    expect(draft.value).toBe('我保留的草稿')
    expect([draft.selectionStart, draft.selectionEnd]).toEqual([1, 4])
    expect(document.activeElement).toBe(draft)
  } else expect(document.activeElement).toBe(save)
  expect(screen.getByRole('button', { name: save.textContent })).toBe(save)
  fireEvent.click(save)
  await waitFor(() => { expect(committed).toHaveBeenCalledOnce() })
  expect(read.mock.calls.filter(([operation]) => operation === method).at(-1)?.[1]).toMatchObject({ version: 3,
    ...(kind === 'rename' ? { parentId, name: '我保留的草稿' } : kind === 'editLibrary' ? { name: '我保留的草稿' } : {}) })
  expect(writes).toBe(2)
})
it('blocks conflicting writes when management permission is revoked during revalidation', async () => {
  const read = fixture(), committed = vi.fn()
  read.mockImplementation(async (method) => {
    if (method === 'library.entries.update') throw new ProductError('LIBRARY_CONFLICT', 'Changed elsewhere', true)
    if (method === 'library.get') return { ...library, role: 'VIEWER', canManage: false }
    throw new Error(`Unexpected revoked operation: ${method}`)
  })
  render(<LibraryMutation kind="rename" entry={file} t={t} onClose={vi.fn()} onCommitted={committed} />)
  const draft = screen.getByRole<HTMLInputElement>('textbox')
  fireEvent.change(draft, { target: { value: '权限撤销时保留草稿' } })
  const save = screen.getByRole('button', { name: zh.saveResource })
  fireEvent.click(save)
  fireEvent.click(await screen.findByRole('button', { name: zh.libraryReread }))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('LIBRARY_MANAGEMENT_FORBIDDEN') })
  fireEvent.click(save)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.update')).toHaveLength(1)
  expect(read.mock.calls.some(([method]) => method === 'library.entries.get')).toBe(false)
  expect(screen.getByRole('textbox')).toBe(draft)
  expect(draft.value).toBe('权限撤销时保留草稿')
  expect(committed).not.toHaveBeenCalled()
})
it('keeps directory picker loading static and retains retry focus through recovery', async () => {
  const read = fixture(), loading = Promise.withResolvers<unknown>()
  const original = read.getMockImplementation()!
  let listing = loading.promise
  read.mockImplementation((method, payload) => method === 'library.entries.list' ? listing : original(method, payload))
  render(<LibraryBrowser t={t} rootLibrary={library} renderFactorySlot={renderFactorySlot} />)
  const search = screen.getByRole('searchbox')
  expect(screen.getByRole('status', { name: zh.loading }).querySelector('svg')).toBeNull()
  expect(screen.queryByText(zh.libraryEmpty)).toBeNull()
  await act(async () => { loading.reject(new Error('offline')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const recovery = Promise.withResolvers<unknown>()
  listing = recovery.promise
  retry.focus(); fireEvent.click(retry)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(document.activeElement).toBe(retry)
  await act(async () => { recovery.resolve({ data: [file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }) })
  await screen.findByRole('button', { name: /中文资料.md/ })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
})
it.each([
  ['libraries', 'error'], ['libraries', 'search'], ['files', 'error'], ['files', 'search'],
] as const)('retains %s rows, selection and valid %s focus through failure and retry', async (source, focus) => {
  const read = fixture()
  render(<LibraryBrowser t={t} {...(source === 'files' ? { rootLibrary: library } : {})} renderFactorySlot={renderFactorySlot} />)
  const title = source === 'files' ? /中文资料.md/ : /项目资料/
  const entry = await screen.findByRole('button', { name: title })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const refresh = screen.getByRole('button', { name: zh.refresh })
  fireEvent.change(search, { target: { value: '资料' } })
  await waitFor(() => { expect(refresh.getAttribute('aria-busy')).toBe('false') })
  const readMethod = source === 'files' ? 'library.entries.list' : 'library.list'
  const original = read.getMockImplementation()!
  let result = Promise.withResolvers<unknown>()
  read.mockImplementation((method, payload) => method === readMethod ? result.promise : original(method, payload))
  refresh.focus(); fireEvent.click(refresh)
  expect(screen.getByRole('button', { name: title })).toBe(entry)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(refresh)
  await act(async () => { result.reject(new Error('offline')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const region = screen.getByRole('region', { name: zh.libraryLoadFailed })
  expect({ role: region.getAttribute('role'), tabIndex: region.tabIndex, message: alert.textContent }).toMatchInlineSnapshot(`
    {
      "message": "资料库暂时无法加载，请重试。",
      "role": "region",
      "tabIndex": 0,
    }
  `)
  result = Promise.withResolvers<unknown>()
  const beforeRetry = read.mock.calls.filter(([method]) => method === readMethod).length
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(read.mock.calls.filter(([method]) => method === readMethod)).toHaveLength(beforeRetry + 1)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  await act(async () => { result.reject(new Error('still offline')) })
  expect(screen.getByRole('region', { name: zh.libraryLoadFailed })).toBe(region)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(document.activeElement).toBe(retry)
  result = Promise.withResolvers<unknown>()
  fireEvent.click(retry)
  search.setSelectionRange(0, 1)
  if (focus === 'error') region.focus()
  else search.focus()
  await act(async () => { result.resolve({ data: [source === 'files' ? file : library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('button', { name: title })).toBe(entry)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
  expect(search.value).toBe('资料')
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
})
it('retains the same draft node, text selection and contents after declining discard', async () => {
  fixture()
  const close = vi.fn(), committed = vi.fn()
  render(<LibraryMutation kind="editLibrary" location={{ library, parentId: null }} t={t} onClose={close} onCommitted={committed} />)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  fireEvent.change(input, { target: { value: '保留的资料名称' } }); input.focus(); input.setSelectionRange(2,5)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.getByText(zh.libraryDiscardConfirm)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: zh.libraryKeepEditing }))
  expect(screen.getByRole('textbox', { name: zh.libraryName })).toBe(input)
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart,input.selectionEnd]).toEqual([2,5])
  expect(input.value).toBe('保留的资料名称')
  expect(close).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled()
})
it.each(['folder'] as const)('reuses the %s creation receipt when only surrounding name whitespace changes', async (kind) => {
  const read = fixture(), retried = Promise.withResolvers<unknown>()
  const committed = vi.fn()
  render(<LibraryMutation kind={kind} location={{ library, parentId: null }} t={t} onClose={vi.fn()} onCommitted={committed} />)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  const save = screen.getByRole('button', { name: zh.saveResource })
  fireEvent.change(input, { target: { value: '  新建资料  ' } })
  read.mockRejectedValueOnce(new Error('receipt unavailable'))
  fireEvent.click(save)
  const error = await screen.findByRole('alert')
  const first = read.mock.calls[0]![1] as { name: string; key: string }
  expect(first.name).toBe('新建资料')
  fireEvent.change(input, { target: { value: '新建资料' } })
  input.focus(); input.setSelectionRange(1, 3)
  read.mockImplementationOnce(() => retried.promise)
  fireEvent.click(save); fireEvent.click(save)
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[1]).toEqual(read.mock.calls[0])
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('textbox', { name: zh.libraryName })).toBe(input)
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3])
  await act(async () => { retried.reject(new Error('receipt still unavailable')) })
  fireEvent.change(input, { target: { value: '另一份资料' } })
  fireEvent.click(save)
  await waitFor(() => { expect(committed).toHaveBeenCalledOnce() })
  const changed = read.mock.calls[2]![1] as { name: string; key: string }
  expect(changed.name).toBe('另一份资料')
  expect(changed.key).not.toBe(first.key)
})
it('clears the close-blocked notice after a failed save while retaining the draft and selection', async () => {
  const read = fixture(), saving = Promise.withResolvers<unknown>()
  const closed = vi.fn(), committed = vi.fn()
  render(<LibraryMutation kind="rename" entry={file} t={t} onClose={closed} onCommitted={committed} />)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  const save = screen.getByRole('button', { name: zh.saveResource })
  fireEvent.change(input, { target: { value: '保留的资料.md' } })
  input.focus(); input.setSelectionRange(1, 4)
  read.mockImplementationOnce(() => saving.promise)
  fireEvent.click(save)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.getByRole('status').textContent).toBe(zh.libraryWait)
  expect(closed).not.toHaveBeenCalled()
  await act(async () => { saving.reject(new Error('save offline')) })
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain(zh.saveFailed)
  expect(screen.getByRole('textbox', { name: zh.libraryName })).toBe(input)
  expect(screen.getByRole('button', { name: zh.saveResource })).toBe(save)
  expect(input.readOnly).toBe(false)
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4])
  fireEvent.keyDown(input, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryKeepEditing }))
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4])
  fireEvent.click(save); fireEvent.click(save)
  await waitFor(() => { expect(committed).toHaveBeenCalledOnce() })
  expect(read).toHaveBeenCalledTimes(2)
})
it('cancels an unchanged move picker directly, including entries below the root', async () => {
  fixture()
  const close = vi.fn()
  render(<LibraryMutation kind="move" location={{ library, parentId: '33333333-3333-4333-8333-333333333333' }}
    entry={{ ...file, parentId: '33333333-3333-4333-8333-333333333333' }} t={t} onClose={close} onCommitted={vi.fn()} />)
  await waitFor(() => { expect(screen.getByRole('region', { name: zh.library }).querySelector('[aria-busy="true"]')).toBeNull() })
  fireEvent.keyDown(screen.getByRole('button', { name: zh.cancel }), { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  expect(screen.queryByText(zh.libraryDiscardConfirm)).toBeNull()
})
it('refuses moves to the unchanged parent or to the folder itself without sending a write', async () => {
  const read = fixture()
  const folder = { ...file, kind: 'FOLDER' as const, sha256: null, mediaType: null, sizeBytes: 0 }
  const original = read.getMockImplementation()!
  read.mockImplementation((method, payload) => method === 'library.entries.list'
    ? Promise.resolve({ data: [folder], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 })
    : original(method, payload))
  render(<LibraryMutation kind="move" location={{ library, parentId: null }} entry={folder} t={t} onClose={vi.fn()} onCommitted={vi.fn()} />)
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  const save = screen.getByRole('button', { name: zh.saveResource })
  expect(save.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(save)
  fireEvent.click(row)
  await waitFor(() => { expect(screen.getByRole('region', { name: zh.library }).querySelector('[aria-busy="true"]')).toBeNull() })
  expect(save.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(save)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.update')).toHaveLength(0)
})
it('keeps the move target, search and error nodes stable while a failed move is retried', async () => {
  const read = fixture(), gate = Promise.withResolvers<unknown>()
  const folder = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '目标目录', kind: 'FOLDER' as const,
    sha256: null, mediaType: null, sizeBytes: 0 }
  const child = { ...folder, id: '44444444-4444-4444-8444-444444444444', parentId: folder.id, name: '子目录' }
  const original = read.getMockImplementation()!
  let writes = 0
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.entries.list') return { data: (payload as { parentId: string | null }).parentId === null ? [folder] : [child],
      pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.entries.update') {
      if (++writes === 1) throw new Error('move offline')
      return gate.promise
    }
    return original(method, payload)
  })
  const close = vi.fn(), committed = vi.fn()
  render(<LibraryMutation kind="move" location={{ library, parentId: null }} entry={file} t={t} onClose={close} onCommitted={committed} />)
  fireEvent.click(await screen.findByRole('button', { name: /目标目录/ }))
  const row = await screen.findByRole('button', { name: /子目录/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox'), save = screen.getByRole('button', { name: zh.saveResource })
  save.focus(); fireEvent.click(save)
  const error = await screen.findByRole('alert')
  fireEvent.click(save); fireEvent.click(save)
  const reads = read.mock.calls.filter(([method]) => method === 'library.entries.list').length
  expect(search.readOnly).toBe(true)
  fireEvent.change(search, { target: { value: '忽略的搜索' } })
  fireEvent.click(row)
  fireEvent.click(screen.getByRole('button', { name: library.name }))
  expect(screen.queryByRole('button', { name: zh.refresh })).toBeNull()
  fireEvent.keyDown(save, { key: 'Escape' })
  expect(writes).toBe(2)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.list')).toHaveLength(reads)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('')
  expect(screen.getByRole('button', { name: /子目录/ })).toBe(row)
  expect(screen.getByRole('alert')).toBe(error)
  expect(document.activeElement).toBe(save)
  expect(close).not.toHaveBeenCalled()
  await act(async () => { gate.resolve(true) })
  expect(committed).toHaveBeenCalledOnce()
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.update').map(([, payload]) => payload)).toEqual(
    Array(2).fill({ libraryId: library.id, entryId: file.id, name: file.name, parentId: folder.id, version: file.version }))
})
it.each(['rename', 'delete'] as const)('retains %s controls and failure feedback while retrying a locked write', async (kind) => {
  const read = fixture(), retried = Promise.withResolvers<unknown>()
  const closed = vi.fn(), committed = vi.fn()
  render(<LibraryMutation kind={kind} entry={file} t={t} onClose={closed} onCommitted={committed} />)
  const button = screen.getByRole('button', { name: kind === 'delete' ? zh.deleteResource : zh.saveResource })
  const input = kind === 'rename' ? screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName }) : undefined
  if (input) fireEvent.change(input, { target: { value: '保留的名称.md' } })
  read.mockRejectedValueOnce(new Error('write offline'))
  button.focus(); fireEvent.click(button)
  const error = await screen.findByRole('alert')
  expect(error.getAttribute('tabindex')).toBe('0')
  expect(document.activeElement).toBe(button)
  read.mockImplementationOnce(() => retried.promise)
  fireEvent.click(button); fireEvent.click(button)
  fireEvent.keyDown(button, { key: 'Escape' })
  expect(screen.getByRole('status').textContent).toBe(zh.libraryWait)
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('button', { name: button.textContent })).toBe(button)
  expect(document.activeElement).toBe(button)
  expect(read).toHaveBeenCalledTimes(2)
  expect(closed).not.toHaveBeenCalled()
  if (input) {
    expect(screen.getByRole('textbox', { name: zh.libraryName })).toBe(input)
    expect(input.value).toBe('保留的名称.md')
  }
  await act(async () => { retried.resolve(true) })
  expect(committed).toHaveBeenCalledOnce()
})
it.each([
  { kind: 'preview', result: 'removed' }, { kind: 'rename', result: 'removed' }, { kind: 'move', result: 'removed' },
  { kind: 'delete', result: 'removed' }, { kind: 'editLibrary', result: 'removed' }, { kind: 'deleteLibrary', result: 'removed' },
  { kind: 'rename', result: 'retained' }, { kind: 'rename', result: 'focusedElsewhere' }, { kind: 'delete', result: 'saved' },
] as const)(
  'preserves focus when closing $kind after background refresh; opener=$result', async ({ kind, result }) => {
    const read = fixture(), refreshed = Promise.withResolvers<unknown>()
    const directory = kind === 'editLibrary' || kind === 'deleteLibrary'
    const original = read.getMockImplementation()!
    let refreshing = false
    read.mockImplementation(async (method, payload) => {
      if (refreshing && method === (directory ? 'library.list' : 'library.entries.list')) return refreshed.promise
      return original(method, payload)
    })
    render(<LibraryBrowser {...(directory ? {} : { rootLibrary: library })} t={t} renderFactorySlot={renderFactorySlot} />)
    const row = await screen.findByRole('button', { name: directory ? /项目资料/ : /中文资料.md/ })
    const refresh = screen.getByRole('button', { name: zh.refresh })
    await waitFor(() => { expect(refresh.getAttribute('aria-busy')).toBe('false') })
    refreshing = true
    fireEvent.click(refresh)
    const trigger = kind === 'preview' ? row : within(row.closest('article')!).getByRole('button', { name:
      kind === 'rename' ? zh.libraryRename : kind === 'move' ? zh.libraryMove : kind === 'editLibrary' ? zh.libraryEdit : zh.deleteResource })
    trigger.focus(); fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog'), close = within(dialog).getByLabelText(zh.close, { selector: 'button' })
    close.focus()
    const data = result === 'retained' ? [directory ? library : file] : []
    await act(async () => { refreshed.resolve({ data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length }) })
    expect(trigger.isConnected).toBe(result === 'retained')
    expect(document.activeElement).toBe(close)
    const elsewhere = result === 'focusedElsewhere' ? screen.getByRole('button', { name: zh.library }) : undefined
    elsewhere?.focus()
    if (result === 'saved') {
      const save = within(dialog).getByRole('button', { name: zh.deleteResource })
      save.focus(); fireEvent.click(save)
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      expect(read.mock.calls.filter(([method]) => method === 'library.entries.delete')).toHaveLength(1)
    } else fireEvent.keyDown(close, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(result === 'retained' ? trigger
      : result === 'focusedElsewhere' ? elsewhere : screen.getByRole('searchbox'))
  },
)
it('preserves the library search when returning from files to the directory', async () => {
  fixture()
  render(<LibraryBrowser t={t} renderFactorySlot={renderFactorySlot} />)
  const entry = await screen.findByRole('button', { name: /项目资料/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '项目' } })
  fireEvent.click(entry)
  await screen.findByRole('button', { name: /中文资料.md/ })
  expect(search.value).toBe('')
  fireEvent.click(screen.getByRole('button', { name: zh.library }))
  await screen.findByRole('button', { name: /项目资料/ })
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('项目')
})
it('keeps current root and folder rows mounted when their breadcrumb is clicked again', async () => {
  const read = fixture()
  const folder = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '参考资料', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.get') return library
    if (method === 'library.entries.list') {
      const parentId = (payload as { parentId: string | null }).parentId
      return { data: parentId ? [{ ...file, parentId }] : [folder], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  const folderButton = await screen.findByRole('button', { name: /参考资料/ })
  const search = screen.getByRole('searchbox')
  const currentRoot = screen.getByRole('button', { name: library.name })
  currentRoot.focus(); fireEvent.click(currentRoot)
  expect(screen.getByRole('button', { name: /参考资料/ })).toBe(folderButton)
  fireEvent.click(screen.getByRole('button', { name: zh.library }))
  expect(screen.getByRole('button', { name: /参考资料/ })).toBe(folderButton)
  fireEvent.click(folderButton)
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  const breadcrumb = screen.getByRole('button', { name: folder.name })
  breadcrumb.focus(); fireEvent.click(breadcrumb)
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(breadcrumb)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.list')).toHaveLength(2)
})
it('rebuilds the actual ancestry when opening a folder from global search results', async () => {
  const read = fixture(), ancestry = Promise.withResolvers<unknown>()
  let attempts = 0
  const parent = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '真实父目录', kind: 'FOLDER' as const,
    sha256: null, mediaType: null, sizeBytes: 0 }
  const nested = { ...parent, id: '44444444-4444-4444-8444-444444444444', parentId: parent.id, name: '搜索命中目录' }
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.get') return library
    if (method === 'library.entries.get') {
      if (++attempts === 1) throw new Error('ancestry offline')
      return ancestry.promise
    }
    if (method === 'library.entries.list') {
      const { parentId, query } = payload as { parentId: string | null; query: string }
      const data = query ? [nested] : parentId === nested.id ? [{ ...file, parentId: nested.id }] : [parent]
      return { data, pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  await screen.findByRole('button', { name: /真实父目录/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: nested.name } })
  const row = await screen.findByRole('button', { name: /搜索命中目录/ })
  row.focus(); fireEvent.click(row); fireEvent.click(row)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.get')).toHaveLength(1)
  expect(screen.getByRole('button', { name: /搜索命中目录/ })).toBe(row)
  expect(document.activeElement).toBe(row)
  const error = await screen.findByRole('alert')
  const retry = screen.getByRole('button', { name: zh.retry })
  const listings = read.mock.calls.filter(([method]) => method === 'library.entries.list').length
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.get')).toHaveLength(2)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.list')).toHaveLength(listings)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(screen.getByRole('alert')).toBe(error)
  expect(search.value).toBe(nested.name)
  await act(async () => { ancestry.resolve(parent) })
  await screen.findByRole('button', { name: /中文资料.md/ })
  const breadcrumb = screen.getByRole('button', { name: parent.name })
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('')
  expect(document.activeElement).toBe(search)
  fireEvent.click(breadcrumb)
  await waitFor(() => { expect(read.mock.calls.at(-1)).toEqual(['library.entries.list', {
    libraryId: library.id, parentId: parent.id, page: 1, size: 20, query: '', view: 'folder',
  }]) })
})
it('ignores a late folder ancestry retry after the search changes', async () => {
  const read = fixture(), ancestry = Promise.withResolvers<unknown>()
  let attempts = 0
  const parent = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '父目录', kind: 'FOLDER' as const,
    sha256: null, mediaType: null, sizeBytes: 0 }
  const nested = { ...parent, id: '44444444-4444-4444-8444-444444444444', parentId: parent.id, name: '旧搜索目录' }
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.get') return library
    if (method === 'library.entries.get') {
      if (++attempts === 1) throw new Error('Folder path unavailable')
      return ancestry.promise
    }
    if (method === 'library.entries.list') {
      const { query } = payload as { query: string }
      const data = query === nested.name ? [nested] : [file]
      return { data, pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  await screen.findByRole('button', { name: /中文资料.md/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: nested.name } })
  fireEvent.click(await screen.findByRole('button', { name: /旧搜索目录/ }))
  const retry = await screen.findByRole('button', { name: zh.retry })
  fireEvent.click(retry)
  await waitFor(() => { expect(attempts).toBe(2) })
  fireEvent.change(search, { target: { value: '中文资料' } })
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  await act(async () => { ancestry.resolve(parent) })
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(screen.queryByRole('button', { name: parent.name })).toBeNull()
  expect(search.value).toBe('中文资料')
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.list').every(([, payload]) =>
    (payload as { parentId: string | null }).parentId === null)).toBe(true)
})
it.each(['libraries', 'entries'] as const)('retains %s rows until a corrected tail page is ready', async (kind) => {
  const read = fixture(), correction = Promise.withResolvers<unknown>()
  let removed = false
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.get') return library
    if (method === (kind === 'libraries' ? 'library.list' : 'library.entries.list')) {
      const { page } = payload as { page: number }
      if (removed && page === 1) return correction.promise
      const data = removed ? [] : kind === 'libraries' ? [library] : [file]
      return { data, pageIndex: page, pageSize: 20, totalCount: removed ? 20 : 21, totalPages: removed ? 1 : 2 }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  render(<LibraryBrowser {...(kind === 'entries' ? { rootLibrary: library } : {})} t={t} renderFactorySlot={renderFactorySlot} />)
  const title = kind === 'libraries' ? /项目资料/ : /中文资料.md/
  const row = await screen.findByRole('button', { name: title })
  const refresh = screen.getByRole('button', { name: zh.refresh })
  await waitFor(() => { expect(refresh.getAttribute('aria-busy')).toBe('false') })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryNext }))
  await waitFor(() => { expect(screen.getByText('2 / 2')).toBeDefined(); expect(refresh.getAttribute('aria-busy')).toBe('false') })
  removed = true
  refresh.focus(); fireEvent.click(refresh)
  await waitFor(() => { expect(read.mock.calls.at(-1)?.[1]).toMatchObject({ page: 1 }) })
  expect(screen.getByRole('button', { name: title })).toBe(row)
  expect(screen.queryByText(kind === 'libraries' ? zh.libraryDirectoryEmpty : zh.libraryEmpty)).toBeNull()
  expect(document.activeElement).toBe(refresh)
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  const data = kind === 'libraries' ? [{ ...library, name: '保留的资料库' }] : [{ ...file, name: '保留的文件.md' }]
  await act(async () => { correction.resolve({ data, pageIndex: 1, pageSize: 20, totalCount: 20, totalPages: 1 }) })
  await waitFor(() => { expect(refresh.getAttribute('aria-busy')).toBe('false') })
  expect(screen.getByText('1 / 1')).toBeDefined()
  expect(document.activeElement).toBe(refresh)
})
it('hides write actions during discard confirmation and restores their original nodes on return', () => {
  const read = fixture(), committed = vi.fn()
  render(<LibraryMutation kind="editLibrary" location={{ library, parentId: null }} t={t} onClose={vi.fn()} onCommitted={committed} />)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  const save = screen.getByRole('button', { name: zh.saveResource })
  fireEvent.change(input, { target: { value: '待确认的名称' } }); input.focus(); input.setSelectionRange(1, 4)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByRole('button', { name: zh.saveResource })).toBeNull()
  fireEvent.click(save)
  expect(read).not.toHaveBeenCalled()
  expect(committed).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.libraryKeepEditing }))
  expect(screen.getByRole('button', { name: zh.saveResource })).toBe(save)
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4])
})
it('cancels attachment admission, and a late result cannot close a newly opened picker', async () => {
  fixture()
  let open!: () => void
  const subscribeOpen = (value: () => void) => { open = value; return () => {} }
  const pending = Promise.withResolvers<undefined>()
  const attachLibraryFiles = vi.fn(async (_session: SessionId, _files: readonly LibraryEntry[], _signal: AbortSignal) => pending.promise)
  render(<TaskLibraryInput openEmployeeSignIn={vi.fn()} focusInput={vi.fn()} sessionId={SessionId('session-a')} t={t} renderFactorySlot={renderFactorySlot} subscribeOpen={subscribeOpen} attachLibraryFiles={attachLibraryFiles} />)
  await act(async () => { await Promise.resolve() })
  act(() =>{  open() })
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryShared }))
  fireEvent.click(await screen.findByRole('button', { name: /项目资料/ }))
  fireEvent.click(await screen.findByRole('checkbox', { name: file.name }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: zh.libraryAttach.replace('{count}', '1') }))
  fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  expect(attachLibraryFiles.mock.calls[0]?.[2].aborted).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() =>{  open() })
  const next = screen.getByRole('dialog')
  await act(async () =>{  pending.resolve(undefined) })
  expect(screen.getByRole('dialog')).toBe(next)
})
it('keeps a failed attachment admission and its file selection stable through retry', async () => {
  const read = fixture()
  let open!: () => void
  const subscribeOpen = (value: () => void) => { open = value; return () => {} }
  const gate = Promise.withResolvers<undefined>()
  const attach = vi.fn<(_session: SessionId, _files: readonly LibraryEntry[], _signal: AbortSignal) => Promise<void>>()
    .mockRejectedValueOnce(new Error('file read offline')).mockImplementationOnce(() => gate.promise)
  render(<TaskLibraryInput openEmployeeSignIn={vi.fn()} focusInput={vi.fn()} sessionId={SessionId('session-a')}
    t={t} renderFactorySlot={renderFactorySlot} subscribeOpen={subscribeOpen} attachLibraryFiles={attach} />)
  await act(async () => { await Promise.resolve() })
  act(() => { open() })
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryShared }))
  fireEvent.click(await screen.findByRole('button', { name: /项目资料/ }))
  fireEvent.click(await screen.findByRole('checkbox', { name: file.name }))
  const save = screen.getByRole('button', { name: zh.libraryAttach.replace('{count}', '1') })
  const row = screen.getByRole('button', { name: /中文资料.md/ }), search = screen.getByRole('searchbox')
  save.focus(); fireEvent.click(save)
  const error = await screen.findByRole('alert')
  expect(error.textContent).toBe(zh.libraryAttachFailed)
  expect(error.getAttribute('tabindex')).toBe('0')
  fireEvent.click(save); fireEvent.click(save)
  expect(attach).toHaveBeenCalledTimes(2)
  expect(attach.mock.calls.map(([, files]) => files)).toEqual([[file], [file]])
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(screen.getByRole('alert')).toBe(error)
  expect(document.activeElement).toBe(save)
  const selected = screen.getByRole<HTMLInputElement>('checkbox', { name: file.name })
  expect(selected.disabled).toBe(true)
  expect((search as HTMLInputElement).readOnly).toBe(true)
  expect(row.getAttribute('aria-disabled')).toBe('true')
  const recent = screen.getByRole('tab', { name: zh.libraryRecent })
  expect(recent.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
  const reads = read.mock.calls.length
  fireEvent.click(recent)
  fireEvent.change(search, { target: { value: '另一个目录' } })
  fireEvent.click(selected)
  expect(read.mock.calls.length).toBe(reads)
  expect((search as HTMLInputElement).value).toBe('')
  expect(selected.checked).toBe(true)
  await act(async () => { gate.resolve(undefined) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each(['error', 'other'] as const)('recovers only removed download-error focus after a successful retry (%s)', async (focused) => {
  const read = fixture(), downloaded = Promise.withResolvers<unknown>()
  render(<LibraryPreview entry={file} t={t} renderFactorySlot={renderFactorySlot} onClose={vi.fn()} />)
  read.mockRejectedValueOnce(new Error('download unavailable'))
  const download = screen.getByRole('button', { name: zh.libraryDownload })
  fireEvent.click(download)
  const alert = await screen.findByRole('alert')
  read.mockImplementationOnce(() => downloaded.promise)
  fireEvent.click(download); fireEvent.click(download)
  expect(read.mock.calls.filter(([method]) => method === 'library.files.download')).toHaveLength(2)
  expect(screen.getByRole('alert')).toBe(alert)
  const close = screen.getAllByRole('button', { name: zh.close }).at(-1)!
  const target = focused === 'error' ? alert : close
  target.focus()
  await act(async () => { downloaded.resolve(true) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: zh.libraryDownload })).toBe(download)
  expect(document.activeElement).toBe(focused === 'error' ? download : close)
})

it('does not reuse a previous blocked-close notice during the next library save', async () => {
  const read = fixture(), first = Promise.withResolvers<unknown>(), retried = Promise.withResolvers<unknown>()
  const committed = vi.fn(), closed = vi.fn()
  render(<LibraryMutation kind="rename" entry={file} t={t} onClose={closed} onCommitted={committed} />)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  fireEvent.change(input, { target: { value: '保留资料.md' } })
  const save = screen.getByRole('button', { name: zh.saveResource })
  read.mockImplementationOnce(() => first.promise)
  save.focus(); fireEvent.click(save); fireEvent.keyDown(save, { key: 'Escape' })
  expect(screen.getByRole('status').textContent).toBe(zh.libraryWait)
  await act(async () => { first.reject(new Error('save unavailable')) })
  const alert = screen.getByRole('alert')
  expect(screen.queryByRole('status')).toBeNull()
  read.mockImplementationOnce(() => retried.promise)
  fireEvent.click(save); fireEvent.click(save)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: zh.saveResource })).toBe(save)
  expect(document.activeElement).toBe(save)
  expect(read).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(save, { key: 'Escape' })
  expect(screen.getByRole('status').textContent).toBe(zh.libraryWait)
  expect(screen.queryByText(zh.libraryDiscardConfirm)).toBeNull()
  expect(closed).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: zh.libraryName })).toBe(input)
  await act(async () => { retried.resolve(true) })
  expect(committed).toHaveBeenCalledOnce()
  expect(screen.queryByRole('status')).toBeNull()
})

it.each((['success', 'failure'] as const).flatMap(outcome => [false, true].map(corrected => ({ outcome, corrected }))))(
  'retains a newer folder-navigation error after an older background refresh ($outcome, corrected=$corrected)', async ({ outcome, corrected }) => {
    const read = fixture(), background = Promise.withResolvers<unknown>()
    const parent = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '真实父目录', kind: 'FOLDER' as const,
      sha256: null, mediaType: null, sizeBytes: 0 }
    const nested = { ...parent, id: '44444444-4444-4444-8444-444444444444', parentId: parent.id, name: '搜索命中目录' }
    let reads = 0, ancestry = 0, shrunk = false
    const page = { data: [nested], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    read.mockImplementation(async (method, payload) => {
      if (method === 'library.get') return library
      if (method === 'library.entries.get') {
        if (++ancestry === 1) throw new ProductError('LIBRARY_ACCESS_DENIED', 'Folder access denied', false)
        return parent
      }
      if (method === 'library.entries.list') {
        if (++reads === (corrected ? 4 : 3)) return background.promise
        const { query, parentId, page: pageIndex } = payload as { query: string; parentId: string | null; page: number }
        if (corrected && shrunk && reads === 5 && outcome === 'failure') {
          throw new ProductError('LIBRARY_FILE_INVALID', 'Correction failed', false)
        }
        return { ...page, pageIndex, totalPages: corrected && !shrunk ? 2 : 1,
          data: query ? [nested] : parentId === nested.id ? [{ ...file, parentId: nested.id }] : [parent] }
      }
      throw new Error(`Unexpected folder feedback method: ${method}`)
    })
    render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
    await screen.findByRole('button', { name: /真实父目录/ })
    const search = screen.getByRole<HTMLInputElement>('searchbox')
    fireEvent.change(search, { target: { value: nested.name } })
    const row = await screen.findByRole('button', { name: /搜索命中目录/ }), refresh = screen.getByRole('button', { name: zh.refresh })
    await waitFor(() => { expect(refresh.getAttribute('aria-busy')).toBe('false') })
    if (corrected) {
      fireEvent.click(screen.getByRole('button', { name: zh.libraryNext }))
      await waitFor(() => { expect(refresh.getAttribute('aria-busy')).toBe('false') })
    }
    fireEvent.click(refresh)
    row.focus(); fireEvent.click(row); fireEvent.click(row)
    const notice = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
    expect(notice.textContent).toContain(zh.libraryAccessDenied)
    expect(ancestry).toBe(1)
    search.focus(); search.setSelectionRange(1, 4)
    await act(async () => {
      shrunk = corrected
      if (corrected) background.resolve({ ...page, data: [], pageIndex: 2 })
      else if (outcome === 'success') background.resolve(page)
      else background.reject(new ProductError('LIBRARY_FILE_INVALID', 'Older refresh failure', false))
    })
    expect(screen.getByRole('alert')).toBe(notice)
    expect(notice.textContent).toContain(zh.libraryAccessDenied)
    expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
    expect(screen.getByRole('button', { name: /搜索命中目录/ })).toBe(row)
    expect(document.activeElement).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual([nested.name, 1, 4])
    retry.focus(); fireEvent.click(retry)
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(document.activeElement).toBe(search)
    await screen.findByRole('button', { name: /中文资料.md/ })
    expect(ancestry).toBe(2)
    expect(screen.getByRole('button', { name: parent.name })).toBeTruthy()
  })

it('saves a metadata draft after effect reactivation and keeps its node and selection through retry', async () => {
  const read = fixture(), committed = vi.fn(), close = vi.fn()
  let attempts = 0
  read.mockImplementation(async (method) => {
    if (method === 'library.update' && ++attempts === 1) throw new Error('offline')
    return true
  })
  render(<StrictMode><LibraryMutation kind="editLibrary" location={{ library, parentId: null }} t={t} onClose={close} onCommitted={committed} /></StrictMode>)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  fireEvent.change(input, { target: { value: '更新的资料名称' } })
  input.setSelectionRange(2, 5)
  const save = screen.getByRole('button', { name: zh.saveResource })
  save.focus(); fireEvent.click(save)
  const error = await screen.findByRole('alert')
  expect(attempts).toBe(1)
  const retry = Promise.withResolvers<unknown>()
  read.mockImplementation(async () => retry.promise)
  fireEvent.click(save); fireEvent.click(save)
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('textbox', { name: zh.libraryName })).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5])
  expect(screen.getByRole('button', { name: zh.saveResource })).toBe(save)
  expect(document.activeElement).toBe(save)
  expect(read.mock.calls.filter(([method]) => method === 'library.update')).toHaveLength(2)
  await act(async () => { retry.resolve({ ...library, name: '更新的资料名称', version: 2 }) })
  expect(committed).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
})

it('reports confirmed read-only permissions while retained directory rows fail and retry', async () => {
  const read = fixture(), onLocation = vi.fn()
  render(<LibraryBrowser rootLibrary={library} t={t} onLocation={onLocation} renderFactorySlot={renderFactorySlot} />)
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const original = read.getMockImplementation()!
  let result = Promise.withResolvers<unknown>()
  read.mockImplementation((method, payload) => method === 'library.get' ? Promise.resolve({ ...library, role: 'VIEWER', canManage: false })
    : method === 'library.entries.list' ? result.promise : original(method, payload))
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  upload.focus(); fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull() })
  expect(onLocation).toHaveBeenLastCalledWith({ library: { ...library, role: 'VIEWER', canManage: false }, parentId: null })
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(document.activeElement).toBe(search)
  await act(async () => { result.reject(new Error('directory offline')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  result = Promise.withResolvers<unknown>()
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  await act(async () => { result.resolve({ data: [file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(document.activeElement).toBe(search)
})

it.each([true, false])('offers nested folder creation in a destination picker only with management permission (%s)', async (canManage) => {
  const read = fixture()
  const original = read.getMockImplementation()!
  read.mockImplementation(async (method, payload) => method === 'library.get' ? { ...library, canManage } : original(method, payload))
  render(<LibraryBrowser foldersOnly rootLibrary={{ ...library, canManage }} t={t} renderFactorySlot={renderFactorySlot} />)
  await waitFor(() => { expect(read).toHaveBeenCalledWith('library.entries.list', expect.anything()) })
  expect(screen.queryByRole('button', { name: zh.refresh })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  if (!canManage) {
    expect(screen.queryByRole('button', { name: zh.libraryNewFolder })).toBeNull()
    return
  }
  const trigger = screen.getByRole('button', { name: zh.libraryNewFolder })
  trigger.focus(); fireEvent.click(trigger)
  fireEvent.change(screen.getByRole('textbox', { name: zh.libraryName }), { target: { value: '模板' } })
  fireEvent.click(screen.getByRole('button', { name: zh.saveResource }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(read).toHaveBeenCalledWith('library.folders.create', expect.objectContaining({ libraryId: library.id, parentId: null, name: '模板' }))
  expect(document.activeElement).toBe(trigger)
})

it('retains locked attachment controls and ignores selection and view changes until admission settles', async () => {
  const read = fixture(), select = vi.fn(), original = read.getMockImplementation()!
  read.mockImplementation(async (method, payload) => method === 'library.files.list'
    ? { data: [{ entry: file, libraryName: library.name, canManage: true, lastAccessedAt: file.updatedAt, sourceKind: 'UPLOAD', sourceSessionId: null }],
      pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 } : original(method, payload))
  const props = { t, onSelect: select, selected: new Map([[file.id, file]]), navigationLocked: false }
  const surface = render(<LibraryFilePicker {...props} />)
  const row = await screen.findByRole('button', { name: file.name })
  const selected = screen.getByRole<HTMLInputElement>('checkbox', { name: file.name })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const mine = screen.getByRole('tab', { name: zh.libraryPersonal })
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  search.focus(); fireEvent.change(search, { target: { value: '中文' } }); search.setSelectionRange(0, 1)
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  surface.rerender(<LibraryFilePicker {...props} navigationLocked />)
  expect(screen.getByRole('checkbox', { name: file.name })).toBe(selected)
  expect(search.readOnly).toBe(true)
  expect(selected.disabled).toBe(true)
  expect(mine.closest('[aria-disabled]')?.getAttribute('aria-disabled')).toBe('true')
  const count = read.mock.calls.length
  fireEvent.click(selected); fireEvent.click(mine)
  expect(select).not.toHaveBeenCalled()
  expect(read.mock.calls.length).toBe(count)
  expect(search.value).toBe('中文')
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  expect(document.activeElement).toBe(search)
  surface.rerender(<LibraryFilePicker {...props} />)
  expect(screen.getByRole('button', { name: file.name })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(selected.disabled).toBe(false)
  expect(search.readOnly).toBe(false)
  fireEvent.click(selected)
  expect(select).toHaveBeenCalledExactlyOnceWith(file)
})

it('cancels an unfinished folder opener when attachment admission locks the directory', async () => {
  const read = fixture(), parentRead = Promise.withResolvers<unknown>()
  const parent = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '父目录', kind: 'FOLDER',
    sha256: null, mediaType: null, sizeBytes: 0 }
  const folder = { ...parent, id: '44444444-4444-4444-8444-444444444444', name: '搜索命中的资料子目录', parentId: parent.id }
  const original = read.getMockImplementation()!
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.entries.list') {
      const data = (payload as { query: string }).query ? [file, folder] : [file]
      return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: 1 }
    }
    if (method === 'library.entries.get') return parentRead.promise
    return original(method, payload)
  })
  const props = { t, onSelect: vi.fn(), selected: new Map([[file.id, file]]), navigationLocked: false }
  const surface = render(<LibraryFilePicker {...props} />)
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryShared }))
  fireEvent.click(await screen.findByRole('button', { name: library.name }))
  await screen.findByRole('button', { name: /中文资料.md/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '资料' } })
  const target = await screen.findByRole('button', { name: /搜索命中的资料子目录/ })
  const row = screen.getByRole('button', { name: /中文资料.md/ })
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  target.focus(); fireEvent.click(target)
  expect(target.getAttribute('aria-busy')).toBe('true')
  const payload = read.mock.calls.find(([method]) => method === 'library.entries.get')?.[1]
  expect(payload).toMatchObject({ libraryId: library.id, entryId: parent.id })
  surface.rerender(<LibraryFilePicker {...props} navigationLocked />)
  expect(target.getAttribute('aria-busy')).not.toBe('true')
  const count = read.mock.calls.length
  await act(async () => { parentRead.resolve(parent) })
  expect(read.mock.calls.length).toBe(count)
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(target)
  expect(screen.queryByRole('alert')).toBeNull()
  surface.rerender(<LibraryFilePicker {...props} />)
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
})

it('blocks folder creation in a locked destination picker', async () => {
  const read = fixture()
  render(<LibraryBrowser foldersOnly navigationLocked rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  const trigger = screen.getByRole('button', { name: zh.libraryNewFolder })
  expect(trigger.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(read.mock.calls.some(([method]) => method === 'library.folders.create')).toBe(false)
})


it.each(['close', 'cancel', 'escape'] as const)('dismisses a shared space draft directly with %s', (action) => {
  const read = fixture(), close = vi.fn(), committed = vi.fn()
  render(<LibraryMutation kind="createLibrary" t={t} onClose={close} onCommitted={committed} />)
  const dialog = screen.getByRole('dialog', { name: zh.libraryNewTeam })
  expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)
  const input = within(dialog).getByRole('textbox', { name: zh.libraryName })
  fireEvent.change(input, { target: { value: '未保存的共享空间' } })
  if (action === 'escape') fireEvent.keyDown(input, { key: 'Escape' })
  else fireEvent.click(within(dialog).getByRole('button', { name: action === 'close' ? commonZh.close : zh.cancel }))
  expect(close).toHaveBeenCalledOnce()
  expect(screen.queryByText(zh.libraryDiscardConfirm)).toBeNull()
  expect(read).not.toHaveBeenCalled()
  expect(committed).not.toHaveBeenCalled()
})

it('retains shared space writes and retry identity while blocking close until they settle', async () => {
  const read = fixture(), close = vi.fn(), committed = vi.fn()
  let result = Promise.withResolvers<unknown>()
  read.mockImplementation(() => result.promise)
  render(<LibraryMutation kind="createLibrary" t={t} onClose={close} onCommitted={committed} />)
  const dialog = screen.getByRole('dialog', { name: zh.libraryNewTeam })
  expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)
  const input = within(dialog).getByRole('textbox', { name: zh.libraryName })
  const save = within(dialog).getByRole('button', { name: zh.saveResource })
  fireEvent.change(input, { target: { value: '共享验收' } })
  fireEvent.click(save); fireEvent.click(save)
  fireEvent.click(within(dialog).getByRole('button', { name: commonZh.close }))
  expect(read).toHaveBeenCalledOnce()
  expect(read.mock.calls[0]![1]).toMatchObject({ name: '共享验收' })
  expect(read.mock.calls[0]![1]).toHaveProperty('key', expect.any(String))
  expect(close).not.toHaveBeenCalled()
  await act(async () => { result.reject(new Error('offline')) })
  await screen.findByRole('alert')
  expect(within(dialog).getByRole('textbox', { name: zh.libraryName })).toBe(input)
  result = Promise.withResolvers<unknown>()
  fireEvent.click(save)
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls[1]).toEqual(read.mock.calls[0])
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(close).not.toHaveBeenCalled()
  await act(async () => { result.resolve({ ...library, name: '共享验收' }) })
  expect(committed).toHaveBeenCalledWith({ library: { ...library, name: '共享验收' }, parentId: null })
  expect(close).not.toHaveBeenCalled()
})

it.each([true, false])('keeps confirmed root metadata and rows when clearing a query through its breadcrumb (%s)', async (foldersOnly) => {
  const read = fixture(), onLocation = vi.fn()
  const latest = { ...library, name: '当前共享资料', role: 'VIEWER', canManage: false }
  const entry = foldersOnly ? { ...file, kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 } : file
  const entries = { data: [entry], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
  read.mockImplementation(async method => method === 'library.get' ? latest : entries)
  render(<LibraryBrowser rootLibrary={library} foldersOnly={foldersOnly} onLocation={onLocation}
    t={t} renderFactorySlot={renderFactorySlot} />)
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  await act(async () => { fireEvent.change(search, { target: { value: '资料' } }) })
  const root = screen.getByRole('button', { name: zh.library })
  const metadata = Promise.withResolvers<unknown>()
  let listing = Promise.withResolvers<unknown>()
  read.mockImplementation(async method => method === 'library.get' ? metadata.promise : listing.promise)
  root.focus(); fireEvent.click(root)
  expect(screen.queryByRole('button', { name: zh.libraryNewFolder })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(screen.getByRole('button', { name: latest.name })).toBeTruthy()
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('')
  expect(document.activeElement).toBe(root)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  await act(async () => { metadata.resolve(latest); listing.reject(new Error('Root unavailable')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  listing = Promise.withResolvers<unknown>()
  const reads = read.mock.calls.filter(([method]) => method === 'library.get').length
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  await waitFor(() => { expect(read.mock.calls.filter(([method]) => method === 'library.get')).toHaveLength(reads + 1) })
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  await act(async () => { listing.resolve(entries) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(onLocation).toHaveBeenLastCalledWith({ library: latest, parentId: null })
  expect(document.activeElement).toBe(search)
  expect(read.mock.calls.some(([method]) => method === 'library.folders.create')).toBe(false)
})
