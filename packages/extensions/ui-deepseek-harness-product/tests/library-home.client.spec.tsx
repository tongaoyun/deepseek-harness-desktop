// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { LibraryHome } from '../src/client/LibraryHome.tsx'
import { zh } from '../src/locales.ts'
vi.mock('../src/client/LibrarySidebar.tsx', () => ({
  LibrarySidebar: (props: Parameters<typeof import('../src/client/LibrarySidebar.tsx').LibrarySidebar>[0]) => <nav aria-label={props.t('libraryNavigation')}>
    <h1>{props.t('library')}</h1>
    {(['recent', 'mine'] as const).map(view => <button key={view}
      aria-current={props.view === view ? 'page' : undefined} onClick={() => { props.onView(view) }}>
      {props.t(view === 'recent' ? 'libraryRecent' : 'libraryPersonal')}
    </button>)}
    <button onClick={props.onCreateFolder}>{props.t('libraryNewFolder')}</button>
  </nav>,
}))
const t = makeTranslate(zh, commonZh)
const timestamp = '2026-11-14T01:00:00Z'
const file = { entry: { id: '22222222-2222-4222-8222-222222222222', libraryId: '11111111-1111-4111-8111-111111111111',
  parentId: null, name: '产品方案.docx', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'application/octet-stream',
  sizeBytes: 5120, version: 1, createdAt: timestamp, updatedAt: timestamp },
libraryName: '个人资料', canManage: true, lastAccessedAt: timestamp, sourceKind: 'CONVERSATION', sourceSessionId: 'source-session' }
const personal = { id: file.entry.libraryId, name: '个人资料', description: '', scope: 'PERSONAL',
  ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
function page(data: readonly unknown[] = [file], pageIndex = 1, totalCount = data.length) {
  return { data, pageIndex, pageSize: 20, totalCount, totalPages: Math.ceil(totalCount / 20) }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture() {
  const read = vi.fn(async (method: string, _input?: unknown): Promise<unknown> => {
    if (method === 'library.personal.ensure' || method === 'library.get') return personal
    if (method === 'library.entries.list') return page([file.entry])
    return page()
  })
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, input: unknown) => ({ ok: true, result: await read(method, input) }),
    cancel: vi.fn(), subscribe: () => () => {},
  } })
  const create = vi.fn(), source = vi.fn()
  const rendered = render(<LibraryHome t={t} renderFactorySlot={() => null} startLibraryCreation={create} openLibrarySource={source} />)
  return { read, create, source, rendered }
}
it('retains controls, rows, selection and errors through refresh failure, retry and layout changes', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  fireEvent.change(search, { target: { value: '产品' } })
  await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('library.files.list', expect.objectContaining({ query: '产品' })) })
  search.focus(); search.setSelectionRange(0, 1)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryGrid }))
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(document.activeElement).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  const gate = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => gate.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  expect(screen.getByRole('button', { name: zh.libraryUpload })).toBe(upload)
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  await act(async () => { gate.reject(new Error('offline')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const retryGate = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => retryGate.promise)
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(f.read).toHaveBeenCalledTimes(4)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  await act(async () => { retryGate.resolve(personal) })
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('产品')
  expect(document.activeElement).toBe(search)
})
it('applies search and view filters before asking for a server page and ignores old responses', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const older = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => older.promise)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '产品' } })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('library.entries.list', expect.objectContaining({ libraryId: personal.id, parentId: null, view: 'folder', query: '产品', page: 1 })) })
  await act(async () => { older.resolve(page([{ ...file, entry: { ...file.entry, name: '过期.html' } }])) })
  expect(screen.queryByRole('button', { name: /过期/ })).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBeDefined()
})
it('delegates file creation and source navigation to native conversations', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryFromConversation }))
  expect(f.source).toHaveBeenCalledWith('source-session')
  fireEvent.click(screen.getByRole('button', { name: zh.libraryGenerate }))
  expect(f.create).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByRole('button', { name: zh.libraryGenerate }).hasAttribute('aria-haspopup')).toBe(false)
  expect(f.read).toHaveBeenCalledOnce()
})

it('keeps read-only shared files visible without an empty actions menu in either layout', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  f.read.mockResolvedValueOnce(page([{ ...file, canManage: false }]))
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '产品' } })
  await waitFor(() => { expect(screen.queryByRole('button', { name: /更多操作.*产品方案/ })).toBeNull() })
  const row = screen.getByRole('button', { name: /^产品方案/ })
  search.focus(); search.setSelectionRange(0, 1)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryGrid }))
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(screen.queryByRole('button', { name: /更多操作.*产品方案/ })).toBeNull()
  expect(document.activeElement).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  fireEvent.click(screen.getByRole('button', { name: zh.libraryFromConversation }))
  expect(f.source).toHaveBeenCalledWith('source-session')
})

it('cancels an in-flight move opener when its file view changes', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const gate = Promise.withResolvers<unknown>()
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, input) => method === 'library.get' ? gate.promise : original(method, input))
  fireEvent.click(screen.getByRole('button', { name: /更多操作.*产品方案/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryMove }))
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  await act(async () => { gate.resolve({ id: file.entry.libraryId, name: '个人资料', description: '', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.libraryUpload }))
  expect(screen.getByRole('dialog', { name: zh.libraryUpload })).toBeDefined()
})

it('keeps search, selection and file rows when switching navigation views', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const navigation = screen.getByRole('navigation', { name: zh.libraryNavigation })
  expect(within(navigation).getAllByRole('button').map(button => button.textContent))
    .toEqual([zh.libraryRecent, zh.libraryPersonal, zh.libraryNewFolder])
  expect(screen.queryByRole('button', { name: zh.refresh })).toBeNull()
  expect(f.read.mock.calls[0]?.[1]).not.toHaveProperty('category')
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '产品' } })
  search.setSelectionRange(0, 1)
  const mine = within(navigation).getByRole('button', { name: zh.libraryPersonal })
  mine.focus(); fireEvent.click(mine)
  await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('library.entries.list', expect.objectContaining({ view: 'folder', query: '产品' })) })
  expect(document.activeElement).toBe(mine)
  expect(mine.getAttribute('aria-current')).toBe('page')
  expect(screen.getByRole('searchbox')).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
})

it('hides single-page pagination and returns removed pagination focus to the stable search', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  expect(screen.queryByRole('button', { name: zh.libraryNext })).toBeNull()
  f.read.mockResolvedValueOnce(personal).mockResolvedValueOnce(page([file.entry], 1, 21))
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  const next = await screen.findByRole('button', { name: zh.libraryNext })
  f.read.mockResolvedValueOnce(personal).mockResolvedValueOnce(page([file.entry], 2, 21))
  fireEvent.click(next)
  await waitFor(() => { expect(screen.getByText('2 / 2')).toBeDefined() })
  const previous = screen.getByRole('button', { name: zh.libraryPrevious })
  previous.focus()
  f.read.mockResolvedValueOnce(personal).mockResolvedValueOnce(page([]))
  fireEvent.click(previous)
  await screen.findByText(zh.libraryEmpty)
  expect(screen.queryByRole('button', { name: zh.libraryPrevious })).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})

it('creates a folder from home, retaining its failed draft and receipt, then returns focus without repeating a successful write', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const library = { id: file.entry.libraryId, name: '个人资料', description: '', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
  let failedWrite = true, failedRefresh = false
  f.read.mockImplementation(async (method) => {
    if (method === 'library.personal.ensure' || method === 'library.get') return library
    if (method === 'library.list') return page([library])
    if (method === 'library.entries.list') {
      if (failedRefresh) throw new Error('refresh unavailable')
      return page([file.entry, { ...file.entry, id: '33333333-3333-4333-8333-333333333333', kind: 'FOLDER', name: '合同模板', sha256: null, mediaType: null, sizeBytes: 0 }])
    }
    if (method === 'library.folders.create') {
      if (failedWrite) throw new Error('write unavailable')
      failedRefresh = true
      return { ...file.entry, kind: 'FOLDER', name: '合同模板' }
    }
    if (failedRefresh) throw new Error('refresh unavailable')
    return page()
  })
  const trigger = screen.getByRole('button', { name: zh.libraryNewFolder })
  trigger.focus(); fireEvent.click(trigger)
  await screen.findByRole('dialog', { name: zh.libraryNewFolder })
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.libraryChangeLocation }).getAttribute('aria-disabled')).toBe('false') })
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  fireEvent.change(input, { target: { value: '合同模板' } })
  input.focus(); input.setSelectionRange(1, 3)
  const save = screen.getByRole('button', { name: zh.saveResource })
  fireEvent.click(save)
  await screen.findByRole('alert')
  expect(screen.getByRole('textbox', { name: zh.libraryName })).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3])
  failedWrite = false
  fireEvent.click(save); fireEvent.click(save)
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.folders.create')
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(writes[0]?.[1]).toMatchObject({ libraryId: library.id, parentId: null, name: '合同模板' })
  expect(document.activeElement).toBe(trigger)
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  failedRefresh = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.folders.create')).toHaveLength(2)
  expect(screen.getByRole('button', { name: zh.libraryPersonal }).getAttribute('aria-current')).toBe('page')
  expect(await screen.findByRole('button', { name: /^合同模板/ })).toBeDefined()
})

it('prepares a personal root without a manual library form and retains error and retry focus until recovery', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const library = { id: file.entry.libraryId, name: '我的资料', description: '', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
  const retried = Promise.withResolvers<unknown>()
  let attempts = 0
  f.read.mockImplementation(async (method) => {
    if (method === 'library.personal.ensure') {
      if (++attempts === 1) throw new Error('root unavailable')
      return retried.promise
    }
    if (method === 'library.get') return library
    if (method === 'library.entries.list') return page([])
    return page()
  })
  const trigger = screen.getByRole('button', { name: zh.libraryNewFolder })
  trigger.focus(); fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: zh.libraryNewFolder })
  const error = await within(dialog).findByRole('alert'), retry = within(dialog).getByRole('button', { name: zh.retry })
  expect(error.textContent).toBe(zh.libraryLoadFailed)
  expect(within(dialog).queryByRole('button', { name: zh.refresh })).toBeNull()
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(attempts).toBe(2)
  expect(within(dialog).getByRole('alert')).toBe(error)
  expect(document.activeElement).toBe(retry)
  await act(async () => { retried.resolve(library) })
  expect(screen.getByRole('dialog', { name: zh.libraryNewFolder })).toBe(dialog)
  const input = within(dialog).getByRole('textbox', { name: zh.libraryName })
  expect(document.activeElement).toBe(input)
  expect(within(dialog).queryByText('新建资料库')).toBeNull()
  expect(f.read.mock.calls.some(([method]) => method === 'library.create')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  expect(document.activeElement).toBe(trigger)
})


it('changes folder destinations in one modal without replacing the draft and separates failed write receipts by parent', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const library = { id: file.entry.libraryId, name: '我的资料', description: '', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', kind: 'FOLDER', name: '项目资料', sha256: null, mediaType: null, sizeBytes: 0 }
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.personal.ensure' || method === 'library.get') return library
    if (method === 'library.entries.list') return page((payload as { parentId: string | null }).parentId === null ? [folder] : [])
    if (method === 'library.folders.create') throw new Error('write unavailable')
    return page()
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryNewFolder }))
  const dialog = await screen.findByRole('dialog', { name: zh.libraryNewFolder })
  const input = within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  fireEvent.change(input, { target: { value: '合同模板' } })
  input.focus(); input.setSelectionRange(1, 3)
  const change = within(dialog).getByRole('button', { name: zh.libraryChangeLocation })
  await waitFor(() => { expect(change.getAttribute('aria-disabled')).toBe('false') })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.saveResource }))
  await screen.findByRole('alert')
  change.focus(); fireEvent.click(change)
  const picker = screen.getByRole('dialog', { name: zh.libraryFolderDestination })
  expect(picker).toBe(dialog)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(document.activeElement).toBe(within(picker).getByRole('searchbox'))
  await within(picker).findByRole('button', { name: /项目资料/ })
  expect(within(picker).queryByRole('button', { name: zh.libraryNewFolder })).toBeNull()
  const cancelLocation = within(picker).getByRole('button', { name: zh.cancel })
  cancelLocation.focus(); fireEvent.click(cancelLocation)
  expect(document.activeElement).toBe(change)
  expect(within(dialog).getByRole('textbox', { name: zh.libraryName })).toBe(input)
  expect(input.value).toBe('合同模板')
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3])
  fireEvent.click(change)
  fireEvent.click(await within(dialog).findByRole('button', { name: /项目资料/ }))
  await within(dialog).findByText(zh.libraryFoldersEmpty)
  fireEvent.click(within(dialog).getByRole('button', { name: zh.libraryChoose }))
  expect(within(dialog).getByText('我的资料 / 项目资料')).toBeDefined()
  expect(document.activeElement).toBe(change)
  fireEvent.click(within(dialog).getByRole('button', { name: zh.saveResource }))
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.folders.create')).toHaveLength(2) })
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.folders.create').map(([, payload]) => payload)
  expect(writes[0]).toMatchObject({ parentId: null })
  expect(writes[1]).toMatchObject({ parentId: folder.id })
  expect((writes[1] as { key: string }).key).not.toBe((writes[0] as { key: string }).key)
})

it('shows the actual save destination after creating elsewhere even when its refresh fails', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', kind: 'FOLDER', name: '项目资料', sha256: null, mediaType: null, sizeBytes: 0 }
  let saved = false, failRead = true
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.folders.create') { saved = true; return { ...folder, id: '44444444-4444-4444-8444-444444444444', parentId: folder.id, name: '新建目录' } }
    if (saved && failRead) throw new Error('destination read unavailable')
    if (method === 'library.personal.ensure' || method === 'library.get') return personal
    if (method === 'library.entries.get') return folder
    if (method === 'library.entries.list') return page((payload as { parentId: string | null }).parentId === null ? [file.entry, folder] : [])
    return page()
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  await screen.findByRole('button', { name: /^项目资料/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryNewFolder }))
  const dialog = screen.getByRole('dialog', { name: zh.libraryNewFolder })
  fireEvent.change(within(dialog).getByRole('textbox', { name: zh.libraryName }), { target: { value: '新建目录' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.libraryChangeLocation }))
  fireEvent.click(await within(dialog).findByRole('button', { name: /项目资料/ }))
  await within(dialog).findByText(zh.libraryFoldersEmpty)
  fireEvent.click(within(dialog).getByRole('button', { name: zh.libraryChoose }))
  fireEvent.click(within(dialog).getByRole('button', { name: zh.saveResource }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('heading', { name: folder.name })).toBeDefined()
  expect(screen.queryByRole('button', { name: /^产品方案/ })).toBeNull()
  failRead = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('heading', { name: folder.name })).toBeDefined()
  expect(f.read.mock.calls.filter(([method]) => method === 'library.folders.create')).toHaveLength(1)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.list').at(-1))
    .toEqual(['library.entries.list', expect.objectContaining({ parentId: folder.id })])
})

it('clears the previous folder when returning to my root and retries only that destination', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', kind: 'FOLDER', name: '项目资料', sha256: null, mediaType: null, sizeBytes: 0 }
  const child = { ...file.entry, parentId: folder.id, name: '目录内文件.md' }
  let fail = false
  f.read.mockImplementation(async (method, payload) => {
    if (fail) throw new Error('root read unavailable')
    if (method === 'library.personal.ensure' || method === 'library.get') return personal
    if (method === 'library.entries.list') return page((payload as { parentId: string | null }).parentId === null ? [folder] : [child])
    return page()
  })
  const mine = screen.getByRole('button', { name: zh.libraryPersonal })
  fireEvent.click(mine)
  fireEvent.click(await screen.findByRole('button', { name: /^项目资料/ }))
  await screen.findByRole('button', { name: /^目录内文件/ })
  expect(screen.getByRole('heading', { name: folder.name })).toBeDefined()
  fail = true; fireEvent.click(mine)
  await screen.findByRole('alert')
  expect(screen.getByRole('heading', { name: zh.libraryPersonal })).toBeDefined()
  expect(screen.queryByRole('button', { name: /^目录内文件/ })).toBeNull()
  fail = false; fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByRole('button', { name: /^项目资料/ })
  expect(f.read.mock.calls.at(-1)).toEqual(['library.entries.list', expect.objectContaining({ parentId: null })])
})


it('retains independent read and move-opening failures through retries without replacing files or focused errors', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const original = f.read.getMockImplementation()!
  let failRead = true, failWrite = true
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.get') {
      if (failWrite) throw new Error('write offline')
      return personal
    }
    if (failRead) throw new Error('read offline')
    return original(method, input)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  const readNotice = await screen.findByRole('region', { name: zh.libraryLoadFailed })
  fireEvent.click(screen.getByRole('button', { name: /更多操作.*产品方案/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryMove }))
  const writeNotice = await screen.findByRole('region', { name: zh.saveFailed })
  expect(within(readNotice).getByRole('alert').textContent).toBe(zh.libraryLoadFailed)
  expect(within(writeNotice).getByRole('alert').textContent).toBe(zh.saveFailed)
  writeNotice.focus()
  failRead = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await waitFor(() => { expect(screen.queryByRole('region', { name: zh.libraryLoadFailed })).toBeNull() })
  expect(screen.getByRole('region', { name: zh.saveFailed })).toBe(writeNotice)
  expect(document.activeElement).toBe(writeNotice)
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  failWrite = false
  fireEvent.click(screen.getByRole('button', { name: /更多操作.*产品方案/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryMove }))
  await waitFor(() => { expect(screen.queryByRole('region', { name: zh.saveFailed })).toBeNull() })
})

it('shows folders in Mine, enters them and creates children in the displayed directory', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '合同模板', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const child = { ...folder, id: '44444444-4444-4444-8444-444444444444', parentId: folder.id, name: '订单资料' }
  let created = false, fail = true
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, payload) => {
    const input = payload as { parentId?: string; query?: string }
    if (method === 'library.entries.list') {
      if (input.parentId === folder.id) {
        if (fail) throw new Error('directory unavailable')
        return page(created ? [child] : [])
      }
      return page([folder, file.entry].filter(entry => entry.name.includes(input.query ?? '')))
    }
    if (method === 'library.entries.get') return folder
    if (method === 'library.folders.create') { created = true; return child }
    return original(method, payload)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  const folderButton = await screen.findByRole('button', { name: /^合同模板/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox'), upload = screen.getByRole('button', { name: zh.libraryUpload })
  fireEvent.click(folderButton)
  await screen.findByRole('alert')
  const path = screen.getByRole('navigation', { name: zh.libraryPath })
  expect(within(path).getByRole('button', { name: zh.libraryPersonal })).toBeDefined()
  fail = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  await screen.findByText(zh.libraryEmpty)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(screen.getByRole('button', { name: zh.libraryUpload })).toBe(upload)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryNewFolder }))
  const dialog = await screen.findByRole('dialog', { name: zh.libraryNewFolder })
  expect(within(dialog).getByText('个人资料 / 合同模板')).toBeDefined()
  fireEvent.change(within(dialog).getByRole('textbox', { name: zh.libraryName }), { target: { value: child.name } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.saveResource }))
  await screen.findByRole('button', { name: /^订单资料/ })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.folders.create')).toEqual([
    ['library.folders.create', expect.objectContaining({ libraryId: personal.id, parentId: folder.id, name: child.name })],
  ])
  fireEvent.click(within(screen.getByRole('navigation', { name: zh.libraryPath })).getByRole('button', { name: zh.libraryPersonal }))
  await screen.findByRole('button', { name: /^合同模板/ })
  expect(screen.queryByRole('button', { name: /^订单资料/ })).toBeNull()
  expect(screen.getByRole('searchbox')).toBe(search)
})

it('ignores folder reads that settle after returning to the recent file view', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '项目资料', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const late = Promise.withResolvers<unknown>()
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.entries.list') return (payload as { parentId: string | null }).parentId === folder.id ? late.promise : page([folder])
    return original(method, payload)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  fireEvent.click(await screen.findByRole('button', { name: /^项目资料/ }))
  await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('library.entries.list', expect.objectContaining({ parentId: folder.id })) })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryRecent }))
  await screen.findByRole('button', { name: /^产品方案/ })
  await act(async () => { late.resolve(page([{ ...folder, name: '过期文件夹' }])) })
  expect(screen.queryByRole('button', { name: /^过期文件夹/ })).toBeNull()
  expect(screen.queryByRole('navigation', { name: zh.libraryPath })).toBeNull()
})

it.each(['success', 'failure'] as const)('opening a file cancels a pending move opener without a late dialog or error (%s)', async (outcome) => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const late = Promise.withResolvers<unknown>()
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, input) => method === 'library.get' ? late.promise : original(method, input))
  fireEvent.click(screen.getByRole('button', { name: /更多操作.*产品方案/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryMove }))
  await waitFor(() => { expect(f.read).toHaveBeenCalledWith('library.get', { libraryId: personal.id }) })
  fireEvent.click(row)
  const preview = await screen.findByRole('dialog', { name: file.entry.name })
  if (outcome === 'success') await act(async () => { late.resolve(personal) })
  else await act(async () => { late.reject(new Error('obsolete move failure')) })
  expect(screen.getAllByRole('dialog')).toEqual([preview])
  expect(screen.queryByRole('region', { name: zh.saveFailed })).toBeNull()
  fireEvent.click(within(preview).getAllByRole('button', { name: zh.close }).at(-1)!)
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryUpload }))
  expect(await screen.findByRole('dialog', { name: zh.libraryUploadDestination })).toBeDefined()
})

it('removes recent files from another library after creating a folder, including a failed destination read', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const other = { ...file, entry: { ...file.entry, libraryId: '55555555-5555-4555-8555-555555555555', name: '团队文件.md' } }
  f.read.mockResolvedValueOnce(page([other]))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '团队' } })
  await screen.findByRole('button', { name: /^团队文件/ })
  let failRead = true
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '新文件夹', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  f.read.mockImplementation(async (method) => {
    if (method === 'library.personal.ensure' || method === 'library.get') return personal
    if (method === 'library.folders.create') return folder
    if (method === 'library.entries.list') {
      if (failRead) throw new Error('destination offline')
      return page([folder])
    }
    return page([])
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryNewFolder }))
  const form = await screen.findByRole('dialog', { name: zh.libraryNewFolder })
  fireEvent.change(within(form).getByRole('textbox', { name: zh.libraryName }), { target: { value: folder.name } })
  await waitFor(() => { expect(within(form).getByRole('button', { name: zh.saveResource }).getAttribute('aria-disabled')).toBe('false') })
  fireEvent.click(within(form).getByRole('button', { name: zh.saveResource }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  await screen.findByRole('region', { name: zh.libraryLoadFailed })
  expect(screen.getByRole('heading', { name: zh.libraryPersonal })).toBeDefined()
  expect(screen.queryByRole('button', { name: /^团队文件/ })).toBeNull()
  expect(screen.queryByText(zh.libraryEmpty)).toBeNull()
  failRead = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByRole('button', { name: /^新文件夹/ })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.folders.create')).toHaveLength(1)
})

it('refreshes a renamed folder path and reuses the confirmed path while searching its files', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '原目录', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const child = { ...file.entry, parentId: folder.id }
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.entries.list') return page((input as { parentId: string | null }).parentId ? [child] : [folder])
    if (method === 'library.entries.get') return { ...folder, name: '更新后的目录', version: 2 }
    return original(method, input)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  fireEvent.click(await screen.findByRole('button', { name: /^原目录/ }))
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.click(row)
  const preview = await screen.findByRole('dialog', { name: child.name })
  fireEvent.click(within(preview).getAllByRole('button', { name: zh.close }).at(-1)!)
  await screen.findByRole('heading', { name: '更新后的目录' })
  expect(within(screen.getByRole('navigation', { name: zh.libraryPath })).getByRole('button', { name: '更新后的目录' })).toBeDefined()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  fireEvent.change(search, { target: { value: '产品' } })
  search.focus(); search.setSelectionRange(0, 1)
  await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('library.entries.list', expect.objectContaining({ query: '产品' })) })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.get')).toHaveLength(1)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
})
