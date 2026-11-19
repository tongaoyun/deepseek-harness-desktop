// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { Library, LibraryEntry } from '@deepseek-harness/product/library'
import { LibraryHome } from '../src/client/LibraryHome.tsx'
import { zh } from '../src/locales.ts'

const t = makeTranslate(zh, commonZh)
const timestamp = '2026-11-17T01:00:00Z'
const personal: Library = { id: '11111111-1111-4111-8111-111111111111', name: '个人资料', scope: 'PERSONAL',
  ownerId: 'employee', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: timestamp, updatedAt: timestamp }
const team: Library = { ...personal, id: '22222222-2222-4222-8222-222222222222', name: '项目共享空间', scope: 'TEAM' }
const folder: LibraryEntry = { id: '33333333-3333-4333-8333-333333333333', libraryId: team.id, parentId: null,
  name: '合同资料', kind: 'FOLDER', sha256: null, mediaType: null, sizeBytes: 0, version: 1, createdAt: timestamp, updatedAt: timestamp }
function page(data: readonly unknown[]) {
  return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0 }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([
  { parentId: null, editable: true },
  { parentId: folder.id, editable: true },
  { parentId: folder.id, editable: false },
])('uses the shared destination for parent $parentId and editable $editable', async ({ parentId, editable }) => {
  let saved = false
  let write = Promise.withResolvers<unknown>()
  const currentTeam: Library = { ...team, canManage: editable, role: editable ? 'OWNER' : 'VIEWER' }
  const destination = editable ? team : personal
  const destinationParent = editable ? parentId : null
  const read = vi.fn(async (method: string, payload: { libraryId?: string; parentId?: string | null } = {}): Promise<unknown> => {
    if (method === 'library.list') return page([personal, currentTeam])
    if (method === 'library.files.list') return page([])
    if (method === 'library.get') return payload.libraryId === team.id ? currentTeam : personal
    if (method === 'library.personal.ensure') return personal
    if (method === 'library.entries.get') return folder
    if (method === 'library.folders.create') return write.promise
    if (method === 'library.entries.list') {
      const entries = payload.libraryId === team.id && payload.parentId === null ? [folder] : []
      return page(saved && payload.libraryId === destination.id && payload.parentId === destinationParent
        ? [...entries, { ...folder, id: '44444444-4444-4444-8444-444444444444', libraryId: destination.id,
          parentId: destinationParent, name: '新建目录' }] : entries)
    }
    throw new Error(`Unexpected library method: ${method}`)
  })
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, input: Parameters<typeof read>[1]) =>
      ({ ok: true, result: await read(method, input) }),
    cancel: vi.fn(), subscribe: () => () => {},
  } })
  render(<LibraryHome t={t} renderFactorySlot={() => null} />)
  const navigation = screen.getByRole('navigation', { name: zh.libraryNavigation })
  fireEvent.click(await within(navigation).findByRole('button', { name: team.name }))
  const folderRow = await screen.findByRole('button', { name: `${folder.name}${team.name}` })
  if (parentId) {
    fireEvent.click(folderRow)
    await screen.findByText(zh.libraryEmpty)
  }
  const newButton = within(navigation).getByRole('button', { name: zh.libraryNew })
  newButton.focus(); fireEvent.click(newButton)
  fireEvent.click(await screen.findByRole('menuitem', { name: zh.libraryNewFolder }))
  const dialog = await screen.findByRole('dialog', { name: zh.libraryNewFolder })
  const name = within(dialog).getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  fireEvent.change(name, { target: { value: '新建目录' } })
  name.focus(); name.setSelectionRange(1, 3)
  const save = within(dialog).getByRole('button', { name: zh.saveResource })
  await waitFor(() => { expect(save.getAttribute('aria-disabled')).toBe('false') })
  fireEvent.click(save); fireEvent.click(save)
  await act(async () => { write.reject(new Error('write unavailable')) })
  await within(dialog).findByRole('alert')
  const writes = () => read.mock.calls.filter(([method]) => method === 'library.folders.create')
  expect(writes()).toHaveLength(1)
  expect(writes()[0]?.[1]).toMatchObject({ libraryId: destination.id, parentId: destinationParent })
  expect(read.mock.calls.some(([method]) => method === 'library.personal.ensure')).toBe(!editable)
  expect(within(dialog).getByRole('textbox', { name: zh.libraryName })).toBe(name)
  expect([name.selectionStart, name.selectionEnd]).toEqual([1, 3])
  write = Promise.withResolvers<unknown>()
  fireEvent.click(save)
  saved = true
  await act(async () => { write.resolve({ ...folder, libraryId: destination.id, parentId: destinationParent, name: '新建目录' }) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(writes()).toHaveLength(2)
  expect(writes()[1]).toEqual(writes()[0])
  expect(await screen.findByRole('button', { name: `新建目录${destination.name}` })).toBeDefined()
  expect(document.activeElement).toBe(newButton)
})
