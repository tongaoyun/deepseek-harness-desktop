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
import { LibraryPreview } from '../src/client/LibraryPreview.tsx'
import { LibraryMutation } from '../src/client/LibraryMutation.tsx'
import { TaskLibraryInput } from '../src/client/TaskLibraryInput.tsx'
import { zh } from '../src/locales.ts'
const library = { id: '11111111-1111-4111-8111-111111111111', name: '项目资料', description: '团队文件', scope: 'PERSONAL' as const,
  ownerId: 'employee', managerEmployeeId: 'employee', canManage: true, version: 1, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' }
const file = { id: '22222222-2222-4222-8222-222222222222', libraryId: library.id, parentId: null, name: '中文资料.md', kind: 'FILE' as const,
  sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, favorite: false, version: 1, createdAt: library.createdAt, updatedAt: library.updatedAt }
const t = makeTranslate(zh, commonZh)
const renderFactorySlot = (() => null)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture() {
  const read = vi.fn(async (method: string, _payload?: unknown): Promise<unknown> => {
    if (method === 'auth.getSession') return { authenticated: true, employeeId: 'employee' }
    if (method === 'library.get') return library
    if (method === 'library.list') return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.entries.list') return { data: [file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    return true
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke: async (_namespace: string, method: string, payload?: unknown) => ({ ok: true, result: await read(method, payload) }), cancel: vi.fn(), subscribe: () => () => {} } })
  return read
}
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
  const region = screen.getByRole('region', { name: zh.loadFailed })
  expect({ role: region.getAttribute('role'), tabIndex: region.tabIndex, message: alert.textContent }).toMatchInlineSnapshot(`
    {
      "message": "产品目录暂时无法加载，请稍后重试。",
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
  expect(screen.getByRole('region', { name: zh.loadFailed })).toBe(region)
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
it.each(['library', 'folder'] as const)('reuses the %s creation receipt when only surrounding name whitespace changes', async (kind) => {
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
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('false') })
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
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('false') })
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
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
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
  fireEvent.click(row); fireEvent.click(row)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.get')).toHaveLength(2)
  expect(screen.getByRole('alert')).toBe(error)
  expect(search.value).toBe(nested.name)
  await act(async () => { ancestry.resolve(parent) })
  await screen.findByRole('button', { name: /中文资料.md/ })
  const breadcrumb = screen.getByRole('button', { name: parent.name })
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('')
  fireEvent.click(breadcrumb)
  await waitFor(() => { expect(read.mock.calls.at(-1)).toEqual(['library.entries.list', {
    libraryId: library.id, parentId: parent.id, page: 1, size: 20, query: '', view: 'folder',
  }]) })
})
it('ignores a late folder ancestry response after the search changes', async () => {
  const read = fixture(), ancestry = Promise.withResolvers<unknown>()
  const parent = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '父目录', kind: 'FOLDER' as const,
    sha256: null, mediaType: null, sizeBytes: 0 }
  const nested = { ...parent, id: '44444444-4444-4444-8444-444444444444', parentId: parent.id, name: '旧搜索目录' }
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.get') return library
    if (method === 'library.entries.get') return ancestry.promise
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
it.each((['search', 'page'] as const).flatMap(change => (['success', 'failure'] as const).map(outcome => ({ change, outcome }))))(
  'settles a favorite write after changing the $change ($outcome)', async ({ change, outcome }) => {
    const read = fixture(), write = Promise.withResolvers<unknown>(), retryWrite = Promise.withResolvers<unknown>()
    const original = read.getMockImplementation()!
    const nextFile = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '第二页资料.md' }
    let writes = 0, saved = false
    read.mockImplementation(async (method, payload) => {
      if (method === 'library.entries.favorite') {
        const pending = ++writes === 1 ? write : retryWrite
        await pending.promise
        saved = true
        return true
      }
      if (method === 'library.entries.list') {
        const { page } = payload as { page: number }
        return { data: [page === 1 ? { ...file, favorite: saved } : nextFile],
          pageIndex: page, pageSize: 20, totalCount: 21, totalPages: 2 }
      }
      return original(method, payload)
    })
    render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
    const row = await screen.findByRole('button', { name: /中文资料.md/ })
    const toggle = within(row.closest('article')!).getByRole('button', { name: zh.libraryFavorite })
    const search = screen.getByRole<HTMLInputElement>('searchbox')
    fireEvent.click(toggle); fireEvent.click(toggle)
    expect(writes).toBe(1)
    if (change === 'search') {
      fireEvent.change(search, { target: { value: '中文' } })
      search.focus(); search.setSelectionRange(0, 1)
    } else {
      const next = screen.getByRole('button', { name: zh.libraryNext })
      next.focus(); fireEvent.click(next)
      await screen.findByRole('button', { name: /第二页资料.md/ })
    }
    const current = screen.getByRole('button', { name: change === 'search' ? /中文资料.md/ : /第二页资料.md/ })
    await waitFor(() => { expect(read.mock.calls.filter(([method]) => method === 'library.entries.list')).toHaveLength(2) })
    const focused = document.activeElement
    if (outcome === 'failure') {
      await act(async () => { write.reject(new Error('favorite offline')) })
      const error = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
      expect(document.activeElement).toBe(focused)
      retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
      expect(writes).toBe(2)
      expect(screen.getByRole('alert')).toBe(error)
      expect(document.activeElement).toBe(retry)
      await act(async () => { retryWrite.resolve(true) })
      await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
      expect(document.activeElement).toBe(search)
    } else {
      await act(async () => { write.resolve(true) })
      expect(document.activeElement).toBe(focused)
    }
    await waitFor(() => { expect(read.mock.calls.filter(([method]) => method === 'library.entries.list')).toHaveLength(3) })
    expect(screen.getByRole('searchbox')).toBe(search)
    expect(screen.getByRole('button', { name: change === 'search' ? /中文资料.md/ : /第二页资料.md/ })).toBe(current)
    expect(search.value).toBe(change === 'search' ? '中文' : '')
    if (change === 'search') {
      expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
      expect(within(current.closest('article')!).getByRole('button', { name: zh.libraryUnfavorite })).toBe(toggle)
    } else {
      expect(screen.getByText('2 / 2')).toBeDefined()
      expect(screen.queryByRole('button', { name: /中文资料.md/ })).toBeNull()
    }
    expect(read.mock.calls.filter(([method]) => method === 'library.entries.favorite').map(([, payload]) => payload))
      .toEqual(Array(outcome === 'success' ? 1 : 2).fill({ libraryId: library.id, entryId: file.id, value: true }))
  },
)
it('ignores a searched list read from before the confirmed favorite write', async () => {
  const read = fixture(), write = Promise.withResolvers<unknown>(), stale = Promise.withResolvers<unknown>()
  const original = read.getMockImplementation()!
  let reads = 0, saved = false
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.entries.favorite') { await write.promise; saved = true; return true }
    if (method === 'library.entries.list') {
      if (++reads === 2) return stale.promise
      return { data: [{ ...file, favorite: saved }], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    }
    return original(method, payload)
  })
  render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  const toggle = within(row.closest('article')!).getByRole('button', { name: zh.libraryFavorite })
  fireEvent.click(toggle)
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '中文' } })
  search.focus(); search.setSelectionRange(0, 1)
  await act(async () => { write.resolve(true) })
  await waitFor(() => { expect(reads).toBe(3) })
  await act(async () => { stale.resolve({ data: [file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }) })
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(within(row.closest('article')!).getByRole('button', { name: zh.libraryUnfavorite })).toBe(toggle)
  expect(document.activeElement).toBe(search)
  expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['中文', 0, 1])
})
it('disposes an in-flight favorite without altering a newly mounted library browser', async () => {
  const read = fixture(), write = Promise.withResolvers<unknown>()
  const original = read.getMockImplementation()!
  read.mockImplementation(async (method, payload) => method === 'library.entries.favorite' ? write.promise : original(method, payload))
  const first = render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  fireEvent.click(within(row.closest('article')!).getByRole('button', { name: zh.libraryFavorite }))
  first.unmount()
  render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  const current = await screen.findByRole('button', { name: /中文资料.md/ }), search = screen.getByRole('searchbox')
  search.focus()
  await act(async () => { write.reject(new Error('old favorite failed')) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(current)
  expect(document.activeElement).toBe(search)
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.list')).toHaveLength(2)
})
it('keeps an unrelated favorite failure actionable while saving another entry', async () => {
  const read = fixture(), otherWrite = Promise.withResolvers<unknown>(), retryWrite = Promise.withResolvers<unknown>()
  const original = read.getMockImplementation()!
  const other = { ...file, id: '33333333-3333-4333-8333-333333333333', name: '另一份资料.md' }
  const saved = new Set<string>()
  let writes = 0
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.entries.favorite') {
      const { entryId } = payload as { entryId: string }
      if (++writes === 1) throw new Error('first favorite failed')
      await (entryId === other.id ? otherWrite : retryWrite).promise
      saved.add(entryId)
      return true
    }
    if (method === 'library.entries.list') return { data: [file, other].map(entry => ({ ...entry, favorite: saved.has(entry.id) })),
      pageIndex: 1, pageSize: 20, totalCount: 2, totalPages: 1 }
    return original(method, payload)
  })
  render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  fireEvent.click(within(row.closest('article')!).getByRole('button', { name: zh.libraryFavorite }))
  const error = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const otherRow = screen.getByRole('button', { name: /另一份资料.md/ })
  const toggle = within(otherRow.closest('article')!).getByRole('button', { name: zh.libraryFavorite })
  toggle.focus(); fireEvent.click(toggle)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(retry.getAttribute('aria-busy')).toBe('false')
  expect(toggle.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(retry)
  expect(writes).toBe(2)
  await act(async () => { otherWrite.resolve(true) })
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.getAttribute('aria-disabled')).toBe('false')
  expect(document.activeElement).toBe(toggle)
  retry.focus(); fireEvent.click(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(toggle.getAttribute('aria-busy')).toBe('false')
  await act(async () => { retryWrite.resolve(true) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.favorite').map(([, payload]) => payload))
    .toEqual([file.id, other.id, file.id].map(entryId => ({ libraryId: library.id, entryId, value: true })))
})
it('retries the failed favorite write once and refreshes its list after confirmation', async () => {
  const read = fixture(), retryGate = Promise.withResolvers<unknown>()
  const original = read.getMockImplementation()!
  let writes = 0, saved = false
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.entries.favorite') {
      if (++writes === 1) throw new Error('favorite offline')
      await retryGate.promise
      saved = true
      return true
    }
    if (method === 'library.entries.list') return { data: [{ ...file, favorite: saved }], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    return original(method, payload)
  })
  render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  fireEvent.click(within(row.closest('article')!).getByRole('button', { name: zh.libraryFavorite }))
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(writes).toBe(2)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  const calls = read.mock.calls.filter(([method]) => method === 'library.entries.favorite')
  expect(calls.map(([, payload]) => payload)).toEqual(Array(2).fill({ libraryId: library.id, entryId: file.id, value: true }))
  await act(async () => { retryGate.resolve(true) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.list')).toHaveLength(2)
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(row)
  expect(within(row.closest('article')!).getByRole('button', { name: zh.libraryUnfavorite })).toBeDefined()
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})
it('returns from a removed favorites tail page without leaving an empty page or lost focus', async () => {
  const read = fixture()
  let removed = false
  read.mockImplementation(async (method, payload) => {
    if (method === 'library.get') return library
    if (method === 'library.entries.favorite') { removed = true; return false }
    if (method === 'library.entries.list') {
      const { page, view } = payload as { page: number; view: string }
      const data = page === 2 ? removed ? [] : [{ ...file, favorite: true }]
        : [{ ...file, id: '44444444-4444-4444-8444-444444444444', name: '保留资料.md', favorite: true }]
      const total = view === 'favorites' && removed ? 20 : 21
      return { data, pageIndex: page, pageSize: 20, totalCount: total, totalPages: Math.ceil(total / 20) }
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  render(<LibraryBrowser rootLibrary={library} t={t} renderFactorySlot={renderFactorySlot} />)
  await screen.findByRole('button', { name: /保留资料.md/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryFavorites }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('false') })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryNext }))
  const row = await screen.findByRole('button', { name: /中文资料.md/ })
  const remove = within(row.closest('article')!).getByRole('button', { name: zh.libraryUnfavorite })
  remove.focus(); fireEvent.click(remove)
  await screen.findByRole('button', { name: /保留资料.md/ })
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('false') })
  expect(screen.getByText('1 / 1')).toBeDefined()
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  expect(read.mock.calls.filter(([method]) => method === 'library.entries.favorite')).toHaveLength(1)
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
  fireEvent.click(await screen.findByRole('button', { name: /项目资料/ }))
  fireEvent.click(await screen.findByRole('button', { name: zh.libraryChoose }))
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
  fixture()
  let open!: () => void
  const subscribeOpen = (value: () => void) => { open = value; return () => {} }
  const gate = Promise.withResolvers<undefined>()
  const attach = vi.fn<(_session: SessionId, _files: readonly LibraryEntry[], _signal: AbortSignal) => Promise<void>>()
    .mockRejectedValueOnce(new Error('file read offline')).mockImplementationOnce(() => gate.promise)
  render(<TaskLibraryInput openEmployeeSignIn={vi.fn()} focusInput={vi.fn()} sessionId={SessionId('session-a')}
    t={t} renderFactorySlot={renderFactorySlot} subscribeOpen={subscribeOpen} attachLibraryFiles={attach} />)
  await act(async () => { await Promise.resolve() })
  act(() => { open() })
  fireEvent.click(await screen.findByRole('button', { name: /项目资料/ }))
  fireEvent.click(await screen.findByRole('button', { name: zh.libraryChoose }))
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
    fireEvent.click(row)
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
  await act(async () => { retry.resolve(true) })
  expect(committed).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
})
