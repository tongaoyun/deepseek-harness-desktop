// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { LibraryEntry } from '@deepseek-harness/product/library'
import { LibraryFilePicker } from '../src/client/LibraryFilePicker.tsx'
import { zh } from '../src/locales.ts'

const t = makeTranslate(zh, commonZh)
const now = '2026-11-17T01:00:00Z'
const personal = { id: '11111111-1111-4111-8111-111111111111', name: '个人文件', scope: 'PERSONAL', ownerId: 'alice',
  companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: now, updatedAt: now }
const shared = { ...personal, id: '22222222-2222-4222-8222-222222222222', name: '共享项目', scope: 'TEAM', role: 'VIEWER', canManage: false }
const file: LibraryEntry = { id: '33333333-3333-4333-8333-333333333333', libraryId: personal.id, parentId: null,
  name: '中文参考资料.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12,
  version: 1, createdAt: now, updatedAt: now }
const folder: LibraryEntry = { ...file, id: '44444444-4444-4444-8444-444444444444', libraryId: shared.id, name: '模板', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0 }
const nested: LibraryEntry = { ...file, id: '55555555-5555-4555-8555-555555555555', libraryId: shared.id, parentId: folder.id, name: '共享模板.docx' }
function page<T>(data: readonly T[]) {
  return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0 }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture() {
  const read = vi.fn(async (method: string, input: { libraryId?: string; parentId?: string | null; query?: string }): Promise<unknown> => {
    if (method === 'library.files.list') return page([{ entry: file, libraryName: personal.name, canManage: true, lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null }])
    if (method === 'library.list') return page([personal, shared])
    if (method === 'library.personal.ensure') return personal
    if (method === 'library.get') return input.libraryId === shared.id ? shared : personal
    if (method === 'library.entries.list') return page(input.libraryId === shared.id ? input.parentId === folder.id ? [nested] : [folder] : [file])
    throw new Error(`Unexpected picker operation: ${method}`)
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, input: Parameters<typeof read>[1]) => ({
      ok: true, result: await read(method, input),
    }),
    cancel, subscribe: () => () => {},
  } })
  function Picker() {
    const [selected, setSelected] = useState<ReadonlyMap<string, LibraryEntry>>(new Map())
    return <><button>Outside</button><LibraryFilePicker t={t} selected={selected} navigationLocked={false} onSelect={(entry) => {
      setSelected((current) => { const next = new Map(current); if (!next.delete(entry.id)) next.set(entry.id, entry); return next })
    }} /></>
  }
  const view = render(<Picker />)
  return { read, cancel, view }
}

it('selects files across recent, personal and read-only shared folders without exposing write actions', async () => {
  const f = fixture()
  fireEvent.click(await screen.findByRole('checkbox', { name: file.name }))
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryPersonal }))
  expect((await screen.findByRole<HTMLInputElement>('checkbox', { name: file.name })).checked).toBe(true)
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryShared }))
  fireEvent.click(await screen.findByRole('button', { name: shared.name }))
  fireEvent.click(await screen.findByRole('button', { name: folder.name }))
  fireEvent.click(await screen.findByRole('checkbox', { name: nested.name }))
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: nested.name }).checked).toBe(true)
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryRecent }))
  expect((await screen.findByRole<HTMLInputElement>('checkbox', { name: file.name })).checked).toBe(true)
  expect(screen.queryByRole('button', { name: zh.libraryUpload })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.libraryNewFolder })).toBeNull()
  expect(f.read.mock.calls.map(([method]) => method).every(method => ['library.files.list', 'library.list', 'library.get', 'library.personal.ensure', 'library.entries.list'].includes(method))).toBe(true)
})

it.each(['retry', 'error', 'other'] as const)('retains rows, search selection and %s focus while retrying a failed filtered read', async (focused) => {
  const f = fixture(), original = f.read.getMockImplementation()!
  const read = Promise.withResolvers<unknown>(), retryRead = Promise.withResolvers<unknown>()
  const row = await screen.findByRole('button', { name: file.name })
  const input = screen.getByRole<HTMLInputElement>('searchbox')
  f.read.mockImplementationOnce(() => read.promise)
  fireEvent.change(input, { target: { value: '中文' } })
  input.focus(); input.setSelectionRange(0, 1)
  expect(screen.getByRole('button', { name: file.name })).toBe(row)
  await act(async () => { read.reject(new Error('Search unavailable')) })
  const error = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  f.read.mockImplementationOnce(() => retryRead.promise)
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(document.activeElement).toBe(retry)
  expect(screen.getByRole('button', { name: file.name })).toBe(row)
  const calls = f.read.mock.calls.length
  const outside = screen.getByRole('button', { name: 'Outside' })
  if (focused !== 'retry') (focused === 'error' ? error : outside).focus()
  expect(document.activeElement).toBe(focused === 'error' ? error : focused === 'other' ? outside : retry)
  await act(async () => { retryRead.resolve(await original('library.files.list', {})) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(f.read.mock.calls).toHaveLength(calls)
  expect(screen.getByRole('button', { name: file.name })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(input)
  expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['中文', 0, 1])
  expect(document.activeElement).toBe(focused === 'other' ? outside : input)
})

it('ignores a late source reply and keeps the current source search and file selection', async () => {
  const f = fixture(), late = Promise.withResolvers<unknown>()
  fireEvent.click(await screen.findByRole('checkbox', { name: file.name }))
  f.read.mockImplementationOnce(() => late.promise)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '旧搜索' } })
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryShared }))
  await screen.findByRole('button', { name: shared.name })
  await act(async () => { late.reject(new Error('Old source unavailable')) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('tab', { name: zh.libraryShared }).getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('')
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryRecent }))
  expect((await screen.findByRole<HTMLInputElement>('checkbox', { name: file.name })).checked).toBe(true)
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('旧搜索')
  expect(f.cancel).toHaveBeenCalled()
})

it('shows an initial failure with retry instead of an empty-list message', async () => {
  const read = vi.fn(async () => { throw new Error('Read unavailable') })
  vi.stubGlobal('dshDesktop', { extensions: { invoke: read, cancel: vi.fn(), subscribe: () => () => {} } })
  render(<LibraryFilePicker t={t} selected={new Map()} onSelect={vi.fn()} navigationLocked={false} />)
  await screen.findByRole('alert')
  expect(screen.queryByText(zh.libraryEmpty)).toBeNull()
  expect(screen.getByRole('button', { name: zh.retry })).toBeDefined()
})

it.each(['recent', 'mine', 'shared'] as const)('keeps the latest %s rows when clearing an earlier query through failure and retry', async (source) => {
  const f = fixture(), original = f.read.getMockImplementation()!
  const latest = { ...file, libraryId: source === 'shared' ? shared.id : personal.id, name: '更新后的资料.md', version: 2 }
  let entry = { ...file, libraryId: latest.libraryId }
  let waiting: Promise<unknown> | undefined
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.entries.list') return waiting ?? page([entry])
    if (method === 'library.files.list') return waiting ?? page([{ entry, libraryName: personal.name, canManage: true,
      lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null }])
    return original(method, input)
  })
  if (source === 'mine') fireEvent.click(screen.getByRole('tab', { name: zh.libraryPersonal }))
  if (source === 'shared') {
    fireEvent.click(screen.getByRole('tab', { name: zh.libraryShared }))
    fireEvent.click(await screen.findByRole('button', { name: shared.name }))
  }
  const row = await screen.findByRole('button', { name: file.name }), search = screen.getByRole<HTMLInputElement>('searchbox')
  entry = latest
  fireEvent.change(search, { target: { value: '更新' } })
  expect(await screen.findByRole('button', { name: latest.name })).toBe(row)
  const failed = Promise.withResolvers<unknown>()
  waiting = failed.promise
  search.focus(); fireEvent.change(search, { target: { value: '' } })
  expect(screen.getByRole('button', { name: latest.name })).toBe(row)
  expect(screen.queryByRole('button', { name: file.name })).toBeNull()
  await act(async () => { failed.reject(new Error('Directory unavailable')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  expect(screen.getByRole('button', { name: latest.name })).toBe(row)
  const recovery = Promise.withResolvers<unknown>()
  waiting = recovery.promise
  retry.focus(); fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  waiting = undefined
  await act(async () => { recovery.resolve(source === 'recent' ? page([{ entry: latest, libraryName: personal.name, canManage: true,
    lastAccessedAt: now, sourceKind: 'UPLOAD', sourceSessionId: null }]) : page([latest])) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('button', { name: latest.name })).toBe(row)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(document.activeElement).toBe(search)
})

it('retains a directory error and retry control while the search changes', async () => {
  const f = fixture(), failed = Promise.withResolvers<unknown>()
  await screen.findByRole('button', { name: file.name })
  f.read.mockImplementationOnce(() => failed.promise)
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '读取失败' } })
  await act(async () => { failed.reject(new Error('Search unavailable')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const recovery = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => recovery.promise)
  search.focus(); fireEvent.change(search, { target: { value: '新搜索' } }); search.setSelectionRange(0, 1)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(document.activeElement).toBe(search)
  await act(async () => { recovery.resolve(page([])) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByText(zh.libraryNoMatches)).toBeDefined()
  expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['新搜索', 0, 1])
  expect(document.activeElement).toBe(search)
})

it.each(['success', 'failure'] as const)('keeps a newer folder-opening failure after an older filtered read (%s)', async (outcome) => {
  const f = fixture(), original = f.read.getMockImplementation()!
  const ancestor = { ...folder, id: '66666666-6666-4666-8666-666666666666', parentId: folder.id, name: '搜索到的子目录' }
  const background = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.entries.list' && input.query === '较新的搜索') return background.promise
    if (method === 'library.entries.list') return page([ancestor])
    if (method === 'library.entries.get') throw new Error('Folder ancestry unavailable')
    return original(method, input)
  })
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryShared }))
  fireEvent.click(await screen.findByRole('button', { name: shared.name }))
  const folderButton = await screen.findByRole('button', { name: ancestor.name })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '较新的搜索' } })
  fireEvent.click(folderButton)
  const error = await screen.findByRole('alert')
  await act(async () => {
    if (outcome === 'success') background.resolve(page([ancestor]))
    else background.reject(new Error('Older list read failed'))
  })
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('button', { name: ancestor.name })).toBe(folderButton)
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.retry }).getAttribute('aria-busy')).toBe('false') })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.get')).toHaveLength(2)
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('searchbox')).toBeDefined()
})

it('retries failed folder ancestry without rereading the old list or losing retry focus', async () => {
  const f = fixture(), original = f.read.getMockImplementation()!
  const descendant = { ...folder, id: '66666666-6666-4666-8666-666666666666', parentId: folder.id, name: '搜索到的子目录' }
  const selectedFile = { ...nested, parentId: descendant.id }
  const recovery = Promise.withResolvers<unknown>()
  let attempts = 0
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.entries.get') {
      if (++attempts === 1) throw new Error('Folder ancestry unavailable')
      return recovery.promise
    }
    if (method === 'library.entries.list') return page(input.parentId === descendant.id ? [selectedFile] : [descendant])
    return original(method, input)
  })
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryShared }))
  fireEvent.click(await screen.findByRole('button', { name: shared.name }))
  fireEvent.click(await screen.findByRole('button', { name: descendant.name }))
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const listReads = f.read.mock.calls.filter(([method]) => method === 'library.entries.list').length
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(attempts).toBe(2)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(document.activeElement).toBe(retry)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.list')).toHaveLength(listReads)
  await act(async () => { recovery.resolve(folder) })
  await screen.findByRole('checkbox', { name: selectedFile.name })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.read).toHaveBeenLastCalledWith('library.entries.list', expect.objectContaining({ parentId: descendant.id }))
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})

it('restores each file source search range when returning to search without moving native tab focus', async () => {
  fixture()
  await screen.findByRole('checkbox', { name: file.name })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const recent = screen.getByRole('tab', { name: zh.libraryRecent })
  const mine = screen.getByRole('tab', { name: zh.libraryPersonal })
  const sharedTab = screen.getByRole('tab', { name: zh.libraryShared })
  search.focus()
  fireEvent.change(search, { target: { value: '最近资料' } })
  search.setSelectionRange(0, 2, 'backward')
  mine.focus(); fireEvent.click(mine)
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  search.focus()
  fireEvent.change(search, { target: { value: '个人模板' } })
  search.setSelectionRange(1, 3, 'forward')
  recent.focus(); fireEvent.click(recent)
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  expect(document.activeElement).toBe(recent)
  search.focus()
  expect(screen.getByRole('searchbox')).toBe(search)
  expect([search.value, search.selectionStart, search.selectionEnd, search.selectionDirection]).toEqual(['最近资料', 0, 2, 'backward'])
  mine.focus(); fireEvent.click(mine)
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  expect(document.activeElement).toBe(mine)
  search.focus()
  expect([search.value, search.selectionStart, search.selectionEnd, search.selectionDirection]).toEqual(['个人模板', 1, 3, 'forward'])
  sharedTab.focus(); fireEvent.click(sharedTab)
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  search.focus()
  fireEvent.change(search, { target: { value: '共享资料' } })
  search.setSelectionRange(2, 4, 'backward')
  recent.focus(); fireEvent.click(recent)
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  sharedTab.focus(); fireEvent.click(sharedTab)
  await waitFor(() => { expect(screen.getByRole('tabpanel').getAttribute('aria-busy')).toBe('false') })
  expect(document.activeElement).toBe(sharedTab)
  search.focus()
  expect([search.value, search.selectionStart, search.selectionEnd, search.selectionDirection]).toEqual(['共享资料', 2, 4, 'backward'])
  search.setSelectionRange(0, search.value.length, 'forward')
  fireEvent.focus(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, search.value.length])
})
