// @vitest-environment jsdom
/** Authorized product metadata composed with the real native file-tree Factory. */
import { useState } from 'react'
import { act, fireEvent, within, waitFor } from '@testing-library/react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTree } from '@deepseek-ai/dsh-client-ui-sidebar-files/src/client/FileTree.tsx'
import { zh as treeZh } from '@deepseek-ai/dsh-client-ui-sidebar-files/src/client/locales.ts'
import { LibrarySidebar } from '../src/client/LibrarySidebar.tsx'
import type { LibraryDragProps } from '../src/client/useLibraryDrag.ts'
import type { LibraryLocation } from '../src/client/LibraryBrowser.tsx'
import type { Library, LibraryEntry } from '@deepseek-harness/product/library'
import { zh } from '../src/locales.ts'
const t = makeTranslate(zh)
const timestamp = '2026-11-16T01:00:00Z'
const personal = { id: '11111111-1111-4111-8111-111111111111', name: '个人资料', scope: 'PERSONAL',
  ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp } as const
const shared = { ...personal, id: '22222222-2222-4222-8222-222222222222', name: '设计部门', scope: 'TEAM', role: 'VIEWER', canManage: false } as const
const folder = { id: '33333333-3333-4333-8333-333333333333', libraryId: personal.id, parentId: null, name: '合同模板',
  kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0, version: 1, createdAt: timestamp, updatedAt: timestamp } as const
const file = { ...folder, id: '44444444-4444-4444-8444-444444444444', name: '说明.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 24 } as const
function page(data: readonly unknown[], pageIndex = 1, totalPages = 1) {
  return { data, pageIndex, pageSize: 50, totalCount: totalPages * 50, totalPages }
}
async function fixture(dragProps?: LibraryDragProps, initialCatalog?: Promise<unknown>) {
  const read = vi.fn(async (method: string, input: { libraryId?: string; parentId?: string | null; page?: number }): Promise<unknown> => {
    if (method === 'library.list') return initialCatalog ?? page([personal, shared])
    return page(input.libraryId === personal.id && input.parentId === null ? [folder, file] : [])
  })
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, input: Parameters<typeof read>[1]) => ({
      ok: true, result: await read(method, input),
    }),
    cancel: vi.fn(), subscribe: () => () => {},
  } })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const localeRevision = { revision: 0 }
  runtime.slots.installLocale({ getSnapshot: () => localeRevision, subscribe: () => () => {}, bind: () => makeTranslate(treeZh) })
  runtime.slots.registerFactory({ name: 'sidebar.files.tree', scope: 'root', locale: 'sidebarFiles', slots: { accessory: { scope: 'root' } } }, FileTree)
  const navigate = vi.fn(), open = vi.fn(), create = vi.fn(), upload = vi.fn(), generate = vi.fn(), edit = vi.fn()
  let refresh = () => {}
  let confirmLocation = (_location: LibraryLocation | undefined) => {}
  let confirmMetadata = (_library: Library) => {}
  await runtime.root.declare({}, function Root({ renderFactorySlot }: PropsRenderFactories) {
    const [revision, update] = useState(0)
    const [currentView, setView] = useState<'recent' | 'mine'>('recent')
    const [location, setLocation] = useState<LibraryLocation>()
    const [confirmedLibrary, setConfirmedLibrary] = useState<Library>()
    const [trail, setTrail] = useState<readonly LibraryEntry[]>([])
    refresh = () => { update(value => value + 1) }
    confirmLocation = (next) => { setView(next ? 'mine' : 'recent'); setLocation(next) }
    confirmMetadata = setConfirmedLibrary
    return <><input aria-label="outside" /><LibrarySidebar t={t} view={currentView} revision={revision} renderFactorySlot={renderFactorySlot}
      {...(location ? { location } : {})} {...(dragProps ? { dragProps } : {})} trail={trail}
      {...(confirmedLibrary ? { confirmedLibrary } : {})}
      onView={(value) => { setView(value); if (value === 'mine') { setLocation(undefined); setTrail([]) } }}
      onNavigate={(next, ancestors) => { navigate(next, ancestors); setView('mine'); setLocation(next); setTrail(ancestors) }}
      onOpen={open} onEdit={edit} onCreateFolder={create} onUpload={upload} onGenerate={generate} /></>
  })
  const view = runtime.renderRoot()
  if (!initialCatalog) await act(async () => { await read.mock.results[0]?.value })
  return { read, view, navigate, open, create, upload, generate, edit, refresh: () => { refresh() },
    confirmMetadata: (library: Library) => { confirmMetadata(library) },
    confirmLocation: (location?: LibraryLocation) => { confirmLocation(location) } }
}

it.each([1, 2])('retains metadata confirmed at version %i before the initial library catalog arrives', async (version) => {
  const initial = Promise.withResolvers<unknown>()
  const f = await fixture(undefined, initial.promise)
  const revoked = { ...shared, name: '只读共享空间', version }
  act(() => { f.confirmMetadata(revoked) })
  await act(async () => { initial.resolve(page([personal, { ...shared, role: 'EDITOR', canManage: true }])) })
  await f.view.findByRole('button', { name: revoked.name })
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${revoked.name}` })).toBeNull()
  expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(1)
})

it.each([1, 2])('updates an unselected library at version %i without a late catalog reply restoring its permissions', async (version) => {
  const f = await fixture()
  const root = await f.view.findByRole('button', { name: shared.name })
  const original = f.read.getMockImplementation()!
  const editable = { ...shared, role: 'EDITOR' as const, canManage: true, version }
  act(() => { f.confirmMetadata(editable) })
  await f.view.findByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })
  const stale = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method, input) => method === 'library.list' ? stale.promise : original(method, input))
  act(() => { f.refresh() })
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(2) })
  const revoked = { ...shared, name: '只读共享空间', version }
  const outside = f.view.getByRole('textbox', { name: 'outside' })
  outside.focus()
  act(() => { f.confirmMetadata(revoked) })
  expect(f.view.getByRole('button', { name: revoked.name })).toBe(root)
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${revoked.name}` })).toBeNull()
  expect(document.activeElement).toBe(outside)
  await act(async () => { stale.resolve(page([personal, editable])) })
  expect(f.view.getByRole('button', { name: revoked.name })).toBe(root)
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  act(() => { f.confirmLocation({ library: personal, parentId: null }) })
  act(() => { f.confirmLocation() })
  expect(f.view.getByRole('button', { name: revoked.name })).toBe(root)
  f.read.mockImplementation(async (method, input) => method === 'library.list' ? page([personal, editable]) : original(method, input))
  act(() => { f.refresh() })
  await f.view.findByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })
  expect(f.view.getByRole('button', { name: shared.name })).toBe(root)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(3)
})

it('uses the newest confirmed library permissions without remounting its tree or rereading the catalog', async () => {
  const f = await fixture()
  const root = await f.view.findByRole('button', { name: shared.name })
  const original = f.read.getMockImplementation()!
  const editable = { ...shared, role: 'EDITOR' as const, canManage: true, version: 2 }
  act(() => { f.confirmLocation({ library: editable, parentId: null }) })
  const add = await f.view.findByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })
  expect(f.view.getByRole('button', { name: shared.name })).toBe(root)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(1)
  fireEvent.click(add)
  fireEvent.click(within(await f.view.findByRole('menu')).getByRole('menuitem', { name: zh.libraryNewFolder }))
  expect(f.create).toHaveBeenLastCalledWith({ library: editable, parentId: null })
  const newer = { ...editable, version: 3 }
  f.read.mockImplementation(async (method, input) => method === 'library.list' ? page([personal, newer]) : original(method, input))
  act(() => { f.refresh() })
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(2) })
  act(() => { f.confirmLocation({ library: { ...shared, version: 2 }, parentId: null }) })
  expect(f.view.getByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBe(add)
  root.focus()
  act(() => { f.confirmLocation({ library: { ...shared, version: 4 }, parentId: null }) })
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  expect(f.view.getByRole('button', { name: shared.name })).toBe(root)
  expect(document.activeElement).toBe(root)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(2)
  act(() => { f.confirmLocation() })
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  act(() => { f.refresh() })
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(3) })
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  expect(f.view.getByRole('button', { name: shared.name })).toBe(root)
})

it('retains same-version permission changes and rejects catalog replies started before their confirmation', async () => {
  const f = await fixture()
  const root = await f.view.findByRole('button', { name: shared.name })
  const original = f.read.getMockImplementation()!
  const editable = { ...shared, role: 'EDITOR' as const, canManage: true }
  act(() => { f.confirmLocation({ library: editable, parentId: null }) })
  const add = await f.view.findByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })
  act(() => { f.confirmLocation() })
  expect(f.view.getByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBe(add)
  const stale = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method, input) => method === 'library.list' ? stale.promise : original(method, input))
  act(() => { f.refresh() })
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(2) })
  act(() => { f.confirmLocation({ library: shared, parentId: null }) })
  act(() => { f.confirmLocation() })
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  await act(async () => { stale.resolve(page([personal, editable])) })
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  act(() => { f.confirmLocation({ library: shared, parentId: null }) })
  f.read.mockImplementation(async (method, input) => method === 'library.list' ? page([personal, editable]) : original(method, input))
  act(() => { f.refresh() })
  await f.view.findByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })
  expect(f.view.getByRole('button', { name: shared.name })).toBe(root)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(3)
})
it('expands the native tree lazily, retains nodes on collapse and opens files through existing previews', async () => {
  const f = await fixture()
  const parent = await f.view.findByRole('button', { name: folder.name })
  const fileButton = f.view.getByRole('button', { name: file.name })
  fireEvent.click(fileButton)
  expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ entry: file, canManage: true }))
  expect(f.read.mock.calls.some(([method, input]) => method === 'library.entries.list' && input.libraryId === shared.id)).toBe(true)
  fireEvent.click(parent)
  await waitFor(() => { expect(f.read).toHaveBeenCalledWith('library.entries.list', expect.objectContaining({ parentId: folder.id })) })
  expect(parent.getAttribute('aria-expanded')).toBe('true')
  expect(f.navigate).toHaveBeenLastCalledWith({ library: personal, parentId: folder.id, parentName: folder.name }, [folder])
  fireEvent.click(f.view.getByRole('button', { name: zh.libraryRecent }))
  parent.focus()
  fireEvent.click(parent)
  expect(parent.getAttribute('aria-expanded')).toBe('true')
  expect(parent.getAttribute('aria-current')).toBe('page')
  expect(document.activeElement).toBe(parent)
  expect(f.navigate).toHaveBeenCalledTimes(2)
  fireEvent.click(parent)
  expect(parent.getAttribute('aria-expanded')).toBe('false')
  const reads = f.read.mock.calls.length
  fireEvent.click(parent)
  expect(f.read.mock.calls).toHaveLength(reads)
  expect(f.view.getByRole('button', { name: file.name })).toBe(fileButton)
  await waitFor(() => { expect(f.read).toHaveBeenCalledWith('library.entries.list', expect.objectContaining({ libraryId: shared.id, parentId: null })) })
  fireEvent.click(f.view.getByRole('button', { name: shared.name }))
  expect(f.navigate).toHaveBeenLastCalledWith({ library: shared, parentId: null }, [])
  fireEvent.click(f.view.getByRole('button', { name: zh.libraryRecent }))
  const sharedRoot = f.view.getByRole('button', { name: shared.name })
  fireEvent.click(sharedRoot)
  expect(sharedRoot.getAttribute('aria-current')).toBe('page')
  fireEvent.click(sharedRoot)
})
it('retries the exact failed pagination request and retains files, errors and focus while waiting', async () => {
  const f = await fixture()
  const first = await f.view.findByRole('button', { name: file.name })
  const original = f.read.getMockImplementation()!
  const extra = { ...file, id: '55555555-5555-4555-8555-555555555555', name: '补充.md' }
  let fail = true
  const pending = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.entries.list' && input.libraryId === personal.id && input.parentId === null) {
      if (input.page === 1) return page([folder, file], 1, 2)
      if (fail) throw new Error('page unavailable')
      return pending.promise
    }
    return original(method, input)
  })
  act(() => { f.refresh() })
  const more = await f.view.findByRole('button', { name: zh.libraryMore })
  fireEvent.click(more)
  const error = await f.view.findByText(zh.libraryLoadFailed)
  const retry = f.view.getByRole('button', { name: zh.retry })
  retry.focus(); fail = false; fireEvent.click(retry); fireEvent.click(retry)
  expect(f.view.getByText(zh.libraryLoadFailed)).toBe(error)
  expect(document.activeElement).toBe(retry)
  expect(f.view.getByRole('button', { name: file.name })).toBe(first)
  expect(f.read.mock.calls.filter(([method, input]) => method === 'library.entries.list' && input.page === 2)).toHaveLength(2)
  await act(async () => { pending.resolve(page([extra], 2, 2)) })
  expect(f.view.getByRole('button', { name: extra.name })).toBeDefined()
  expect(f.view.getByRole('button', { name: file.name })).toBe(first)
  expect(document.activeElement).toBe(f.view.getByRole('button', { name: zh.libraryPersonal }))
  const retained = f.view.getByRole('button', { name: extra.name })
  const reread = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.entries.list' && input.libraryId === personal.id && input.parentId === null) {
      return input.page === 1 ? page([folder, file], 1, 2) : reread.promise
    }
    return original(method, input)
  })
  retained.focus()
  act(() => { f.refresh() })
  await waitFor(() => { expect(f.read.mock.calls.filter(([method, input]) => method === 'library.entries.list' && input.page === 2)).toHaveLength(3) })
  expect(f.view.getByRole('button', { name: extra.name })).toBe(retained)
  await act(async () => { reread.resolve(page([extra], 2, 2)) })
  expect(f.view.getByRole('button', { name: extra.name })).toBe(retained)
  expect(document.activeElement).toBe(retained)
})
it('revalidates a collapsed directory after a write while preserving its cached rows through failure and retry', async () => {
  const f = await fixture()
  const parent = await f.view.findByRole('button', { name: folder.name })
  const original = f.read.getMockImplementation()!
  const nested = { ...file, parentId: folder.id, name: '原有资料.md' }
  const added = { ...nested, id: '55555555-5555-4555-8555-555555555555', name: '新上传资料.md' }
  let changed = false, fail = true
  const retryRead = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method, input) => {
    if (method !== 'library.entries.list' || input.parentId !== folder.id) return original(method, input)
    if (!changed) return page([nested])
    if (fail) throw new Error('Directory revalidation unavailable')
    return retryRead.promise
  })
  fireEvent.click(parent)
  await f.view.findByRole('button', { name: nested.name })
  fireEvent.click(parent)
  expect(parent.getAttribute('aria-expanded')).toBe('false')
  const reads = f.read.mock.calls.filter(([, input]) => input.parentId === folder.id).length
  changed = true
  act(() => { f.refresh() })
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(2) })
  expect(parent.getAttribute('aria-expanded')).toBe('false')
  expect(f.read.mock.calls.filter(([, input]) => input.parentId === folder.id)).toHaveLength(reads)
  fireEvent.click(parent)
  const retained = f.view.getByRole('button', { name: nested.name })
  const retry = await f.view.findByRole('button', { name: zh.retry })
  const error = f.view.getByText(zh.libraryLoadFailed)
  retry.focus(); fail = false; fireEvent.click(retry); fireEvent.click(retry)
  expect(f.view.getByRole('button', { name: nested.name })).toBe(retained)
  expect(f.view.getByText(zh.libraryLoadFailed)).toBe(error)
  expect(document.activeElement).toBe(retry)
  expect(f.read.mock.calls.filter(([, input]) => input.parentId === folder.id)).toHaveLength(reads + 2)
  await act(async () => { retryRead.resolve(page([nested, added])) })
  expect(f.view.getByRole('button', { name: nested.name })).toBe(retained)
  expect(f.view.getByRole('button', { name: added.name })).toBeDefined()
  expect(f.view.getByRole('button', { name: folder.name })).toBe(parent)
  expect(document.activeElement).toBe(f.view.getByRole('button', { name: zh.libraryPersonal }))
})
it('removes deleted branches without implied stale folders and leaves outside focus untouched', async () => {
  const f = await fixture()
  const parent = await f.view.findByRole('button', { name: folder.name })
  const original = f.read.getMockImplementation()!
  const nested = { ...file, parentId: folder.id, name: '目录内文件.md' }
  f.read.mockImplementation(async (method, input) => method === 'library.entries.list' && input.parentId === folder.id ? page([nested]) : original(method, input))
  fireEvent.click(parent)
  await f.view.findByRole('button', { name: nested.name })
  const outside = f.view.getByRole('textbox', { name: 'outside' })
  outside.focus()
  f.read.mockImplementation(async (method, input) => method === 'library.entries.list' ? page([]) : original(method, input))
  act(() => { f.refresh() })
  await waitFor(() => { expect(f.view.queryByRole('button', { name: folder.name })).toBeNull() })
  expect(f.view.queryByRole('button', { name: nested.name })).toBeNull()
  expect(document.activeElement).toBe(outside)
})
it.each([false, true])('keeps shared pagination focus in its own branch unless focus moved outside: %s', async (moveOutside) => {
  const f = await fixture()
  const original = f.read.getMockImplementation()!
  const first = { ...file, libraryId: shared.id, name: '团队文件.md' }
  const extra = { ...first, id: '55555555-5555-4555-8555-555555555555', name: '后续文件.md' }
  const pending = Promise.withResolvers<unknown>()
  let fail = true
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.entries.list' && input.libraryId === shared.id) {
      if (input.page === 1) return page([first], 1, 2)
      if (fail) throw new Error('shared page unavailable')
      return pending.promise
    }
    return original(method, input)
  })
  act(() => { f.refresh() })
  const sharedRoot = f.view.getByRole('button', { name: shared.name })
  const retained = await f.view.findByRole('button', { name: first.name })
  fireEvent.click(f.view.getByRole('button', { name: zh.libraryMore }))
  const retry = await f.view.findByRole('button', { name: zh.retry })
  retry.focus(); fail = false; fireEvent.click(retry); fireEvent.click(retry)
  expect(document.activeElement).toBe(retry)
  const outside = f.view.getByRole('textbox', { name: 'outside' })
  if (moveOutside) outside.focus()
  await act(async () => { pending.resolve(page([extra], 2, 2)) })
  expect(f.view.getByRole('button', { name: first.name })).toBe(retained)
  expect(f.view.getByRole('button', { name: extra.name })).toBeDefined()
  expect(document.activeElement).toBe(moveOutside ? outside : sharedRoot)
  expect(f.read.mock.calls.filter(([method, input]) => method === 'library.entries.list' && input.libraryId === shared.id && input.page === 2)).toHaveLength(2)
})
it('uses one native new menu and returns focus before opening the existing creation flows', async () => {
  const f = await fixture()
  await f.view.findByRole('button', { name: folder.name })
  const trigger = f.view.getByRole('button', { name: zh.libraryNew })
  fireEvent.click(trigger)
  const menu = await f.view.findByRole('menu')
  fireEvent.click(within(menu).getByRole('menuitem', { name: zh.libraryUpload }))
  expect(f.upload).toHaveBeenCalledOnce()
  expect(f.view.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

it.each(['upload', 'folder'] as const)('creates %s in the directory owning its add menu without navigating', async (kind) => {
  const f = await fixture()
  const row = await f.view.findByRole('button', { name: folder.name })
  const originalBounds = row.getBoundingClientRect()
  for (const [name, target] of [
    [zh.libraryPersonal, { library: personal, parentId: null }],
    [folder.name, { library: personal, parentId: folder.id, parentName: folder.name }],
  ] as const) {
    const trigger = f.view.getByRole('button', { name: `${zh.libraryNew}: ${name}` })
    fireEvent.click(trigger)
    fireEvent.click(within(await f.view.findByRole('menu')).getByRole('menuitem', {
      name: kind === 'upload' ? zh.libraryUpload : zh.libraryNewFolder,
    }))
    expect(kind === 'upload' ? f.upload : f.create).toHaveBeenLastCalledWith(target)
    expect(document.activeElement).toBe(trigger)
    expect(f.view.queryByRole('menu')).toBeNull()
  }
  expect(f.navigate).not.toHaveBeenCalled()
  expect(f.view.getByRole('button', { name: folder.name })).toBe(row)
  expect(row.getBoundingClientRect()).toEqual(originalBounds)
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
})

it('ignores a superseded shared tree read after a directory refresh', async () => {
  const f = await fixture()
  const original = f.read.getMockImplementation()!
  const late = Promise.withResolvers<unknown>()
  let attempts = 0
  const current = { ...file, libraryId: shared.id, name: '当前团队文件.md' }
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.entries.list' && input.libraryId === shared.id) {
      return ++attempts === 1 ? late.promise : page([current])
    }
    return original(method, input)
  })
  act(() => { f.refresh() })
  await waitFor(() => { expect(attempts).toBe(1) })
  act(() => { f.refresh() })
  await f.view.findByRole('button', { name: current.name })
  await act(async () => { late.resolve(page([{ ...current, name: '过期团队文件.md' }])) })
  expect(f.view.queryByRole('button', { name: '过期团队文件.md' })).toBeNull()
  expect(f.view.getByRole('button', { name: current.name })).toBeDefined()
  expect(f.view.queryByRole('alert')).toBeNull()
})

it('keeps empty sections and sibling rows stable while loading a directory or refreshing libraries', async () => {
  const f = await fixture()
  const original = f.read.getMockImplementation()!
  const children = Promise.withResolvers<unknown>()
  let refreshRead: Promise<unknown> = Promise.resolve(page([personal]))
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.list') return refreshRead
    if (method === 'library.entries.list' && input.parentId === folder.id) return children.promise
    return original(method, input)
  })
  act(() => { f.refresh() })
  const empty = await f.view.findByText(zh.librarySharedEmpty)
  const parent = f.view.getByRole('button', { name: folder.name })
  const sibling = f.view.getByRole('button', { name: file.name })
  parent.focus(); fireEvent.click(parent)
  await waitFor(() => { expect(parent.getAttribute('aria-busy')).toBe('true') })
  expect(f.view.container.querySelector('[data-files-row="loading"]')).toBeNull()
  expect(f.view.getByRole('button', { name: file.name })).toBe(sibling)
  expect(document.activeElement).toBe(parent)
  await act(async () => { children.resolve(page([])) })
  await waitFor(() => { expect(parent.hasAttribute('aria-busy')).toBe(false) })
  const refreshGate = Promise.withResolvers<unknown>()
  refreshRead = refreshGate.promise
  act(() => { f.refresh() })
  expect(f.view.getByText(zh.librarySharedEmpty)).toBe(empty)
  await act(async () => { refreshGate.reject(new Error('offline')) })
  await f.view.findByRole('alert')
  expect(f.view.getByText(zh.librarySharedEmpty)).toBe(empty)
})

it('retains the dragged file busy state independently of directory loading', async () => {
  let moving = true
  const f = await fixture((_location, item) => ({ 'aria-busy': item?.entry.id === file.id && moving || undefined }))
  const source = await f.view.findByRole('button', { name: file.name })
  expect(source.getAttribute('aria-busy')).toBe('true')
  expect(f.view.getByRole('button', { name: folder.name }).hasAttribute('aria-busy')).toBe(false)
  moving = false
  act(() => { f.refresh() })
  await waitFor(() => { expect(source.hasAttribute('aria-busy')).toBe(false) })
  expect(f.view.getByRole('button', { name: file.name })).toBe(source)
})

it('opens folder rename from a stable tree menu and omits write actions for viewers', async () => {
  const f = await fixture()
  const row = await f.view.findByRole('button', { name: folder.name })
  const trigger = f.view.getByRole('button', { name: `${zh.resourceActions} · ${folder.name}` })
  trigger.focus(); fireEvent.click(trigger)
  fireEvent.click(within(await f.view.findByRole('menu')).getByRole('menuitem', { name: zh.libraryRename }))
  expect(f.edit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ entry: folder, canManage: true }), 'rename')
  expect(document.activeElement).toBe(trigger)
  for (const [label, kind] of [[zh.libraryMove, 'move'], [zh.deleteResource, 'delete']] as const) {
    fireEvent.click(trigger)
    fireEvent.click(within(await f.view.findByRole('menu')).getByRole('menuitem', { name: label }))
    expect(f.edit).toHaveBeenLastCalledWith(expect.objectContaining({ entry: folder, canManage: true }), kind)
    expect(document.activeElement).toBe(trigger)
  }
  expect(f.navigate).not.toHaveBeenCalled()
  expect(f.view.getByRole('button', { name: folder.name })).toBe(row)
  const original = f.read.getMockImplementation()!
  const sharedFolder = { ...folder, libraryId: shared.id, name: '只读目录' }
  f.read.mockImplementation(async (method, input) => method === 'library.entries.list' && input.libraryId === shared.id
    ? page([sharedFolder]) : original(method, input))
  act(() => { f.refresh() })
  await f.view.findByRole('button', { name: sharedFolder.name })
  expect(f.view.queryByRole('button', { name: `${zh.resourceActions} · ${sharedFolder.name}` })).toBeNull()
})

it('offers the same rename flow to shared-space editors', async () => {
  const f = await fixture()
  await f.view.findByRole('button', { name: folder.name })
  const original = f.read.getMockImplementation()!
  const editable = { ...shared, role: 'EDITOR', canManage: true }
  const sharedFolder = { ...folder, libraryId: shared.id, name: '共享可编辑目录' }
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.list') return page([personal, editable])
    return method === 'library.entries.list' && input.libraryId === shared.id ? page([sharedFolder]) : original(method, input)
  })
  act(() => { f.refresh() })
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.list')).toHaveLength(2) })
  const add = await f.view.findByRole('button', { name: `${zh.libraryNew}: ${editable.name}` })
  fireEvent.click(add)
  fireEvent.click(within(await f.view.findByRole('menu')).getByRole('menuitem', { name: zh.libraryNewFolder }))
  expect(f.create).toHaveBeenLastCalledWith({ library: editable, parentId: null })
  const trigger = await f.view.findByRole('button', { name: `${zh.resourceActions} · ${sharedFolder.name}` })
  fireEvent.click(trigger)
  fireEvent.click(within(await f.view.findByRole('menu')).getByRole('menuitem', { name: zh.libraryRename }))
  expect(f.edit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ entry: sharedFolder, canManage: true }), 'rename')
  expect(document.activeElement).toBe(trigger)
})

it('shows shared directories and root creation actions just like personal files', async () => {
  const f = await fixture()
  await f.view.findByRole('button', { name: folder.name })
  const space = f.view.getByRole('button', { name: shared.name })
  expect(f.view.queryByRole('button', { name: /展开:|折叠:/ })).toBeNull()
  expect(f.view.queryByRole('button', { name: `${zh.libraryNew}: ${shared.name}` })).toBeNull()
  fireEvent.click(space)
  expect(f.navigate).toHaveBeenLastCalledWith({ library: shared, parentId: null }, [])
  fireEvent.click(space)
  expect(f.view.getByRole('button', { name: shared.name })).toBe(space)
})
