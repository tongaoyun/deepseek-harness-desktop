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
    <button onClick={() => { props.onCreateFolder() }}>{props.t('libraryNewFolder')}</button>
    <button onClick={() => { props.onMembers?.({ ...personal, scope: 'TEAM', role: 'OWNER' }) }}>管理共享空间成员</button>
    {props.location && <button onClick={() => {
      if (props.location) props.onNavigate({ library: props.location.library, parentId: null }, [])
    }}>当前资料库根目录</button>}
    {props.location && props.trail?.map(entry => <button key={entry.id} aria-label={`Delete sidebar folder: ${entry.name}`}
      onClick={() => {
        const library = props.location?.library
        if (library) props.onEdit?.({ entry, libraryName: library.name, canManage: true, lastAccessedAt: null }, 'delete')
      }}>
      {entry.name}
    </button>)}
  </nav>,
}))
const t = makeTranslate(zh, commonZh)
const timestamp = '2026-11-14T01:00:00Z'
const file = { entry: { id: '22222222-2222-4222-8222-222222222222', libraryId: '11111111-1111-4111-8111-111111111111',
  parentId: null, name: '产品方案.docx', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'application/octet-stream',
  sizeBytes: 5120, version: 1, createdAt: timestamp, updatedAt: timestamp },
libraryName: '个人资料', canManage: true, lastAccessedAt: timestamp, sourceKind: 'CONVERSATION', sourceSessionId: 'source-session' }
const personal = { id: file.entry.libraryId, name: '个人资料', scope: 'PERSONAL',
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
it('applies confirmed permissions before directory failure and keeps cached pages read-only', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '归档', kind: 'FOLDER',
    sha256: null, mediaType: null, sizeBytes: 0 }
  let readonly = false, listing: Promise<unknown> | undefined
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.get' || method === 'library.personal.ensure') return { ...personal, canManage: !readonly }
    if (method === 'library.entries.get') return folder
    if (method === 'library.entries.list') {
      if (listing) return listing
      const parentId = (input as { parentId: string | null }).parentId
      return page(parentId ? [{ ...file.entry, parentId }] : [folder])
    }
    throw new Error(`Unexpected permission operation: ${method}`)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  fireEvent.click(await screen.findByRole('button', { name: /^归档/ }))
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const revoked = Promise.withResolvers<unknown>()
  readonly = true; listing = revoked.promise
  fireEvent.change(search, { target: { value: '方案' } })
  search.focus(); search.setSelectionRange(0, 1)
  await waitFor(() => { expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull() })
  expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull()
  expect(row.closest('[draggable="true"]')).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(document.activeElement).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  await act(async () => { revoked.reject(new Error('directory offline')) })
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  const cachedRead = Promise.withResolvers<unknown>()
  listing = cachedRead.promise
  fireEvent.click(within(screen.getByRole('navigation', { name: zh.libraryPath })).getByRole('button', { name: zh.libraryPersonal }))
  const cachedRow = screen.getByRole('button', { name: /^归档/ })
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull()
  await act(async () => { cachedRead.reject(new Error('root offline')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const recovery = Promise.withResolvers<unknown>()
  listing = recovery.promise
  const before = f.read.mock.calls.filter(([method]) => method === 'library.get').length
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.get')).toHaveLength(before + 1) })
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  await act(async () => { recovery.resolve(page([folder])) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('button', { name: /^归档/ })).toBe(cachedRow)
  expect(document.activeElement).toBe(search)
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(f.read.mock.calls.some(([method]) => method === 'library.entries.update')).toBe(false)
})
it('moves a dragged file once, retains it on failure and separates a successful move from refresh failure', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '归档', kind: 'FOLDER',
    sha256: null, mediaType: null, sizeBytes: 0 }
  let move = Promise.withResolvers<unknown>()
  let moved = false
  f.read.mockImplementation(async (method) => {
    if (method === 'library.get' || method === 'library.personal.ensure') return personal
    if (method === 'library.entries.update') return move.promise
    if (method === 'library.entries.list') {
      if (moved) throw new Error('refresh offline')
      return page([folder, file.entry])
    }
    return page()
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  const destination = await screen.findByRole('button', { name: /^归档/ })
  const source = screen.getByRole('button', { name: /^产品方案/ }), search = screen.getByRole('searchbox')
  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  expect(source.draggable).toBe(true)
  expect(destination.draggable).toBe(true)
  fireEvent.drop(destination, { dataTransfer: transfer })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.update')).toHaveLength(0)
  fireEvent.dragStart(source, { dataTransfer: transfer })
  fireEvent.dragOver(destination, { dataTransfer: transfer })
  expect(destination.closest('li')?.getAttribute('data-library-drop-target')).toBe('true')
  fireEvent.drop(destination, { dataTransfer: transfer }); fireEvent.drop(destination, { dataTransfer: transfer })
  expect(f.read).toHaveBeenCalledWith('library.entries.update', {
    libraryId: personal.id, entryId: file.entry.id, name: file.entry.name, parentId: folder.id, version: file.entry.version,
  })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.update')).toHaveLength(1)
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(source)
  await act(async () => { move.reject(new Error('move failed')) })
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(source)
  move = Promise.withResolvers<unknown>()
  fireEvent.dragStart(source, { dataTransfer: transfer }); fireEvent.drop(destination, { dataTransfer: transfer })
  moved = true
  await act(async () => { move.resolve({ ...file.entry, parentId: folder.id, version: 2 }) })
  const retry = await screen.findByRole('button', { name: zh.retry })
  expect(screen.getByRole('searchbox')).toBe(search)
  f.read.mockImplementation(async method => method === 'library.get' ? personal : page([folder]))
  fireEvent.click(retry)
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.queryByRole('button', { name: /^产品方案/ })).toBeNull()
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.update')).toHaveLength(2)
})
it.each(['row', 'date', 'size', 'actions'])('moves into a folder when dropped on its %s area', async (area) => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '归档', kind: 'FOLDER',
    sha256: null, mediaType: null, sizeBytes: 0 }
  const move = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method) => {
    if (method === 'library.get' || method === 'library.personal.ensure') return personal
    if (method === 'library.entries.update') return move.promise
    return page([folder, file.entry])
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  const destination = await screen.findByRole('button', { name: /^归档/ })
  const row = destination.closest('li')!
  const target = area === 'date' ? row.querySelector('time')!
    : area === 'size' ? within(row).getAllByText('—')[0]!
      : area === 'actions' ? within(row).getByRole('button', { name: /更多操作/ }) : row
  const source = screen.getByRole('button', { name: /^产品方案/ })
  const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  fireEvent.dragStart(source, { dataTransfer: transfer })
  fireEvent.dragOver(target, { dataTransfer: transfer })
  expect(transfer.dropEffect).toBe('move')
  expect(row.getAttribute('data-library-drop-target')).toBe('true')
  fireEvent.drop(target, { dataTransfer: transfer }); fireEvent.drop(target, { dataTransfer: transfer })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.update')).toEqual([
    ['library.entries.update', { libraryId: personal.id, entryId: file.entry.id, name: file.entry.name,
      parentId: folder.id, version: file.entry.version }],
  ])
  expect(destination.draggable).toBe(true)
  expect(row.draggable).toBe(false)
  await act(async () => { move.reject(new Error('move failed')) })
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(source)
  expect(screen.getByRole('button', { name: /^归档/ })).toBe(destination)
})
it('restores a visited directory immediately, revalidates it and retains its rows through failure and retry', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '合同模板', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const child = { ...file.entry, parentId: folder.id }
  let folderRead: Promise<unknown> = Promise.resolve(page([child]))
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.get' || method === 'library.personal.ensure') return personal
    if (method === 'library.entries.get') return folder
    if (method === 'library.entries.list') return (input as { parentId: string | null }).parentId ? folderRead : page([folder])
    return page()
  })
  const search = screen.getByRole('searchbox')
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  fireEvent.click(await screen.findByRole('button', { name: /^合同模板/ }))
  await screen.findByRole('button', { name: /^产品方案/ })
  fireEvent.click(within(screen.getByRole('navigation', { name: zh.libraryPath })).getByRole('button', { name: zh.libraryPersonal }))
  await screen.findByRole('button', { name: /^合同模板/ })
  const gate = Promise.withResolvers<unknown>()
  folderRead = gate.promise
  fireEvent.click(screen.getByRole('button', { name: /^合同模板/ }))
  const row = screen.getByRole('button', { name: /^产品方案/ })
  expect(screen.getByRole('heading', { name: folder.name })).toBeDefined()
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(screen.getByRole('searchbox')).toBe(search)
  await act(async () => { gate.reject(new Error('offline')) })
  const error = await screen.findByRole('alert')
  const retry = screen.getByRole('button', { name: zh.retry })
  const recovery = Promise.withResolvers<unknown>()
  folderRead = recovery.promise
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(screen.getByRole('alert')).toBe(error)
  expect(document.activeElement).toBe(retry)
  await act(async () => { recovery.resolve(page([])) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.queryByRole('button', { name: /^产品方案/ })).toBeNull()
  expect(screen.getByText(zh.libraryEmpty)).toBeDefined()
  expect(document.activeElement).toBe(search)
})

it('invalidates visited directory pages after a confirmed write', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '合同模板', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const child = { ...file.entry, parentId: folder.id }
  const rootRead = Promise.withResolvers<unknown>()
  let renamed = false
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.get' || method === 'library.personal.ensure') return personal
    if (method === 'library.entries.get') return folder
    if (method === 'library.entries.update') { renamed = true; return { ...child, name: '新版.docx', version: 2 } }
    if (method === 'library.entries.list') {
      if ((input as { parentId: string | null }).parentId) return page([{ ...child, name: renamed ? '新版.docx' : child.name }])
      return renamed ? rootRead.promise : page([folder])
    }
    return page()
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  fireEvent.click(await screen.findByRole('button', { name: /^合同模板/ }))
  fireEvent.click(await screen.findByRole('button', { name: /更多操作.*产品方案/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryRename }))
  const dialog = screen.getByRole('dialog')
  fireEvent.change(within(dialog).getByRole('textbox', { name: zh.libraryName }), { target: { value: '新版.docx' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.saveResource }))
  await screen.findByRole('button', { name: /^新版/ })
  fireEvent.click(within(screen.getByRole('navigation', { name: zh.libraryPath })).getByRole('button', { name: zh.libraryPersonal }))
  expect(screen.queryByRole('button', { name: /^合同模板/ })).toBeNull()
  expect(screen.getByRole('status', { name: zh.loading }).querySelector('svg')).toBeNull()
  expect(screen.queryByText(zh.libraryEmpty)).toBeNull()
  await act(async () => { rootRead.resolve(page([{ ...folder, name: '更新后的目录', version: 2 }])) })
  await screen.findByRole('button', { name: /^更新后的目录/ })
})
it('retains controls, rows, selection and errors through refresh failure and retry', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  fireEvent.change(search, { target: { value: '产品' } })
  await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('library.files.list', expect.objectContaining({ query: '产品' })) })
  search.focus(); search.setSelectionRange(0, 1)
  expect(screen.queryByRole('group', { name: '显示方式' })).toBeNull()
  expect(screen.queryByRole('button', { name: '网格' })).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(document.activeElement).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  const gate = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => gate.promise)
  fireEvent.change(search, { target: { value: '产品方案' } })
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
  await act(async () => { retryGate.resolve(page()) })
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('产品方案')
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

it('keeps read-only shared files visible without an empty actions menu', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  f.read.mockResolvedValueOnce(page([{ ...file, canManage: false }]))
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '产品' } })
  await waitFor(() => { expect(screen.queryByRole('button', { name: /更多操作.*产品方案/ })).toBeNull() })
  const row = screen.getByRole('button', { name: /^产品方案/ })
  search.focus(); search.setSelectionRange(0, 1)
  expect(screen.queryByRole('group', { name: '显示方式' })).toBeNull()
  expect(screen.queryByRole('button', { name: '网格' })).toBeNull()
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
  await act(async () => { gate.resolve({ id: file.entry.libraryId, name: '个人资料', scope: 'PERSONAL',
    ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.libraryUpload }))
  expect(screen.getByRole('dialog', { name: zh.libraryUpload })).toBeDefined()
})

it('keeps search and selection while confirming files for a different navigation view', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const navigation = screen.getByRole('navigation', { name: zh.libraryNavigation })
  expect(within(navigation).getAllByRole('button').map(button => button.textContent))
    .toEqual([zh.libraryRecent, zh.libraryPersonal, zh.libraryNewFolder, '管理共享空间成员'])
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
  expect(row.isConnected).toBe(false)
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBeDefined()
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
  const library = { id: file.entry.libraryId, name: '个人资料', scope: 'PERSONAL',
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
  await waitFor(() => { expect(f.read).toHaveBeenCalledWith('library.personal.ensure', {}) })
  expect(screen.queryByText('保存位置')).toBeNull()
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
  const library = { id: file.entry.libraryId, name: '我的资料', scope: 'PERSONAL',
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


it('retains the current directory after folder creation even when its refresh fails', async () => {
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
  fireEvent.click(await screen.findByRole('button', { name: /^项目资料/ }))
  fireEvent.click(screen.getByRole('button', { name: zh.libraryNewFolder }))
  const dialog = screen.getByRole('dialog', { name: zh.libraryNewFolder })
  fireEvent.change(within(dialog).getByRole('textbox', { name: zh.libraryName }), { target: { value: '新建目录' } })
  expect(within(dialog).queryByText('保存位置')).toBeNull()
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
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '产品' } })
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
  expect(within(dialog).queryByText('个人资料 / 合同模板')).toBeNull()
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
  expect(screen.getByRole('navigation', { name: zh.libraryPath }).textContent).toBe(zh.libraryRecent)
})

it('isolates a directory from recent files while loading, failing and retrying without replacing the search control', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '目录专属文件夹', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const original = f.read.getMockImplementation()!
  let recent = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.entries.list') return page([folder])
    if (method === 'library.files.list') return recent.promise
    return original(method, payload)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  await screen.findByRole('button', { name: /^目录专属文件夹/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  search.focus(); search.setSelectionRange(0, 0)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryRecent }))
  expect(screen.queryByRole('button', { name: /^目录专属文件夹/ })).toBeNull()
  expect(screen.queryByText(zh.libraryEmpty)).toBeNull()
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
  await act(async () => { recent.reject(new Error('recent unavailable')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  expect(screen.queryByRole('button', { name: /^目录专属文件夹/ })).toBeNull()
  expect(screen.queryByText(zh.libraryEmpty)).toBeNull()
  recent = Promise.withResolvers<unknown>()
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.list')).toHaveLength(3)
  await act(async () => { recent.resolve(page([file])) })
  await screen.findByRole('button', { name: /^产品方案/ })
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
  expect(screen.queryByRole('button', { name: /^目录专属文件夹/ })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([false, true])('keeps other libraries out of My files during a failed root read, with a confirmed personal cache: %s', async (cached) => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const other = { ...file, entry: { ...file.entry, libraryId: '55555555-5555-4555-8555-555555555555', name: '团队专属.md' } }
  const rootEntry = { ...file.entry, name: '已确认个人文件.md' }
  let rootRead: Promise<unknown> = Promise.resolve(personal)
  f.read.mockImplementation(async (method) => {
    if (method === 'library.get' || method === 'library.personal.ensure') return rootRead
    if (method === 'library.files.list') return page([other])
    if (method === 'library.entries.list') return page([rootEntry])
    return page()
  })
  const mine = screen.getByRole('button', { name: zh.libraryPersonal }), search = screen.getByRole<HTMLInputElement>('searchbox')
  if (cached) {
    fireEvent.click(mine)
    await screen.findByRole('button', { name: /^已确认个人文件/ })
    fireEvent.click(screen.getByRole('button', { name: zh.libraryRecent }))
  } else {
    fireEvent.change(search, { target: { value: '团队' } })
    await screen.findByRole('button', { name: /^团队专属/ })
    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() => { expect(screen.getAllByRole('region', { name: zh.libraryFiles }).find(node => node.hasAttribute('aria-busy'))?.getAttribute('aria-busy')).toBe('false') })
  }
  await screen.findByRole('button', { name: /^团队专属/ })
  const gate = Promise.withResolvers<unknown>()
  rootRead = gate.promise
  search.focus(); fireEvent.click(mine)
  expect(screen.queryByRole('button', { name: /^团队专属/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /^已确认个人文件/ }) !== null).toBe(cached)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
  await act(async () => { gate.reject(new Error('root unavailable')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  expect(screen.queryByRole('button', { name: /^团队专属/ })).toBeNull()
  expect(screen.queryByText(zh.libraryEmpty)).toBeNull()
  const recovery = Promise.withResolvers<unknown>()
  rootRead = recovery.promise
  const reads = () => f.read.mock.calls.filter(([method]) => method === 'library.get' || method === 'library.personal.ensure').length
  const before = reads()
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(reads()).toBe(before + 1)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  await act(async () => { recovery.resolve(personal) })
  await screen.findByRole('button', { name: /^已确认个人文件/ })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.queryByRole('button', { name: /^团队专属/ })).toBeNull()
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
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

it.each([1, 2])('applies revoked move-preflight permissions at version %i across an older recent-file response', async (version) => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const olderFiles = Promise.withResolvers<unknown>(), metadata = Promise.withResolvers<unknown>()
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.files.list') return olderFiles.promise
    if (method === 'library.get') return metadata.promise
    return original(method, payload)
  })
  fireEvent.change(search, { target: { value: '产品' } }); search.setSelectionRange(0, 1)
  const actions = screen.getByRole('button', { name: /更多操作.*产品方案/ })
  actions.focus(); fireEvent.click(actions)
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryMove }))
  const revoked = { ...personal, scope: 'TEAM', name: '项目共享空间', role: 'VIEWER', canManage: false, version }
  await act(async () => { metadata.resolve(revoked) })
  await waitFor(() => { expect(screen.queryByRole('button', { name: /更多操作.*产品方案/ })).toBeNull() })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(row.draggable).toBe(false)
  expect(row.textContent).toContain(revoked.name)
  expect(screen.getByRole('region', { name: zh.saveFailed }).textContent).toContain(zh.libraryManageDenied)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  await act(async () => { olderFiles.resolve(page()) })
  expect(screen.queryByRole('button', { name: /更多操作.*产品方案/ })).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(row.draggable).toBe(false)
  expect(row.textContent).toContain(revoked.name)
  expect(f.read.mock.calls.some(([method]) => method === 'library.entries.update')).toBe(false)
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

it.each([true, false])('renames the current folder through its title only when editable: %s', async (canManage) => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  let folder = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '原目录', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
  const child = { ...file.entry, parentId: folder.id }
  const original = f.read.getMockImplementation()!
  let saving = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.get' || method === 'library.personal.ensure') return { ...personal, canManage }
    if (method === 'library.entries.list') return page((input as { parentId: string | null }).parentId ? [child] : [folder])
    if (method === 'library.entries.get') return folder
    if (method === 'library.entries.update') return saving.promise
    return original(method, input)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  fireEvent.click(await screen.findByRole('button', { name: /^原目录/ }))
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const search = screen.getByRole('searchbox')
  if (!canManage) {
    expect(screen.queryByRole('button', { name: `${zh.libraryRename}: 原目录` })).toBeNull()
    return
  }
  const trigger = screen.getByRole('button', { name: `${zh.libraryRename}: 原目录` })
  trigger.focus(); fireEvent.click(trigger)
  const dialog = await screen.findByRole('dialog', { name: zh.libraryRename })
  const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  fireEvent.change(name, { target: { value: '更新后的目录' } })
  const save = within(dialog).getByRole('button', { name: zh.saveResource })
  fireEvent.click(save); fireEvent.click(save)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.update')).toHaveLength(1)
  await act(async () => { saving.reject(new Error('rename offline')) })
  await within(dialog).findByRole('alert')
  expect(within(dialog).getByRole('textbox', { name: zh.libraryName })).toBe(name)
  expect(name.value).toBe('更新后的目录')
  saving = Promise.withResolvers<unknown>()
  fireEvent.click(save)
  folder = { ...folder, name: '更新后的目录', version: 2 }
  await act(async () => { saving.resolve(folder) })
  await screen.findByRole('heading', { name: folder.name })
  expect(screen.getByRole('button', { name: `${zh.libraryRename}: ${folder.name}` })).toBe(trigger)
  expect(within(screen.getByRole('navigation', { name: zh.libraryPath })).getByRole('button', { name: folder.name })).toBeDefined()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(trigger)
  expect(f.read).toHaveBeenCalledWith('library.entries.update', expect.objectContaining({ entryId: folder.id, version: 1, name: folder.name }))
})

it('retains the open descendant on failed ancestor deletion and returns to the surviving parent after retry', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const ancestor = { ...file.entry, id: '33333333-3333-4333-8333-333333333333', name: '父目录', kind: 'FOLDER',
    mediaType: null, sha256: null, sizeBytes: 0 }
  const child = { ...ancestor, id: '44444444-4444-4444-8444-444444444444', parentId: ancestor.id, name: '子目录' }
  let deleted = false, fail = true
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.personal.ensure' || method === 'library.get') return personal
    if (method === 'library.entries.get') {
      if (deleted) throw new Error('Deleted folder cannot be read')
      return input && typeof input === 'object' && 'entryId' in input && input.entryId === child.id ? child : ancestor
    }
    if (method === 'library.entries.delete') {
      if (fail) throw new Error('Delete failed')
      deleted = true
      return {}
    }
    if (method === 'library.entries.list') {
      const parentId = input && typeof input === 'object' && 'parentId' in input ? input.parentId : null
      if (deleted) { expect(parentId).toBeNull(); return page([]) }
      return page(parentId === null ? [ancestor] : parentId === ancestor.id ? [child] : [])
    }
    return page()
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  fireEvent.click(await screen.findByRole('button', { name: /^父目录/ }))
  fireEvent.click(await screen.findByRole('button', { name: /^子目录/ }))
  await screen.findByRole('heading', { name: child.name })
  const trigger = screen.getByRole('button', { name: `Delete sidebar folder: ${ancestor.name}` })
  trigger.focus(); fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: zh.deleteResource })
  const submit = within(dialog).getByRole('button', { name: zh.deleteResource })
  fireEvent.click(submit)
  await within(dialog).findByRole('alert')
  expect(screen.getByRole('heading', { name: child.name })).toBeDefined()
  fail = false
  fireEvent.click(submit); fireEvent.click(submit)
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  await waitFor(() => { expect(screen.getByText(zh.libraryEmpty)).toBeDefined() })
  expect(screen.queryByRole('heading', { name: child.name })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.delete')).toHaveLength(2)
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})

it('retains member-dialog permissions when closing into an unavailable directory refresh', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  await screen.findByRole('button', { name: /更多操作/ })
  const team = { ...personal, scope: 'TEAM', name: '共享空间' }
  f.read.mockImplementation(async method => method === 'library.get' ? team : page([file.entry]))
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '方案' } })
  const members = await screen.findByRole('button', { name: zh.libraryMemberList })
  const row = screen.getByRole('button', { name: /^产品方案/ })
  const latest = { ...team, name: '更新后的共享空间', role: 'VIEWER', canManage: false }
  f.read.mockImplementation(async (method) => {
    if (method === 'library.get') return latest
    throw new Error('Member list unavailable')
  })
  members.focus(); fireEvent.click(members)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('alert')
  const metadata = Promise.withResolvers<unknown>()
  f.read.mockImplementation(() => metadata.promise)
  const readsBeforeClose = f.read.mock.calls.length
  fireEvent.click(within(dialog).getAllByRole('button', { name: commonZh.close }).at(-1)!)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull()
  expect(row.closest('[draggable="true"]')).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(row.textContent).toContain(latest.name)
  expect(search.value).toBe('方案')
  expect(document.activeElement).toBe(members)
  expect(f.read.mock.calls).toHaveLength(readsBeforeClose)
  fireEvent.change(search, { target: { value: '产品' } })
  await act(async () => { metadata.reject(new Error('Directory unavailable')) })
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
})

it('retains member-confirmed permissions when an older recent-file response finishes afterward', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const listing = Promise.withResolvers<unknown>()
  const latest = { ...personal, scope: 'TEAM', name: '最新共享空间', role: 'VIEWER', canManage: false, version: 2 }
  f.read.mockImplementation(async (name) => {
    if (name === 'library.files.list') return listing.promise
    if (name === 'library.get') return latest
    throw new Error('Member list unavailable')
  })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '产品' } })
  const members = screen.getByRole('button', { name: '管理共享空间成员' })
  members.focus(); fireEvent.click(members)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('alert')
  expect(row.textContent).toContain(latest.name)
  await act(async () => { listing.resolve(page()) })
  fireEvent.click(within(dialog).getAllByRole('button', { name: commonZh.close }).at(-1)!)
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(row.textContent).toContain(latest.name)
  expect(row.closest('[draggable="true"]')).toBeNull()
  expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull()
  expect(document.activeElement).toBe(members)
})

it.each(['metadata', 'entries', 'newer-metadata'] as const)('reconciles confirmed metadata when a directory %s read finishes afterward', async (stage) => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  await screen.findByRole('button', { name: /更多操作/ })
  const team = { ...personal, scope: 'TEAM', name: '共享空间' }
  f.read.mockImplementation(async name => name === 'library.get' ? team : page([file.entry]))
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '方案' } })
  const members = await screen.findByRole('button', { name: zh.libraryMemberList })
  const row = screen.getByRole('button', { name: /^产品方案/ })
  const metadata = Promise.withResolvers<unknown>()
  const latest = { ...team, name: '最新共享空间', role: 'VIEWER', canManage: false, version: 2 }
  const newest = { ...latest, name: '再次更新的共享空间', version: 3 }
  const expected = stage === 'newer-metadata' ? newest : latest
  let reads = 0, entriesPending = false
  f.read.mockImplementation(async (name) => {
    if (name === 'library.get') return ++reads === 1 ? stage === 'entries' ? team : metadata.promise : latest
    if (name === 'library.entries.list' && stage === 'entries') { entriesPending = true; return metadata.promise }
    throw new Error('Member list unavailable')
  })
  fireEvent.change(search, { target: { value: '产品' } })
  await waitFor(() => { expect(reads).toBe(1) })
  if (stage === 'entries') await waitFor(() => { expect(entriesPending).toBe(true) })
  members.focus(); fireEvent.click(members)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('alert')
  await waitFor(() => { expect(row.textContent).toContain(latest.name) })
  f.read.mockImplementation(async name => name === 'library.entries.list' ? page([file.entry]) : latest)
  await act(async () => { metadata.resolve(stage === 'entries' ? page([file.entry]) : stage === 'newer-metadata' ? newest : team) })
  fireEvent.click(within(dialog).getAllByRole('button', { name: commonZh.close }).at(-1)!)
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(row.textContent).toContain(expected.name)
  expect(row.closest('[draggable="true"]')).toBeNull()
  expect(document.activeElement).toBe(members)
})

it.each(['button', 'escape', 'older-confirmed'] as const)('does not restore stale member metadata on %s close after a newer directory read', async (method) => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  await screen.findByRole('button', { name: /更多操作/ })
  const team = { ...personal, scope: 'TEAM', name: '共享空间' }
  f.read.mockImplementation(async name => name === 'library.get' ? team : page([file.entry]))
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '方案' } })
  const members = await screen.findByRole('button', { name: zh.libraryMemberList })
  const row = screen.getByRole('button', { name: /^产品方案/ })
  const metadata = Promise.withResolvers<unknown>()
  const memberMetadata = Promise.withResolvers<unknown>()
  let reads = 0
  f.read.mockImplementation(async (name) => {
    if (name === 'library.get') {
      if (++reads === 1) return metadata.promise
      if (method === 'older-confirmed') return memberMetadata.promise
      throw new Error('Member metadata unavailable')
    }
    return page([file.entry])
  })
  fireEvent.change(search, { target: { value: '产品' } })
  await waitFor(() => { expect(reads).toBe(1) })
  members.focus(); fireEvent.click(members)
  const dialog = await screen.findByRole('dialog')
  if (method === 'older-confirmed') await waitFor(() => { expect(reads).toBe(2) })
  else await within(dialog).findByRole('alert')
  const latest = { ...team, name: '最新共享空间', role: 'VIEWER', canManage: false, version: 2 }
  await act(async () => { metadata.resolve(latest) })
  await waitFor(() => { expect(row.textContent).toContain(latest.name) })
  if (method === 'older-confirmed') {
    await act(async () => { memberMetadata.resolve(team) })
    await within(dialog).findByRole('alert')
    expect(row.textContent).toContain(latest.name)
    expect(within(dialog).queryByRole('button', { name: zh.libraryInvite })).toBeNull()
  }
  const readsBeforeClose = reads
  if (method !== 'escape') fireEvent.click(within(dialog).getAllByRole('button', { name: commonZh.close }).at(-1)!)
  else fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(screen.queryByRole('button', { name: /更多操作/ })).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(row.textContent).toContain(latest.name)
  expect(row.closest('[draggable="true"]')).toBeNull()
  expect(search.value).toBe('产品')
  expect(document.activeElement).toBe(members)
  expect(reads).toBe(readsBeforeClose)
})

it.each([false, true])('retains the current root search rows and errors when clearing its query with expired cache=%s', async (expired) => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryPersonal }))
  await screen.findByRole('button', { name: /^产品方案/ })
  const latest = { ...file.entry, name: '产品方案-已更新.docx', version: 2 }
  let metadata: Promise<unknown> | undefined, failList = false
  f.read.mockImplementation(async (method) => {
    if (method === 'library.get') return metadata ?? personal
    if (method === 'library.entries.list') {
      if (failList) throw new Error('目录读取失败')
      return page([latest])
    }
    throw new Error(`Unexpected root navigation operation: ${method}`)
  })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '产品' } })
  const row = await screen.findByRole('button', { name: /^产品方案-已更新/ })
  if (expired) {
    fireEvent.click(row)
    const preview = await screen.findByRole('dialog', { name: latest.name })
    fireEvent.click(within(preview).getAllByRole('button', { name: commonZh.close }).at(-1)!)
    await waitFor(() => { expect(row.closest('[role="region"]')?.getAttribute('aria-busy')).toBe('false') })
  }
  failList = true
  fireEvent.change(search, { target: { value: '方案' } })
  const alert = await screen.findByRole('alert')
  const pending = Promise.withResolvers<unknown>()
  metadata = pending.promise
  const root = screen.getByRole('button', { name: '当前资料库根目录' })
  root.focus(); fireEvent.click(root)
  expect(screen.getByRole('button', { name: /^产品方案-已更新/ })).toBe(row)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('')
  expect(document.activeElement).toBe(root)
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => { pending.reject(new Error('库信息读取失败')) })
  const retry = await screen.findByRole('button', { name: zh.retry })
  const retryRead = Promise.withResolvers<unknown>()
  metadata = retryRead.promise
  const before = f.read.mock.calls.filter(([method]) => method === 'library.get').length
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.get')).toHaveLength(before + 1) })
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: /^产品方案-已更新/ })).toBe(row)
  expect(document.activeElement).toBe(retry)
  failList = false
  await act(async () => { retryRead.resolve(personal) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('button', { name: /^产品方案-已更新/ })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
})
