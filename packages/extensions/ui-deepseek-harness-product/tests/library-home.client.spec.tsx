// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { LibraryHome } from '../src/client/LibraryHome.tsx'
import { zh } from '../src/locales.ts'
const t = makeTranslate(zh, commonZh)
const timestamp = '2026-11-14T01:00:00Z'
const file = { entry: { id: '22222222-2222-4222-8222-222222222222', libraryId: '11111111-1111-4111-8111-111111111111',
  parentId: null, name: '产品方案.docx', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'application/octet-stream',
  sizeBytes: 5120, favorite: true, version: 1, createdAt: timestamp, updatedAt: timestamp },
libraryName: '个人资料', canManage: true, lastAccessedAt: timestamp, sourceKind: 'CONVERSATION', sourceSessionId: 'source-session' }
function page(data: readonly unknown[] = [file], pageIndex = 1, totalCount = data.length) {
  return { data, pageIndex, pageSize: 20, totalCount, totalPages: Math.ceil(totalCount / 20) }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture() {
  const read = vi.fn(async (_method: string, _input?: unknown): Promise<unknown> => page())
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, input: unknown) => ({ ok: true, result: await read(method, input) }),
    cancel: vi.fn(), subscribe: () => () => {},
  } })
  const create = vi.fn(), source = vi.fn()
  render(<LibraryHome t={t} renderFactorySlot={() => null} startLibraryCreation={create} openLibrarySource={source} />)
  return { read, create, source }
}
it('retains controls, rows, selection and errors through refresh failure, retry and layout changes', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: /^产品方案/ })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  fireEvent.change(search, { target: { value: '产品' } })
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('false') })
  search.focus(); search.setSelectionRange(0, 1)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryGrid }))
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBe(row)
  expect(document.activeElement).toBe(search)
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 1])
  const gate = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => gate.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
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
  expect(search.value).toBe('产品')
  expect(document.activeElement).toBe(search)
})
it('applies file type, view and sort filters before asking for a server page and ignores old responses', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const older = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => older.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryCategoryHtml }))
  fireEvent.click(screen.getByRole('button', { name: zh.libraryMine }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'size' } })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryDescending }))
  await waitFor(() => { expect(f.read).toHaveBeenLastCalledWith('library.files.list', expect.objectContaining({ view: 'mine', category: 'html', sort: 'size', direction: 'asc', page: 1 })) })
  await act(async () => { older.resolve(page([{ ...file, entry: { ...file.entry, name: '过期.html' } }])) })
  expect(screen.queryByRole('button', { name: /过期/ })).toBeNull()
  expect(screen.getByRole('button', { name: /^产品方案/ })).toBeDefined()
})
it('removing a favorite and a later failed refresh never resubmits the successful write', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryFavorites }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.refresh }).getAttribute('aria-busy')).toBe('false') })
  let failed = true
  f.read.mockImplementation(async (method) => {
    if (method === 'library.entries.favorite') return false
    if (failed) throw new Error('refresh offline')
    return page([])
  })
  fireEvent.click(screen.getByRole('button', { name: /更多操作.*产品方案|资源操作.*产品方案/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryUnfavorite }))
  await screen.findByRole('alert')
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.favorite')).toHaveLength(1)
  failed = false
  const trigger = screen.getByRole('button', { name: /更多操作.*产品方案|资源操作.*产品方案/ })
  trigger.focus()
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await waitFor(() => { expect(screen.queryByRole('button', { name: /^产品方案/ })).toBeNull() })
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  expect(f.read.mock.calls.filter(([method]) => method === 'library.entries.favorite')).toHaveLength(1)
})
it('delegates file creation and source navigation to native conversations', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryFromConversation }))
  expect(f.source).toHaveBeenCalledWith('source-session')
  fireEvent.click(screen.getByRole('button', { name: zh.libraryGenerate }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryGenerateSpreadsheet }))
  expect(f.create).toHaveBeenCalledWith('spreadsheet')
  expect(f.read).toHaveBeenCalledOnce()
})

it('cancels an in-flight move opener when its file view changes', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: /^产品方案/ })
  const gate = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async method => method === 'library.get' ? gate.promise : page())
  fireEvent.click(screen.getByRole('button', { name: /更多操作.*产品方案/ }))
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryMove }))
  fireEvent.click(screen.getByRole('button', { name: zh.libraryMine }))
  await act(async () => { gate.resolve({ id: file.entry.libraryId, name: '个人资料', description: '', scope: 'PERSONAL',
    ownerId: 'employee', managerEmployeeId: 'employee', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.libraryUpload }))
  expect(screen.getByRole('dialog', { name: zh.libraryUploadDestination })).toBeDefined()
})
