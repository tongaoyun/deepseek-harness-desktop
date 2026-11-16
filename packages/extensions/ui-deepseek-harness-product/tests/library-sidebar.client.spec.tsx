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
import type { LibraryLocation } from '../src/client/LibraryBrowser.tsx'
import type { LibraryEntry } from '@deepseek-harness/product/library'
import { zh } from '../src/locales.ts'
const t = makeTranslate(zh)
const timestamp = '2026-11-16T01:00:00Z'
const personal = { id: '11111111-1111-4111-8111-111111111111', name: '个人资料', description: '', scope: 'PERSONAL',
  ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp } as const
const shared = { ...personal, id: '22222222-2222-4222-8222-222222222222', name: '设计部门', scope: 'TEAM', role: 'VIEWER', canManage: false } as const
const folder = { id: '33333333-3333-4333-8333-333333333333', libraryId: personal.id, parentId: null, name: '合同模板',
  kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0, version: 1, createdAt: timestamp, updatedAt: timestamp } as const
const file = { ...folder, id: '44444444-4444-4444-8444-444444444444', name: '说明.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 24 } as const
function page(data: readonly unknown[], pageIndex = 1, totalPages = 1) {
  return { data, pageIndex, pageSize: 50, totalCount: totalPages * 50, totalPages }
}
async function fixture() {
  const read = vi.fn(async (method: string, input: { libraryId?: string; parentId?: string | null; page?: number }): Promise<unknown> => {
    if (method === 'library.list') return page([personal, shared])
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
  const navigate = vi.fn(), open = vi.fn(), create = vi.fn(), upload = vi.fn(), generate = vi.fn()
  let refresh = () => {}
  await runtime.root.declare({}, function Root({ renderFactorySlot }: PropsRenderFactories) {
    const [revision, update] = useState(0)
    const [currentView, setView] = useState<'recent' | 'mine'>('recent')
    const [location, setLocation] = useState<LibraryLocation>()
    const [trail, setTrail] = useState<readonly LibraryEntry[]>([])
    refresh = () => { update(value => value + 1) }
    return <><input aria-label="outside" /><LibrarySidebar t={t} view={currentView} revision={revision} renderFactorySlot={renderFactorySlot}
      {...(location ? { location } : {})} trail={trail}
      onView={(value) => { setView(value); if (value === 'mine') { setLocation(undefined); setTrail([]) } }}
      onNavigate={(next, ancestors) => { navigate(next, ancestors); setView('mine'); setLocation(next); setTrail(ancestors) }}
      onOpen={open} onCreateFolder={create} onUpload={upload} onGenerate={generate} /></>
  })
  const view = runtime.renderRoot()
  await act(async () => { await read.mock.results[0]?.value })
  return { read, view, navigate, open, create, upload, generate, refresh: () => { refresh() } }
}
it('expands the native tree lazily, retains nodes on collapse and opens files through existing previews', async () => {
  const f = await fixture()
  const parent = await f.view.findByRole('button', { name: folder.name })
  const fileButton = f.view.getByRole('button', { name: file.name })
  fireEvent.click(fileButton)
  expect(f.open).toHaveBeenCalledWith(expect.objectContaining({ entry: file, canManage: true }))
  expect(f.read.mock.calls.some(([method, input]) => method === 'library.entries.list' && input.libraryId === shared.id)).toBe(false)
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
  fireEvent.click(f.view.getByRole('button', { name: shared.name }))
  await waitFor(() => { expect(f.read).toHaveBeenCalledWith('library.entries.list', expect.objectContaining({ libraryId: shared.id, parentId: null })) })
  expect(f.navigate).toHaveBeenLastCalledWith({ library: shared, parentId: null }, [])
  fireEvent.click(f.view.getByRole('button', { name: zh.libraryRecent }))
  const sharedRoot = f.view.getByRole('button', { name: shared.name })
  fireEvent.click(sharedRoot)
  expect(sharedRoot.getAttribute('aria-expanded')).toBe('true')
  expect(sharedRoot.getAttribute('aria-current')).toBe('page')
  fireEvent.click(sharedRoot)
  expect(sharedRoot.getAttribute('aria-expanded')).toBe('false')
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
  const sharedRoot = f.view.getByRole('button', { name: shared.name })
  fireEvent.click(sharedRoot)
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

it('ignores a closed shared tree response after a fresh tree has opened', async () => {
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
  const sharedRoot = f.view.getByRole('button', { name: shared.name })
  fireEvent.click(sharedRoot)
  await waitFor(() => { expect(attempts).toBe(1) })
  fireEvent.click(sharedRoot)
  fireEvent.click(sharedRoot)
  await f.view.findByRole('button', { name: current.name })
  await act(async () => { late.resolve(page([{ ...current, name: '过期团队文件.md' }])) })
  expect(f.view.queryByRole('button', { name: '过期团队文件.md' })).toBeNull()
  expect(f.view.getByRole('button', { name: current.name })).toBeDefined()
  expect(f.view.queryByRole('alert')).toBeNull()
})
