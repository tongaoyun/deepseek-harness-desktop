// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { LibraryUpload } from '../src/client/LibraryUpload.tsx'
import { LibraryDestination } from '../src/client/LibraryDestination.tsx'
import { zh } from '../src/locales.ts'
import { ProductError } from '@deepseek-harness/product/errors'

const t = makeTranslate(zh, commonZh)
const library = { id: '11111111-1111-4111-8111-111111111111', name: '资料库', scope: 'PERSONAL' as const,
  ownerId: 'alice', companyId: 'company', role: 'OWNER' as const, canManage: true, version: 1, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' }
const first = { selectionId: '22222222-2222-4222-8222-222222222222', name: '第一份.md', kind: 'FILE' as const, sizeBytes: 12 }
const second = { ...first, selectionId: '33333333-3333-4333-8333-333333333333', name: '第二份.md' }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture(strict = false) {
  const read = vi.fn(async (_method: string, _payload?: unknown): Promise<unknown> => true)
  const cancel = vi.fn(), closed = vi.fn(), committed = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, payload?: unknown) => ({ ok: true, result: await read(method, payload) }),
    cancel, subscribe: () => () => {},
  } })
  const upload = <LibraryUpload location={{ library, parentId: null }} t={t} onClose={closed} onCommitted={committed} />
  const view = render(strict ? <StrictMode>{upload}</StrictMode> : upload)
  return { read, cancel, closed, committed, view }
}

it('cancels selection preparation when closed and releases a late native selection', async () => {
  const f = fixture(), selected = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => selected.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryChooseLocalFiles }))
  fireEvent.click(screen.getAllByRole('button', { name: zh.close }).at(-1)!)
  expect(f.closed).toHaveBeenCalledOnce()
  expect(f.cancel).toHaveBeenCalledOnce()
  f.view.unmount()
  await act(async () => { selected.resolve([first]) })
  await waitFor(() => { expect(f.read.mock.calls).toContainEqual(['library.files.upload.discard', { selectionId: first.selectionId }]) })
  expect(f.committed).not.toHaveBeenCalled()
})

it.each(['PERSONAL', 'TEAM'] as const)('uploads to the current %s folder without silently selecting another root', async (scope) => {
  const f = fixture()
  f.view.unmount()
  const destination = { library: { ...library, scope }, parentId: second.selectionId, parentName: '项目模板' }
  render(<LibraryDestination kind="upload" initialLocation={destination} t={t} renderFactorySlot={() => null}
    onClose={f.closed} onCommitted={f.committed} />)
  const dialog = screen.getByRole('dialog', { name: zh.libraryUpload })
  expect(screen.queryByRole('dialog', { name: zh.libraryUploadDestination })).toBeNull()
  expect(screen.queryByText('资料库 / 项目模板')).toBeNull()
  let fail = true
  f.read.mockImplementation(async (method) => {
    if (method === 'library.files.upload.select') return [first]
    if (method === 'library.files.upload' && fail) throw new Error('upload unavailable')
    return true
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryChooseLocalFiles }))
  await screen.findByText(/第一份.md/)
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  upload.focus(); fireEvent.click(upload)
  await screen.findByRole('alert')
  expect(screen.getByRole('dialog', { name: zh.libraryUpload })).toBe(dialog)
  expect(document.activeElement).toBe(upload)
  fail = false; fireEvent.click(upload)
  await waitFor(() => { expect(f.committed).toHaveBeenCalledOnce() })
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.files.upload').map(([, payload]) => payload)
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  expect(writes[0]).toMatchObject({ libraryId: library.id, parentId: destination.parentId })
  expect(f.read.mock.calls.some(([method]) => method === 'library.personal.ensure')).toBe(false)
})

it('retains a partial upload failure when native selection is cancelled and only retries unconfirmed files', async () => {
  const f = fixture()
  let chooses = 0, attempts = 0
  f.read.mockImplementation(async (method) => {
    if (method === 'library.files.upload.select') return ++chooses === 1 ? [first, second] : []
    if (method === 'library.files.upload' && ++attempts === 2) throw new Error('upload offline')
    return true
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryChooseLocalFiles }))
  await screen.findByText(/第一份.md/)
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  upload.focus(); fireEvent.click(upload)
  const alert = await screen.findByRole('alert'), row = screen.getByText(/第二份.md/)
  expect(screen.queryByText(/第一份.md/)).toBeNull()
  expect(document.activeElement).toBe(upload)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryChooseLocalFiles }))
  await waitFor(() => { expect(chooses).toBe(2) })
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByText(/第二份.md/)).toBe(row)
  const retried = Promise.withResolvers<unknown>()
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, payload) => method === 'library.files.upload' ? retried.promise : original(method, payload))
  upload.focus(); fireEvent.click(upload); fireEvent.click(upload)
  fireEvent.keyDown(upload, { key: 'Escape' })
  expect(f.closed).not.toHaveBeenCalled()
  expect(f.committed).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(upload)
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.files.upload')
  expect(writes).toHaveLength(3)
  expect(writes[2]).toEqual(writes[1])
  await act(async () => { retried.resolve(true) })
  expect(f.committed).toHaveBeenCalledOnce()
})

it('removes an invalid selection without closing the upload and preserves other files through reselection', async () => {
  const f = fixture(), uploading = Promise.withResolvers<unknown>()
  const replacement = { ...first, selectionId: '44444444-4444-4444-8444-444444444444' }
  let selections = 0, attempts = 0
  f.read.mockImplementation(async (method) => {
    if (method === 'library.files.upload.select') return ++selections === 1 ? [first, second] : [replacement]
    if (method === 'library.files.upload' && ++attempts === 1) throw new ProductError('LIBRARY_FILE_INVALID', 'Selected file changed', false)
    if (method === 'library.files.upload' && attempts === 2) return uploading.promise
    return true
  })
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFiles })
  fireEvent.click(choose)
  await screen.findByText(/第一份.md/)
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  fireEvent.click(upload)
  const alert = await screen.findByRole('alert'), retained = screen.getByText(/第二份.md/)
  expect(alert.textContent).toContain(zh.libraryFileInvalid)
  const remove = screen.getByRole('button', { name: `${zh.remove}: ${first.name}` })
  remove.focus(); fireEvent.click(remove)
  expect(screen.queryByText(/第一份.md/)).toBeNull()
  expect(screen.getByText(/第二份.md/)).toBe(retained)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(choose)
  await waitFor(() => { expect(f.read.mock.calls).toContainEqual(['library.files.upload.discard', { selectionId: first.selectionId }]) })
  fireEvent.click(choose)
  await screen.findByText(/第一份.md/)
  expect(screen.getByText(/第二份.md/)).toBe(retained)
  const removeSecond = screen.getByRole('button', { name: `${zh.remove}: ${second.name}` })
  upload.focus(); fireEvent.click(upload); fireEvent.click(upload)
  expect(removeSecond.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(removeSecond)
  expect(screen.getByText(/第二份.md/)).toBe(retained)
  expect(document.activeElement).toBe(upload)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload.discard')).toEqual([
    ['library.files.upload.discard', { selectionId: first.selectionId }],
  ])
  await act(async () => { uploading.resolve(true) })
  await waitFor(() => { expect(f.committed).toHaveBeenCalledOnce() })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload').map(([, payload]) =>
    (payload as { selectionId: string }).selectionId)).toEqual([first.selectionId, second.selectionId, replacement.selectionId])
  expect(f.closed).not.toHaveBeenCalled()
})

it('retains another control focus when a selected file is removed without focusing its remove action', async () => {
  const f = fixture()
  f.read.mockImplementation(async method => method === 'library.files.upload.select' ? [first] : true)
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFiles })
  fireEvent.click(choose)
  await screen.findByText(/第一份.md/)
  const close = screen.getAllByRole('button', { name: zh.close }).at(-1)!
  close.focus()
  fireEvent.click(screen.getByRole('button', { name: `${zh.remove}: ${first.name}` }))
  expect(document.activeElement).toBe(close)
  expect(screen.getByRole('button', { name: zh.libraryUpload }).getAttribute('aria-disabled')).toBe('true')
  expect(f.closed).not.toHaveBeenCalled()
})

it('refreshes confirmed uploads when the failed remainder is removed and the dialog is closed', async () => {
  const f = fixture()
  let writes = 0
  f.read.mockImplementation(async (method) => {
    if (method === 'library.files.upload.select') return [first, second]
    if (method === 'library.files.upload' && ++writes === 2) throw new ProductError('LIBRARY_FILE_INVALID', 'Selected file changed', false)
    return true
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryChooseLocalFiles }))
  await screen.findByText(/第一份.md/)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryUpload }))
  await screen.findByRole('alert')
  expect(screen.queryByText(/第一份.md/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: `${zh.remove}: ${second.name}` }))
  expect(screen.queryByText(/第二份.md/)).toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: zh.close }).at(-1)!)
  expect(f.committed).toHaveBeenCalledOnce()
  expect(f.closed).not.toHaveBeenCalled()
  expect(writes).toBe(2)
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload.discard')).toEqual([
    ['library.files.upload.discard', { selectionId: first.selectionId }],
    ['library.files.upload.discard', { selectionId: second.selectionId }],
  ]) })
})

it.each(['completed', 'remaining'] as const)('preserves focus when the %s file action is focused as an upload completes', async (focused) => {
  const f = fixture(), firstUpload = Promise.withResolvers<unknown>(), secondUpload = Promise.withResolvers<unknown>()
  let writes = 0
  f.read.mockImplementation(async (method) => {
    if (method === 'library.files.upload.select') return [first, second]
    if (method === 'library.files.upload') return ++writes === 1 ? firstUpload.promise : secondUpload.promise
    return true
  })
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFiles })
  fireEvent.click(choose)
  await screen.findByText(/第一份.md/)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryUpload }))
  const action = screen.getByRole('button', { name: `${zh.remove}: ${focused === 'completed' ? first.name : second.name}` })
  action.focus()
  await act(async () => { firstUpload.resolve(true) })
  expect(screen.queryByText(/第一份.md/)).toBeNull()
  expect(document.activeElement).toBe(focused === 'completed' ? choose : action)
  await act(async () => { secondUpload.reject(new Error('upload unavailable')) })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(document.activeElement).toBe(focused === 'completed' ? choose : action)
  expect(f.committed).not.toHaveBeenCalled()
})

it.each(['error', 'other'] as const)('recovers only removed selection-error focus after a successful retry (%s)', async (focused) => {
  const f = fixture(), selected = Promise.withResolvers<unknown>()
  f.read.mockRejectedValueOnce(new Error('selection unavailable'))
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFiles })
  fireEvent.click(choose)
  const alert = await screen.findByRole('alert')
  f.read.mockImplementationOnce(() => selected.promise)
  fireEvent.click(choose); fireEvent.click(choose)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload.select')).toHaveLength(2)
  expect(screen.getByRole('alert')).toBe(alert)
  const close = screen.getAllByRole('button', { name: zh.close }).at(-1)!
  const target = focused === 'error' ? screen.getByRole('region', { name: zh.librarySelectionFailed }) : close
  target.focus()
  await act(async () => { selected.resolve([first]) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: zh.libraryChooseLocalFiles })).toBe(choose)
  expect(document.activeElement).toBe(focused === 'error' ? choose : close)
  expect(f.committed).not.toHaveBeenCalled()
})

it('selects files after effect reactivation and retains controls and receipts through a failed upload retry', async () => {
  const f = fixture(true)
  let attempts = 0
  f.read.mockImplementation(async (method) => {
    if (method === 'library.files.upload.select') return [first]
    if (method === 'library.files.upload' && ++attempts === 1) throw new Error('upload offline')
    return true
  })
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFiles })
  choose.focus(); fireEvent.click(choose)
  const row = await screen.findByText(/第一份.md/)
  expect(screen.getByRole('button', { name: zh.libraryChooseLocalFiles })).toBe(choose)
  expect(document.activeElement).toBe(choose)
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  upload.focus(); fireEvent.click(upload)
  const error = await screen.findByRole('alert')
  expect(screen.getByText(/第一份.md/)).toBe(row)
  expect(document.activeElement).toBe(upload)
  const retry = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async method => method === 'library.files.upload' ? retry.promise : true)
  fireEvent.click(upload); fireEvent.click(upload)
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('button', { name: zh.libraryUpload })).toBe(upload)
  expect(document.activeElement).toBe(upload)
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.files.upload')
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  await act(async () => { retry.resolve(true) })
  expect(f.committed).toHaveBeenCalledOnce()
  expect(f.closed).not.toHaveBeenCalled()
})


it('retains an upload failure through additional selection failure and recovery without resubmitting confirmed files', async () => {
  const f = fixture()
  let selections = 0, attempts = 0
  f.read.mockImplementation(async (method) => {
    if (method === 'library.files.upload.select') {
      selections++
      if (selections === 2) throw new Error('selection unavailable')
      return selections === 1 ? [first] : [second]
    }
    if (method === 'library.files.upload' && ++attempts === 1) throw new Error('upload offline')
    return true
  })
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFiles })
  fireEvent.click(choose)
  const firstRow = await screen.findByText(/第一份.md/)
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  fireEvent.click(upload)
  const uploadError = await screen.findByRole('alert')
  expect(uploadError.textContent).toBe(zh.saveFailed)
  fireEvent.click(choose)
  await waitFor(() => { expect(screen.getAllByRole('alert')).toHaveLength(2) })
  expect(screen.getAllByRole('alert')).toContain(uploadError)
  expect(screen.getByText(/第一份.md/)).toBe(firstRow)
  const selectionError = screen.getByRole('region', { name: zh.librarySelectionFailed })
  selectionError.focus()
  fireEvent.click(choose)
  await screen.findByText(/第二份.md/)
  expect(screen.queryAllByRole('alert').some(node => node.textContent === zh.librarySelectionFailed)).toBe(false)
  expect(screen.getByRole('alert')).toBe(uploadError)
  expect(document.activeElement).toBe(choose)
  expect(screen.getByText(/第一份.md/)).toBe(firstRow)
  fireEvent.click(upload)
  await waitFor(() => { expect(f.committed).toHaveBeenCalledOnce() })
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.files.upload')
  expect(writes).toHaveLength(3)
  expect(writes[1]).toEqual(writes[0])
  expect(writes[2]?.[1]).toMatchObject({ selectionId: second.selectionId })
})

it('accepts native dropped files once while keeping the drop area and selection controls mounted', async () => {
  const f = fixture(), selected = Promise.withResolvers<unknown>()
  const file = new File(['sample'], '拖拽资料.md')
  vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: () => '/tmp/拖拽资料.md' })
  f.read.mockImplementation(async method => method === 'library.files.upload.select' ? selected.promise : true)
  const area = screen.getByRole('group', { name: zh.libraryDropFiles })
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFiles })
  const folder = screen.getByRole('button', { name: zh.libraryChooseLocalFolder })
  const transfer = { files: [file], types: ['Files'], dropEffect: '' }
  fireEvent.dragOver(area, { dataTransfer: transfer })
  expect(area.getAttribute('data-dragging')).toBe('true')
  fireEvent.drop(area, { dataTransfer: transfer }); fireEvent.drop(area, { dataTransfer: transfer })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload.select'))
    .toEqual([['library.files.upload.select', { paths: ['/tmp/拖拽资料.md'] }]])
  await act(async () => { selected.resolve([first]) })
  expect(screen.getByRole('group', { name: zh.libraryDropFiles })).toBe(area)
  expect(screen.getByRole('button', { name: zh.libraryChooseLocalFiles })).toBe(choose)
  expect(screen.getByRole('button', { name: zh.libraryChooseLocalFolder })).toBe(folder)
  expect(f.read.mock.calls.some(([method]) => method === 'library.files.upload')).toBe(false)
})
it('preserves selected folder hierarchy and reuses created folders and upload keys after failure', async () => {
  const f = fixture()
  const rootId = '44444444-4444-4444-8444-444444444444', childId = '55555555-5555-4555-8555-555555555555'
  let attempts = 0
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.files.upload.select') return [first, second].map(file => ({ ...file, folders: ['项目资料', '参考'] }))
    if (method === 'library.folders.create') {
      const input = payload as { name: string; parentId: string | null }
      return { id: input.parentId ? childId : rootId, libraryId: library.id, parentId: input.parentId, name: input.name,
        kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0, version: 1,
        createdAt: library.createdAt, updatedAt: library.updatedAt }
    }
    if (method === 'library.files.upload' && ++attempts === 2) throw new Error('upload offline')
    return true
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryChooseLocalFolder }))
  await screen.findByText(/项目资料\/参考\/第一份.md/)
  expect(f.read).toHaveBeenCalledWith('library.files.upload.select', { mode: 'folder' })
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  fireEvent.click(upload)
  await screen.findByRole('alert')
  expect(screen.queryByText(/第一份.md/)).toBeNull()
  expect(f.read.mock.calls.filter(([method]) => method === 'library.folders.create')).toHaveLength(2)
  fireEvent.click(upload)
  await waitFor(() => { expect(f.committed).toHaveBeenCalledOnce() })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.folders.create')).toHaveLength(2)
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.files.upload')
  expect(writes).toHaveLength(3)
  expect(writes.every(([, input]) => (input as { parentId: string }).parentId === childId)).toBe(true)
  expect(writes[2]).toEqual(writes[1])
})

it('uploads the selected root and empty subfolders, retaining folder keys through an unknown creation result', async () => {
  const f = fixture()
  const rootId = '44444444-4444-4444-8444-444444444444', emptyId = '55555555-5555-4555-8555-555555555555'
  const root = { selectionId: '66666666-6666-4666-8666-666666666666', kind: 'FOLDER', name: '整个项目', sizeBytes: 0 }
  const empty = { ...root, selectionId: '77777777-7777-4777-8777-777777777777', name: '空目录', folders: [root.name] }
  let creations = 0
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.files.upload.select') return [root, empty, { ...first, folders: [root.name] }]
    if (method === 'library.folders.create') {
      const input = payload as { name: string; parentId: string | null }
      if (++creations === 2) throw new Error('creation result unknown')
      return { id: input.parentId ? emptyId : rootId, libraryId: library.id, parentId: input.parentId, name: input.name,
        kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0, version: 1,
        createdAt: library.createdAt, updatedAt: library.updatedAt }
    }
    return true
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryChooseLocalFolder }))
  await screen.findByText('整个项目/空目录')
  const dialog = screen.getByRole('dialog', { name: zh.libraryUpload })
  const upload = screen.getByRole('button', { name: zh.libraryUpload })
  upload.focus(); fireEvent.click(upload)
  const error = await screen.findByRole('alert')
  expect(f.committed).not.toHaveBeenCalled()
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload')).toHaveLength(0)
  const remaining = screen.getByText('整个项目/空目录')
  expect(document.activeElement).toBe(upload)
  fireEvent.click(upload); fireEvent.click(upload)
  await waitFor(() => { expect(f.committed).toHaveBeenCalledOnce() })
  expect(screen.getByRole('dialog', { name: zh.libraryUpload })).toBe(dialog)
  expect(error.isConnected).toBe(true)
  expect(remaining.isConnected).toBe(false)
  expect(document.activeElement).toBe(upload)
  const folders = f.read.mock.calls.filter(([method]) => method === 'library.folders.create')
  expect(folders).toHaveLength(3)
  expect(folders[2]).toEqual(folders[1])
  expect(folders[0]?.[1]).toMatchObject({ name: root.name, parentId: null })
  expect(folders[1]?.[1]).toMatchObject({ name: empty.name, parentId: rootId })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload')).toEqual([
    ['library.files.upload', expect.objectContaining({ selectionId: first.selectionId, parentId: rootId })],
  ])
})

it('removes a selected folder with its descendants while retaining a similarly named sibling and its focus', async () => {
  const f = fixture()
  const root = { selectionId: '66666666-6666-4666-8666-666666666666', kind: 'FOLDER', name: '项目', sizeBytes: 0 }
  f.read.mockImplementation(async method => method === 'library.files.upload.select'
    ? [root, { ...first, folders: [root.name, '子目录'] }, { ...second, folders: ['项目备份'] }] : true)
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFolder })
  fireEvent.click(choose)
  await screen.findByText('项目')
  const sibling = screen.getByText(/项目备份\/第二份.md/)
  choose.focus()
  fireEvent.click(screen.getByRole('button', { name: `${zh.remove}: 项目` }))
  expect(screen.queryByText(/第一份.md/)).toBeNull()
  expect(screen.getByText(/项目备份\/第二份.md/)).toBe(sibling)
  expect(document.activeElement).toBe(choose)
  await waitFor(() => { expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload.discard')).toEqual([
    ['library.files.upload.discard', { selectionId: root.selectionId }],
    ['library.files.upload.discard', { selectionId: first.selectionId }],
  ]) })
})

it('rejects a repeated selection without replacing pending rows or retaining duplicate native handles', async () => {
  const f = fixture(), duplicate = { ...first, selectionId: '77777777-7777-4777-8777-777777777777' }
  let selections = 0
  f.read.mockImplementation(async method => method === 'library.files.upload.select'
    ? ++selections === 1 ? [first] : [duplicate] : true)
  const choose = screen.getByRole('button', { name: zh.libraryChooseLocalFiles })
  fireEvent.click(choose)
  const row = await screen.findByText(/第一份.md/)
  choose.focus(); fireEvent.click(choose)
  expect((await screen.findByRole('alert')).textContent).toContain(zh.librarySelectionConflict)
  expect(screen.getByText(/第一份.md/)).toBe(row)
  expect(document.activeElement).toBe(choose)
  await waitFor(() => { expect(f.read.mock.calls).toContainEqual(['library.files.upload.discard', { selectionId: duplicate.selectionId }]) })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryUpload }))
  await waitFor(() => { expect(f.committed).toHaveBeenCalledOnce() })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload')).toEqual([
    ['library.files.upload', expect.objectContaining({ selectionId: first.selectionId })],
  ])
})
