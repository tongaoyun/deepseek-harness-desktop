// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { EmployeeContent } from '../src/client/EmployeeContent.tsx'
import { LibraryPanel } from '../src/client/LibraryPanel.tsx'
import { zh } from '../src/locales.ts'

const t = makeTranslate(zh, commonZh)
const alice = { authenticated: true, employeeId: 'alice' }
const bob = { authenticated: true, employeeId: 'bob' }
const library = { id: '11111111-1111-4111-8111-111111111111', name: 'alice 资料', scope: 'PERSONAL',
  ownerId: 'alice', companyId: 'company', role: 'OWNER', canManage: true, version: 1,
  createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function fixture(initial: Promise<unknown> = Promise.resolve(alice)) {
  let identity = alice
  const session = vi.fn(() => initial)
  const listeners = new Set<(event: unknown) => void>()
  const read = vi.fn(async (method: string, _payload?: unknown): Promise<unknown> => {
    if (method === 'auth.getSession') return session()
    if (method === 'library.files.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.personal.ensure' || method === 'library.get') return { ...library, name: `${identity.employeeId} 资料`, ownerId: identity.employeeId }
    if (method === 'library.entries.list') return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
    if (method === 'library.list') return { data: [{ ...library, name: `${identity.employeeId} 资料` }],
      pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 }
    return true
  })
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, payload?: unknown) => ({ ok: true, result: await read(method, payload) }),
    cancel,
    subscribe: (_namespace: string, listener: (event: unknown) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    },
  } })
  render(<><button type="button">Outside</button><EmployeeContent t={t}><LibraryPanel t={t} renderFactorySlot={() => null} /></EmployeeContent></>)
  return { read, session, cancel, change(next: typeof alice) {
    identity = next
    for (const listener of listeners) listener({ type: 'session.changed', payload: next })
  } }
}
function edit() {
  fireEvent.click(within(screen.getByRole('dialog', { name: zh.libraryUploadDestination })).getByRole('button', { name: zh.libraryNewFolder }))
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName })
  fireEvent.change(input, { target: { value: '保留的草稿' } })
  input.focus(); input.setSelectionRange(1, 4)
  return input
}

it('uses the current employee event before an older initial identity read settles', async () => {
  const initial = Promise.withResolvers<unknown>(), f = fixture(initial.promise)
  await act(async () => { f.change(bob) })
  fireEvent.click(await screen.findByRole('button', { name: zh.libraryUpload }))
  await screen.findByRole('button', { name: /bob 资料/ })
  expect(f.session).toHaveBeenCalledOnce()
  await act(async () => { initial.reject(new Error('older identity unavailable')) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: /bob 资料/ })).toBeDefined()
})

it('retains the destination picker, editor, draft and selection across same-employee renewal', async () => {
  const f = fixture()
  fireEvent.click(await screen.findByRole('button', { name: zh.libraryUpload }))
  const row = await screen.findByRole('button', { name: /alice 资料/ })
  const input = edit(), dialog = screen.getByRole('dialog', { name: zh.libraryNewFolder })
  f.session.mockRejectedValue(new Error('redundant verification unavailable'))
  await act(async () => { f.change(alice) })
  expect(screen.getByRole('dialog', { name: zh.libraryNewFolder })).toBe(dialog)
  expect(screen.getByRole('textbox', { name: zh.libraryName })).toBe(input)
  expect(input.value).toBe('保留的草稿')
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 4])
  expect(document.activeElement).toBe(input)
  expect(screen.getByRole('button', { name: /alice 资料/, hidden: true })).toBe(row)
  expect(f.session).toHaveBeenCalledOnce()
  expect(f.read.mock.calls.filter(([method]) => method === 'library.personal.ensure')).toHaveLength(1)
})

it('disposes the old employee editor and cancels its write immediately on employee change', async () => {
  const f = fixture(), written = Promise.withResolvers<unknown>()
  fireEvent.click(await screen.findByRole('button', { name: zh.libraryUpload }))
  await screen.findByRole('button', { name: /alice 资料/ })
  edit()
  f.read.mockImplementationOnce(() => written.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.saveResource }))
  f.session.mockImplementation(() => new Promise(() => {}))
  await act(async () => { f.change(bob) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: /alice 资料/ })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: zh.libraryUpload }))
  await screen.findByRole('button', { name: /bob 资料/ })
  expect(f.cancel).toHaveBeenCalledOnce()
  fireEvent.click(within(screen.getByRole('dialog', { name: zh.libraryUploadDestination })).getByRole('button', { name: zh.libraryNewFolder }))
  const next = screen.getByRole('dialog', { name: zh.libraryNewFolder })
  await act(async () => { written.resolve(true) })
  expect(screen.getByRole('dialog', { name: zh.libraryNewFolder })).toBe(next)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.libraryName }).value).toBe('')
})

it('clears private content on sign-out without waiting for another identity read', async () => {
  const f = fixture()
  fireEvent.click(await screen.findByRole('button', { name: zh.libraryUpload }))
  await screen.findByRole('button', { name: /alice 资料/ })
  edit()
  f.session.mockImplementation(() => new Promise(() => {}))
  await act(async () => { f.change({ authenticated: false, employeeId: '' }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.signIn })).toBeNull()
  expect(f.session).toHaveBeenCalledOnce()
})

it.each([false, true])('retains identity errors and retry focus without duplicate reads or stealing focus (%s)', async (elsewhere) => {
  const f = fixture(Promise.reject(new Error('identity offline')))
  const retry = await screen.findByRole('button', { name: zh.retry }), alert = screen.getByRole('alert')
  const retried = Promise.withResolvers<unknown>()
  f.session.mockImplementation(() => retried.promise)
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(f.session).toHaveBeenCalledTimes(2)
  const outside = screen.getByRole('button', { name: 'Outside' })
  if (elsewhere) outside.focus()
  await act(async () => { retried.resolve(alice) })
  await screen.findByRole('searchbox')
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(document.activeElement).toBe(elsewhere ? outside : screen.getByRole('searchbox'))
})
