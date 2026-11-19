// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LibraryEntrySchema } from '@deepseek-harness/product/library'
import { LibraryArchive } from '../src/client/LibraryArchive.tsx'
import { TaskLibraryInput } from '../src/client/TaskLibraryInput.tsx'
import { useLibraryRequests } from '../src/client/library-data.ts'
import { en, zh } from '../src/locales.ts'

const t = makeTranslate(zh, commonZh)
const renderFactorySlot = () => null
const library = { id: '11111111-1111-4111-8111-111111111111', name: '目标资料库', scope: 'PERSONAL',
  ownerId: 'alice', companyId: 'company', role: 'OWNER', canManage: true, version: 1, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' }
const selection = { selectionId: '22222222-2222-4222-8222-222222222222', name: '交付资料.md', kind: 'FILE' as const, sizeBytes: 12 }
const alice = { authenticated: true, employeeId: 'alice' }
const bob = { authenticated: true, employeeId: 'bob' }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture(initial: Promise<unknown> = Promise.resolve(alice)) {
  let identity = alice
  const listeners = new Set<(event: unknown) => void>()
  const read = vi.fn(async (method: string, _payload?: unknown): Promise<unknown> => {
    if (method === 'auth.getSession') return identity
    if (method === 'library.files.archive.select') return [selection]
    if (method === 'library.list') return { data: [library], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.personal.ensure' || method === 'library.get') return library
    if (method === 'library.files.list' || method === 'library.entries.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    return true
  })
  read.mockImplementationOnce(() => initial)
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, payload?: unknown) => ({ ok: true, result: await read(method, payload) }),
    cancel,
    subscribe: (_namespace: string, listener: (event: unknown) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    },
  } })
  return { read, cancel, change(next: typeof alice) {
    identity = next
    for (const listener of listeners) listener({ type: 'session.changed', payload: next })
  } }
}
function archive() {
  return render(<LibraryArchive actionUrl="/file?sessionId=session&seq=1&index=0" available pending={false}
    t={t} renderFactorySlot={renderFactorySlot} />)
}

it('cancels archive preparation and releases a late selection without closing a newer picker', async () => {
  const f = fixture(), prepared = Promise.withResolvers<unknown>()
  archive()
  await act(async () => { await Promise.resolve() })
  f.read.mockImplementationOnce(() => prepared.promise)
  const trigger = screen.getByRole('button', { name: zh.libraryArchive })
  trigger.focus(); fireEvent.click(trigger)
  expect(screen.getByRole('button', { name: zh.saveResource }).getAttribute('aria-busy')).toBe('false')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: zh.cancel }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(f.cancel).toHaveBeenCalledOnce()
  fireEvent.click(trigger)
  const next = screen.getByRole('dialog')
  await screen.findByText(selection.name)
  await act(async () => { prepared.resolve([{ ...selection, selectionId: '33333333-3333-4333-8333-333333333333' }]) })
  expect(screen.getByRole('dialog')).toBe(next)
  await waitFor(() => { expect(f.read.mock.calls).toContainEqual(['library.files.upload.discard', { selectionId: '33333333-3333-4333-8333-333333333333' }]) })
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload')).toHaveLength(0)
})

it('uses identity events while the initial archive identity read is still pending', async () => {
  const initial = Promise.withResolvers<unknown>(), prepared = Promise.withResolvers<unknown>()
  const f = fixture(initial.promise)
  archive()
  f.read.mockImplementationOnce(() => prepared.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  await act(async () => { f.change(bob) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.cancel).toHaveBeenCalledOnce()
  await act(async () => { initial.resolve(alice); prepared.resolve([selection]) })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  await screen.findByText(selection.name)
  const dialog = screen.getByRole('dialog')
  await act(async () => { f.change(bob) })
  expect(screen.getByRole('dialog')).toBe(dialog)
})

it('clears the attachment picker on an identity event before the initial read settles', async () => {
  const initial = Promise.withResolvers<unknown>(), f = fixture(initial.promise)
  let open!: () => void
  render(<TaskLibraryInput openEmployeeSignIn={vi.fn()} focusInput={vi.fn()} sessionId={SessionId('session')} t={t} renderFactorySlot={renderFactorySlot}
    subscribeOpen={(callback) => { open = callback; return () => {} }} attachLibraryFiles={vi.fn()} />)
  act(() => { open() })
  await screen.findByRole('dialog')
  await act(async () => { f.change(bob) })
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { initial.resolve(alice) })
  act(() => { open() })
  const dialog = screen.getByRole('dialog')
  await act(async () => { f.change(bob) })
  expect(screen.getByRole('dialog')).toBe(dialog)
})

it('does not request sign-in after a completed attachment picker loses its employee session', async () => {
  const f = fixture(), attach = vi.fn(async () => {}), signIn = vi.fn(), focusInput = vi.fn()
  let open!: () => void
  const file = LibraryEntrySchema.parse({
    id: selection.selectionId, libraryId: library.id, parentId: null, name: selection.name, kind: 'FILE',
    sha256: 'a'.repeat(64), mediaType: 'text/markdown', sizeBytes: 12, version: 1,
    createdAt: library.createdAt, updatedAt: library.updatedAt,
  })
  render(<TaskLibraryInput openEmployeeSignIn={signIn} focusInput={focusInput} sessionId={SessionId('session')} t={t}
    renderFactorySlot={renderFactorySlot} subscribeOpen={(callback) => { open = callback; return () => {} }} attachLibraryFiles={attach} />)
  await act(async () => { await Promise.resolve() })
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, payload) => method === 'library.entries.list'
    ? { data: [file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 } : original(method, payload))
  act(() => { open() })
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryPersonal }))
  await screen.findByRole('checkbox', { name: file.name })
  fireEvent.click(screen.getByRole('checkbox', { name: file.name }))
  const submit = screen.getByRole('button', { name: zh.libraryAttach.replace('{count}', '1') })
  attach.mockRejectedValueOnce(new Error('File admission unavailable'))
  fireEvent.click(submit)
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: zh.libraryAttach.replace('{count}', '1') })).toBe(submit)
  fireEvent.click(submit)
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(attach).toHaveBeenCalledTimes(2)
  await act(async () => { f.change({ authenticated: false, employeeId: '' }) })
  expect(signIn).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  act(() => { open() })
  expect(signIn).toHaveBeenCalledExactlyOnceWith(focusInput)
})

it.each(['count', 'bytes'] as const)('explains the attachment %s limit and recovers without replacing the picker', async (limit) => {
  const f = fixture(), attach = vi.fn(async () => {})
  let open!: () => void
  const subscribeOpen = (callback: () => void) => { open = callback; return () => {} }
  const props = { openEmployeeSignIn: vi.fn(), focusInput: vi.fn(), sessionId: SessionId('session'),
    renderFactorySlot, subscribeOpen, attachLibraryFiles: attach }
  const view = render(<TaskLibraryInput {...props} t={t} />)
  await act(async () => { await Promise.resolve() })
  const files = Array.from({ length: limit === 'count' ? 21 : 3 }, (_, index) => LibraryEntrySchema.parse({
    id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, libraryId: library.id, parentId: null,
    name: `资料 ${index}.md`, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown',
    sizeBytes: limit === 'count' || index === 2 ? 1 : (index === 0 ? 60 : 40) * 1024 * 1024,
    version: 1, createdAt: library.createdAt, updatedAt: library.updatedAt,
  }))
  const original = f.read.getMockImplementation()!
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.entries.list') {
      const page = typeof payload === 'object' && payload !== null && 'page' in payload ? Number(payload.page) : 1
      return { data: files.slice((page - 1) * 20, page * 20), pageIndex: page, pageSize: 20,
        totalCount: files.length, totalPages: limit === 'count' ? 2 : 1 }
    }
    return original(method, payload)
  })
  act(() => { open() })
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryPersonal }))
  const choose = (index: number) => screen.getByRole<HTMLInputElement>('checkbox', { name: files[index]!.name })
  await screen.findByRole('checkbox', { name: files[0]!.name })
  const chosen = files.length - 1
  const firstPageChoices = screen.getAllByRole('checkbox')
  for (let index = 0; index < chosen; index++) fireEvent.click(firstPageChoices[index]!)
  const dialog = screen.getByRole('dialog'), search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: '资料' } })
  await waitFor(() => { expect(screen.getByRole('region', { name: zh.library }).querySelector('[aria-busy="true"]')).toBeNull() })
  if (limit === 'count') {
    fireEvent.click(screen.getByRole('button', { name: zh.libraryNext }))
    await screen.findByRole('checkbox', { name: files[chosen]!.name })
  }
  search.setSelectionRange(0, 1)
  const toggle = choose(chosen), add = screen.getByRole('button', { name: zh.libraryAttach.replace('{count}', String(chosen)) })
  toggle.focus(); fireEvent.click(toggle)
  const notice = await screen.findByRole('alert')
  const message = limit === 'count' ? '每次最多选择 20 个文件' : '所选文件总大小不能超过 100 MB'
  const english = limit === 'count' ? 'Select up to 20 files at a time.' : 'Selected files must total 100 MB or less.'
  expect(notice.textContent).toBe(message)
  expect(toggle.checked).toBe(false)
  expect(document.activeElement).toBe(toggle)
  fireEvent.click(toggle)
  expect(screen.getByRole('alert')).toBe(notice)
  const reads = f.read.mock.calls.length
  view.rerender(<TaskLibraryInput {...props} t={makeTranslate(en, commonZh)} />)
  expect(notice.textContent).toBe(english)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['资料', 0, 1])
  expect(document.activeElement).toBe(toggle)
  expect(f.read.mock.calls).toHaveLength(reads)
  expect(attach).not.toHaveBeenCalled()
  if (limit === 'count') {
    fireEvent.click(screen.getByRole('button', { name: en.libraryPrevious }))
    await screen.findByRole('checkbox', { name: files[0]!.name })
  }
  fireEvent.click(screen.getByRole('checkbox', { name: files[0]!.name }))
  expect(screen.queryByRole('alert')).toBeNull()
  if (limit === 'count') {
    fireEvent.click(screen.getByRole('button', { name: en.libraryNext }))
    await screen.findByRole('checkbox', { name: files[chosen]!.name })
  }
  fireEvent.click(screen.getByRole('checkbox', { name: files[chosen]!.name }))
  expect(screen.getByRole('button', { name: en.libraryAttach.replace('{count}', String(chosen)) })).toBe(add)
  attach.mockRejectedValueOnce(new Error('admission unavailable'))
  add.focus(); fireEvent.click(add)
  expect((await screen.findByRole('alert')).textContent).toBe(en.libraryAttachFailed)
  expect(document.activeElement).toBe(add)
  fireEvent.click(add)
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(attach).toHaveBeenCalledTimes(2)
  const accepted = files.slice(1)
  expect(attach.mock.calls[0]).toEqual([SessionId('session'), accepted, expect.any(AbortSignal)])
  expect(attach.mock.calls[1]).toEqual([SessionId('session'), accepted, expect.any(AbortSignal)])
})

it('locks archive writes until their result and preserves them across same-employee renewal', async () => {
  const f = fixture(), saved = Promise.withResolvers<unknown>()
  archive()
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  fireEvent.click(await screen.findByRole('button', { name: /目标资料库/ }))
  const save = screen.getByRole('button', { name: zh.saveResource })
  await waitFor(() => { expect(save.getAttribute('aria-disabled')).toBe('false') })
  await waitFor(() => { expect(screen.getByRole('region', { name: zh.library }).querySelector('[aria-busy="true"]')).toBeNull() })
  f.read.mockImplementationOnce(() => saved.promise)
  save.focus(); fireEvent.click(save); fireEvent.click(save)
  expect(save.getAttribute('aria-busy')).toBe('true')
  const dialog = screen.getByRole('dialog')
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const reads = f.read.mock.calls.length
  expect(search.readOnly).toBe(true)
  fireEvent.change(search, { target: { value: '不能切换的目录' } })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.library }))
  expect(within(dialog).queryByRole('button', { name: zh.refresh })).toBeNull()
  expect(search.value).toBe('')
  expect(f.read.mock.calls).toHaveLength(reads)
  fireEvent.keyDown(save, { key: 'Escape' })
  fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  await act(async () => { f.change(alice) })
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.getByRole('button', { name: zh.saveResource })).toBe(save)
  expect(document.activeElement).toBe(save)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload')).toHaveLength(1)
  await act(async () => { saved.resolve(true) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([false, true])('keeps archive retry focus without stealing active focus elsewhere (%s)', async (elsewhere) => {
  const f = fixture(), retried = Promise.withResolvers<unknown>()
  archive()
  await act(async () => { await Promise.resolve() })
  f.read.mockRejectedValueOnce(new Error('snapshot offline'))
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  const retry = await screen.findByRole('button', { name: zh.retry }), alert = screen.getByRole('alert')
  f.read.mockImplementationOnce(() => retried.promise)
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(document.activeElement).toBe(retry)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect({ retryBusy: retry.getAttribute('aria-busy'),
    saveBusy: screen.getByRole('button', { name: zh.saveResource }).getAttribute('aria-busy'),
    saveLocked: screen.getByRole('button', { name: zh.saveResource }).getAttribute('aria-disabled'),
  }).toMatchInlineSnapshot(`
    {
      "retryBusy": "true",
      "saveBusy": "false",
      "saveLocked": "true",
    }
  `)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.archive.select')).toHaveLength(2)
  const close = screen.getByRole('button', { name: zh.close })
  if (elsewhere) close.focus()
  await act(async () => { retried.resolve([selection]) })
  await screen.findByText(selection.name)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(elsewhere ? close : screen.getByRole('button', { name: zh.cancel }))
})

it('retries a failed archive write with its original destination and key', async () => {
  const f = fixture()
  archive()
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  fireEvent.click(await screen.findByRole('button', { name: /目标资料库/ }))
  const save = screen.getByRole('button', { name: zh.saveResource })
  await waitFor(() => { expect(save.getAttribute('aria-disabled')).toBe('false') })
  f.read.mockRejectedValueOnce(new Error('upload offline'))
  save.focus(); fireEvent.click(save)
  const alert = await screen.findByRole('alert')
  const retried = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => retried.promise)
  fireEvent.click(save); fireEvent.click(save)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(save)
  const calls = f.read.mock.calls.filter(([method]) => method === 'library.files.upload')
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
  await act(async () => { retried.resolve(true) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('explains the archive destination lock in the active language without rewriting or replacing controls', async () => {
  const f = fixture(), view = archive()
  await act(async () => { await Promise.resolve() })
  const original = f.read.getMockImplementation()!
  const next = { ...library, id: '44444444-4444-4444-8444-444444444444', name: '另一资料库' }
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.list') return { data: [library, next], pageIndex: 1, pageSize: 20, totalCount: 2, totalPages: 1 }
    if (method === 'library.get') return typeof payload === 'object' && payload !== null && 'libraryId' in payload
      && payload.libraryId === next.id ? next : library
    return original(method, payload)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  fireEvent.click(await screen.findByRole('button', { name: library.name }))
  const save = screen.getByRole('button', { name: zh.saveResource })
  await waitFor(() => { expect(save.getAttribute('aria-disabled')).toBe('false') })
  f.read.mockRejectedValueOnce(new Error('upload unavailable'))
  save.focus(); fireEvent.click(save)
  const notice = await screen.findByRole('alert')
  expect(notice.textContent).toBe(zh.saveFailed)
  fireEvent.click(screen.getByRole('button', { name: zh.library }))
  fireEvent.click(await screen.findByRole('button', { name: next.name }))
  await waitFor(() => { expect(save.getAttribute('aria-disabled')).toBe('false') })
  const search = screen.getByRole('searchbox')
  fireEvent.change(search, { target: { value: '保留查询' } })
  await waitFor(() => { expect(screen.getByRole('region', { name: zh.library }).querySelector('[aria-busy="true"]')).toBeNull() })
  save.focus(); fireEvent.click(save)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(notice.textContent).toBe(zh.libraryRetryDestination)
  expect(document.activeElement).toBe(save)
  const reads = f.read.mock.calls.length
  view.rerender(<LibraryArchive actionUrl="/file?sessionId=session&seq=1&index=0" available pending={false}
    t={makeTranslate(en, commonZh)} renderFactorySlot={renderFactorySlot} />)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(notice.textContent).toBe(en.libraryRetryDestination)
  expect(screen.getByRole('button', { name: en.saveResource })).toBe(save)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search).toHaveProperty('value', '保留查询')
  expect(document.activeElement).toBe(save)
  expect(f.read.mock.calls).toHaveLength(reads)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.upload')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: en.library }))
  fireEvent.click(await screen.findByRole('button', { name: library.name }))
  await waitFor(() => { expect(save.getAttribute('aria-disabled')).toBe('false') })
  const retried = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => retried.promise)
  save.focus(); fireEvent.click(save); fireEvent.click(save)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(document.activeElement).toBe(save)
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.files.upload')
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
  await act(async () => { retried.resolve(true) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('releases the snapshot and destination lock when initial identity verification fails', async () => {
  const initial = Promise.withResolvers<unknown>(), f = fixture(initial.promise)
  archive()
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  fireEvent.click(await screen.findByRole('button', { name: /目标资料库/ }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.saveResource }).getAttribute('aria-disabled')).toBe('false') })
  f.read.mockRejectedValueOnce(new Error('upload offline'))
  fireEvent.click(screen.getByRole('button', { name: zh.saveResource }))
  await screen.findByRole('alert')
  await act(async () => { initial.reject(new Error('identity unavailable')) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.read.mock.calls).toContainEqual(['library.files.upload.discard', { selectionId: selection.selectionId }])
  const original = f.read.getMockImplementation()!
  const next = { ...library, id: '44444444-4444-4444-8444-444444444444', name: '另一资料库' }
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.list') return { data: [next], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    if (method === 'library.personal.ensure' || method === 'library.get') return next
    return original(method, payload)
  })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  fireEvent.click(await screen.findByRole('button', { name: /另一资料库/ }))
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.saveResource }).getAttribute('aria-disabled')).toBe('false') })
  fireEvent.click(screen.getByRole('button', { name: zh.saveResource }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  const writes = f.read.mock.calls.filter(([method]) => method === 'library.files.upload')
  expect(writes).toHaveLength(2)
  expect(writes[1]?.[1]).toMatchObject({ libraryId: next.id })
  expect(writes[1]?.[1]).not.toEqual(writes[0]?.[1])
})

it.each(['library.files.archive.select', 'library.files.upload.select'])(
  'releases every late %s selection after view cancellation', async (method) => {
    const f = fixture(), opened = Promise.withResolvers<unknown>()
    f.read.mockReset().mockImplementationOnce(() => opened.promise)
    const { result, unmount } = renderHook(useLibraryRequests)
    const pending = result.current(method, {})
    const rejected = expect(pending).rejects.toThrow()
    unmount()
    await rejected
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.read.mockRejectedValueOnce(new Error('one selection already expired'))
    await act(async () => { opened.resolve([selection, { ...selection, selectionId: '33333333-3333-4333-8333-333333333333' }]) })
    await waitFor(() => { expect(f.read.mock.calls.filter(([call]) => call === 'library.files.upload.discard')).toHaveLength(2) })
    await waitFor(() => { expect(warning).toHaveBeenCalledOnce() })
    warning.mockRestore()
  },
)

it.each(['error', 'other'] as const)('recovers only removed archive-error focus after successful preparation (%s)', async (focused) => {
  const f = fixture(), prepared = Promise.withResolvers<unknown>()
  archive()
  await act(async () => { await Promise.resolve() })
  f.read.mockRejectedValueOnce(new Error('preparation unavailable'))
  fireEvent.click(screen.getByRole('button', { name: zh.libraryArchive }))
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  f.read.mockImplementationOnce(() => prepared.promise)
  fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.files.archive.select')).toHaveLength(2)
  const close = screen.getByRole('button', { name: zh.close }), cancel = screen.getByRole('button', { name: zh.cancel })
  const target = focused === 'error' ? alert : close
  target.focus()
  await act(async () => { prepared.resolve([selection]) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: zh.cancel })).toBe(cancel)
  expect(document.activeElement).toBe(focused === 'error' ? cancel : close)
})
