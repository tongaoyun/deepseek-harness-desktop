// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { Library } from '@deepseek-harness/product/library'
import { ProductError } from '@deepseek-harness/product/errors'
import { LibraryMembers } from '../src/client/LibraryMembers.tsx'
import { zh } from '../src/locales.ts'
const t = makeTranslate(zh, commonZh)
const library = { id: '11111111-1111-4111-8111-111111111111', name: '团队', scope: 'TEAM',
  ownerId: 'alice', companyId: 'company', role: 'OWNER', canManage: true, version: 1,
  createdAt: '2026-11-16T01:00:00Z', updatedAt: '2026-11-16T01:00:00Z' } as const
const alice = { subjectType: 'EMPLOYEE', subjectId: 'alice', name: 'Alice', role: 'OWNER' }
const bob = { subjectType: 'EMPLOYEE', subjectId: 'bob', name: 'Bob', role: 'VIEWER' }
function page(data: readonly unknown[]) {
  return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0 }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture(meta: Library = library) {
  const read = vi.fn(async (method: string, _payload?: unknown): Promise<unknown> => {
    if (method === 'library.get') return meta
    if (method === 'library.members.list') return page([alice, bob])
    if (method === 'library.memberOptions.employees') return page([{ id:'bob',name:'Bob' }])
    if (method === 'library.memberOptions.departments') return [{ id:'sales',name:'销售部' }]
    return { ...library, version: 2 }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke: async (_namespace: string, method: string, payload: unknown) => ({ ok:true,result:await read(method,payload) }), cancel:vi.fn(),subscribe:()=>()=>{} } })
  const changed=vi.fn(), close=vi.fn(), confirmed=vi.fn((meta: Library) => meta)
  render(<LibraryMembers library={meta} t={t} onChanged={changed} onClose={close} onConfirmed={confirmed} />)
  return { read,changed,close,confirmed }
}
it.each([
  { role: 'OWNER', fail: false }, { role: 'OWNER', fail: true },
  { role: 'VIEWER', fail: false }, { role: 'VIEWER', fail: true },
] as const)('retains the member search through a $role transition with failed listing=$fail', async ({ role, fail }) => {
  const f = fixture({ ...library, role, canManage: role === 'OWNER' })
  if (role === 'OWNER') {
    const candidate = await screen.findByRole('button', { name: 'Bob' })
    await waitFor(() => { expect(candidate.getAttribute('aria-disabled')).toBe('false') })
  } else await screen.findByText('Bob')
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const dialog = screen.getByRole('dialog', { name: zh.libraryMembers })
  const metadata = Promise.withResolvers<unknown>()
  const next = { ...library, role: role === 'OWNER' ? 'VIEWER' : 'OWNER', canManage: role !== 'OWNER', version: 2 }
  let failed = fail
  f.read.mockImplementation(async (method) => {
    if (method === 'library.get') return metadata.promise
    if (method === 'library.members.list') {
      if (failed) throw new Error('成员读取失败')
      return page([alice, bob])
    }
    return page([{ id: 'bob', name: 'Bob' }])
  })
  search.focus(); fireEvent.change(search, { target: { value: 'Bob' } }); search.setSelectionRange(0, 2)
  await act(async () => { metadata.resolve(next) })
  if (fail) await screen.findByRole('alert')
  else await waitFor(() => { expect(f.read).toHaveBeenCalledWith('library.members.list', expect.objectContaining({
    query: next.role === 'OWNER' ? '' : 'Bob',
  })) })
  expect(screen.getByRole('dialog', { name: zh.libraryMembers })).toBe(dialog)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(search.value).toBe('Bob')
  expect([search.selectionStart, search.selectionEnd]).toEqual([0, 2])
  expect(document.activeElement).toBe(search)
  if (fail) {
    const error = screen.getByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
    retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
    expect(screen.getByRole('alert')).toBe(error)
    expect(document.activeElement).toBe(retry)
    await waitFor(() => { expect(retry.getAttribute('aria-disabled')).toBe('false') })
    failed = false; fireEvent.click(retry)
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(document.activeElement).toBe(search)
    expect(search.value).toBe('Bob')
    expect([search.selectionStart, search.selectionEnd]).toEqual([0, 2])
  }
  expect(f.read.mock.calls.filter(([method]) => method === 'library.members.list').at(-1)?.[1])
    .toMatchObject({ query: next.role === 'OWNER' ? '' : 'Bob' })
  if (next.role === 'OWNER') expect(f.read).toHaveBeenLastCalledWith('library.memberOptions.employees', expect.objectContaining({ query: 'Bob' }))
  expect(f.changed).not.toHaveBeenCalled()
})

it('keeps controls and focus through failed and retried reads, and recovers focus after removal', async () => {
  const f=fixture()
  const role=await screen.findByRole('button',{ name:`${zh.libraryMemberRole}: Bob` })
  const search=screen.getByRole<HTMLInputElement>('searchbox')
  expect(document.activeElement).toBe(search)
  search.focus(); fireEvent.change(search,{ target:{ value:'Bob' } }); search.setSelectionRange(0,2)
  await waitFor(()=>{expect(f.read).toHaveBeenCalledWith('library.members.list',expect.objectContaining({ query:'' }))})
  expect(screen.getByRole('button',{ name:`${zh.libraryMemberRole}: Bob` })).toBe(role)
  expect(document.activeElement).toBe(search); expect(search.selectionEnd).toBe(2)
  const gate=Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method) => {
    if(method==='library.get') return library
    if(method==='library.members.remove') return gate.promise
    if(method==='library.memberOptions.employees') return page([{ id:'bob',name:'Bob' }])
    return page([alice])
  })
  const remove=screen.getByRole('button',{ name:`${zh.libraryMemberRemove}: Bob` })
  remove.focus(); fireEvent.click(remove); fireEvent.click(remove)
  expect(f.read.mock.calls.filter(([method])=>method==='library.members.remove')).toHaveLength(1)
  await act(async()=>{ gate.resolve({ ...library,version:2 }) })
  await waitFor(()=>{ expect(screen.queryByRole('button',{ name:`${zh.libraryMemberRole}: Bob` })).toBeNull() })
  expect(document.activeElement).toBe(search)
  expect(f.changed).toHaveBeenCalledOnce()
})

it.each([
  { subject: 'DEPARTMENT', action: 'remove' }, { subject: 'COMPANY', action: 'remove' },
  { subject: 'DEPARTMENT', action: 'retry' }, { subject: 'COMPANY', action: 'retry' },
] as const)('returns removed $action focus to the visible $subject tab', async ({ subject, action }) => {
  const f = fixture()
  await screen.findByRole('button', { name: 'Bob' })
  const tab = screen.getByRole('tab', { name: t(subject === 'DEPARTMENT' ? 'libraryDepartment' : 'libraryCompany') })
  fireEvent.click(tab)
  const remove = screen.getByRole('button', { name: `${zh.libraryMemberRemove}: Bob` })
  await waitFor(() => { expect(remove.getAttribute('aria-disabled')).toBe('false') })
  expect(screen.queryByRole('searchbox')).toBeNull()
  f.read.mockImplementation(async (method) => {
    if (method === 'library.members.remove') {
      if (action === 'retry') throw new ProductError('LIBRARY_CONFLICT', 'Changed elsewhere', true)
      return { ...library, version: 2 }
    }
    if (method === 'library.get') return { ...library, version: 2 }
    if (method === 'library.members.list') return page([alice])
    return [{ id: 'sales', name: '销售部' }]
  })
  remove.focus(); fireEvent.click(remove)
  if (action === 'retry') {
    await screen.findByRole('alert')
    expect(document.activeElement).toBe(remove)
    const retry = screen.getByRole('button', { name: zh.retry })
    retry.focus(); fireEvent.click(retry)
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  }
  await waitFor(() => { expect(screen.queryByRole('button', { name: `${zh.libraryMemberRemove}: Bob` })).toBeNull() })
  expect(screen.getByRole('tab', { name: tab.textContent })).toBe(tab)
  expect(document.activeElement).toBe(tab)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.members.remove')).toHaveLength(1)
  expect(f.changed).toHaveBeenCalledTimes(action === 'remove' ? 1 : 0)
})

it.each(['libraryDepartment', 'libraryCompany'] as const)('keeps user-moved focus while a %s member is removed', async (subject) => {
  const f = fixture()
  await screen.findByRole('button', { name: 'Bob' })
  fireEvent.click(screen.getByRole('tab', { name: t(subject) }))
  const remove = screen.getByRole('button', { name: `${zh.libraryMemberRemove}: Bob` })
  await waitFor(() => { expect(remove.getAttribute('aria-disabled')).toBe('false') })
  const gate = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method) => {
    if (method === 'library.members.remove') return gate.promise
    if (method === 'library.get') return { ...library, version: 2 }
    if (method === 'library.members.list') return page([alice])
    return [{ id: 'sales', name: '销售部' }]
  })
  remove.focus(); fireEvent.click(remove)
  const close = screen.getAllByRole('button', { name: commonZh.close }).at(-1)!
  close.focus()
  await act(async () => { gate.resolve({ ...library, version: 2 }) })
  await waitFor(() => { expect(screen.queryByRole('button', { name: `${zh.libraryMemberRemove}: Bob` })).toBeNull() })
  expect(document.activeElement).toBe(close)
})

it('preserves selection and draft on conflict and refreshes the version before resubmission',async()=>{
  const f=fixture()
  const candidate=await screen.findByRole('button',{ name:'Bob' })
  await waitFor(()=>{ expect(candidate.textContent).toContain('Bob') })
  fireEvent.click(candidate)
  let fail=true
  f.read.mockImplementation(async (method)=>{
    if(method==='library.get') return { ...library,version:3 }
    if(method==='library.memberOptions.employees') return page([{ id:'bob',name:'Bob' }])
    if(method==='library.members.save'){if(fail)throw new Error('conflict');return { ...library,version:4 }}
    return page([alice,bob])
  })
  const dialog = screen.getByRole('dialog', { name: zh.libraryMembers })
  const memberRow = screen.getByRole('button', { name: `${zh.libraryMemberRole}: Bob` })
  const submit=screen.getByRole('button',{ name:zh.libraryInvite })
  submit.focus(); fireEvent.click(submit)
  await screen.findByRole('alert')
  expect(screen.getByRole('button',{ name:'Bob' })).toBe(candidate)
  expect(candidate.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button',{ name:zh.retry }))
  await waitFor(()=>{ expect(f.read).toHaveBeenCalledWith('library.memberOptions.employees',expect.anything()) })
  await waitFor(()=>{ expect(submit.getAttribute('aria-disabled')).toBe('false') })
  fail=false; fireEvent.click(submit)
  await waitFor(()=>{ expect(f.changed).toHaveBeenCalledWith(expect.objectContaining({ version:4 })) })
  expect(f.read).toHaveBeenCalledWith('library.members.list',expect.anything())
  expect(f.read.mock.calls.filter(([m])=>m==='library.members.save').at(-1)?.[1]).toMatchObject({ version:3,subjectId:'bob',role:'VIEWER' })
  expect(document.activeElement).toBe(submit)
  expect(screen.getByRole('dialog', { name: zh.libraryMembers })).toBe(dialog)
  expect(screen.getByRole('button', { name: `${zh.libraryMemberRole}: Bob` })).toBe(memberRow)
  expect(candidate.getAttribute('aria-pressed')).toBe('false')
})
it('removes owner actions immediately after transfer and reads permissions again on retry',async()=>{
  const f=fixture(); await screen.findByRole('button', { name: `${zh.libraryMemberRole}: Bob` })
  fireEvent.click(screen.getByRole('button',{ name:zh.libraryTeamActions }))
  fireEvent.click(screen.getByRole('menuitem',{ name:zh.libraryTransfer }))
  const candidate=await screen.findByRole('button',{ name:'Bob' })
  await waitFor(()=>{ expect(candidate.textContent).toContain('Bob') }); fireEvent.click(candidate)
  f.read.mockImplementation(async (method)=>{
    if(method==='library.get'||method==='library.owner.transfer')return { ...library,ownerId:'bob',role:'EDITOR',version:2 }
    return page([{ ...alice,role:'EDITOR' },{ ...bob,role:'OWNER' }])
  })
  fireEvent.click(screen.getByRole('button',{ name:zh.libraryTransfer }))
  await waitFor(()=>{ expect(f.changed).toHaveBeenCalledWith(expect.objectContaining({ role:'EDITOR' })) })
  expect(screen.queryByRole('button',{ name:zh.libraryInvite })).toBeNull()
  expect(screen.queryByRole('button',{ name:zh.libraryTransfer })).toBeNull()
  expect(screen.queryByRole('group', { name: zh.libraryChooseMember })).toBeNull()
})

it.each(['invite', 'remove', 'transfer'] as const)('locks a conflicted %s until reread succeeds, retaining draft controls and retry focus', async (action) => {
  const f = fixture()
  await screen.findByRole('button', { name: 'Bob' })
  if (action === 'transfer') {
    fireEvent.click(screen.getByRole('button', { name: zh.libraryTeamActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: zh.libraryTransfer }))
    await screen.findByRole('button', { name: 'Bob' })
  }
  const candidate = screen.getByRole('button', { name: 'Bob' })
  await waitFor(() => { expect(candidate.getAttribute('aria-disabled')).toBe('false') })
  fireEvent.click(candidate)
  const method = action === 'invite' ? 'library.members.save' : action === 'remove' ? 'library.members.remove' : 'library.owner.transfer'
  const submit = screen.getByRole('button', { name: action === 'invite' ? zh.libraryInvite
    : action === 'remove' ? `${zh.libraryMemberRemove}: Bob` : zh.libraryTransfer })
  f.read.mockImplementation(async (name) => {
    if (name === method) throw new ProductError('LIBRARY_CONFLICT', 'Changed elsewhere', true)
    if (name === 'library.get') return { ...library, version: 3 }
    if (name === 'library.members.list') return page([alice, bob])
    return page([{ id: 'bob', name: 'Bob' }])
  })
  fireEvent.click(submit)
  await screen.findByRole('alert')
  fireEvent.click(submit)
  expect(f.read.mock.calls.filter(([name]) => name === method)).toHaveLength(1)
  expect(submit.getAttribute('aria-disabled')).toBe('true')
  const retry = screen.getByRole('button', { name: zh.retry })
  const read = Promise.withResolvers<unknown>()
  f.read.mockImplementationOnce(() => read.promise)
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  await act(async () => { read.reject(new Error('Read failed')) })
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(document.activeElement).toBe(retry)
  expect(screen.getByRole('button', { name: 'Bob' })).toBe(candidate)
  expect(candidate.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(submit)
  expect(f.read.mock.calls.filter(([name]) => name === method)).toHaveLength(1)
  fireEvent.click(retry)
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('button', { name: 'Bob' })).toBe(candidate)
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  expect(submit.getAttribute('aria-disabled')).toBe('false')
  expect(f.changed).not.toHaveBeenCalled()
  f.read.mockImplementation(async name => name === method || name === 'library.get'
    ? { ...library, version: 4 } : name === 'library.members.list' ? page([alice]) : page([{ id: 'bob', name: 'Bob' }]))
  fireEvent.click(submit)
  await waitFor(() => { expect(f.changed).toHaveBeenCalledOnce() })
  expect(f.read.mock.calls.filter(([name]) => name === method).at(-1)?.[1]).toMatchObject({ version: 3 })
})

it('switches explicit authorization subjects and keeps existing member rows while adding', async () => {
  const f = fixture()
  const row = await screen.findByRole('button', { name: `${zh.libraryMemberRole}: Bob` })
  expect(screen.getByText(library.name)).toBeDefined()
  expect(screen.getByText(zh.libraryMemberAccessHint)).toBeDefined()
  const departments = screen.getByRole('tab', { name: zh.libraryDepartment })
  departments.focus(); fireEvent.click(departments)
  const subject = await screen.findByRole('button', { name: '销售部' })
  await waitFor(() => { expect(subject.textContent).toContain('销售部') })
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(document.activeElement).toBe(departments)
  fireEvent.click(subject)
  await waitFor(() => { expect(screen.getByRole('button', { name: zh.libraryInvite }).getAttribute('aria-disabled')).toBe('false') })
  fireEvent.click(screen.getByRole('button', { name: zh.libraryInvite }))
  await waitFor(() => { expect(f.changed).toHaveBeenCalledOnce() })
  expect(f.read).toHaveBeenCalledWith('library.members.save', expect.objectContaining({ subjectType: 'DEPARTMENT', subjectId: 'sales', role: 'VIEWER' }))
  expect(screen.getByRole('button', { name: `${zh.libraryMemberRole}: Bob` })).toBe(row)
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryCompany }))
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Bob' })).toBeNull()
  expect(screen.getByRole('button', { name: `${zh.libraryMemberRole}: Bob` })).toBe(row)
  expect(f.read.mock.calls.filter(([method]) => method === 'library.members.save')).toHaveLength(1)
})
it.each(['EDITOR', 'VIEWER'] as const)('shows members without management controls for %s', async (role) => {
  const f = fixture({ ...library, role, canManage: role === 'EDITOR' })
  await screen.findByText('Bob')
  expect(screen.queryByRole('button', { name: zh.libraryInvite })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.libraryTeamActions })).toBeNull()
  expect(screen.queryByRole('group', { name: zh.libraryChooseMember })).toBeNull()
  expect(f.read.mock.calls.every(([method]) => !method.startsWith('library.memberOptions'))).toBe(true)
})

it('keeps adding and existing members in one dialog and closes without writing', async () => {
  const f = fixture()
  expect(screen.getByRole('dialog', { name: zh.libraryMembers })).toBeDefined()
  const candidate = await screen.findByRole('button', { name: 'Bob' })
  await waitFor(() => { expect(candidate.textContent).toContain('Bob') })
  expect(f.read.mock.calls.some(([method]) => method === 'library.members.list')).toBe(true)
  expect(screen.getByRole('button', { name: `${zh.libraryMemberRole}: Bob` })).toBeDefined()
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
  fireEvent.click(candidate)
  fireEvent.click(screen.getAllByRole('button', { name: commonZh.close }).at(-1)!)
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.read.mock.calls.some(([method]) => method === 'library.members.save')).toBe(false)
})

it('closes an unchanged access choice without writing or refreshing the member directory', async () => {
  const f = fixture()
  const role = await screen.findByRole('button', { name: `${zh.libraryMemberRole}: Bob` })
  await waitFor(() => { expect(role.getAttribute('aria-disabled')).toBe('false') })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: 'Bob' } }); search.setSelectionRange(0, 2)
  await waitFor(() => { expect(role.getAttribute('aria-disabled')).toBe('false') })
  const reads = f.read.mock.calls.length
  role.focus(); fireEvent.click(role)
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: zh.libraryViewer })) })
  expect(f.read.mock.calls).toHaveLength(reads)
  expect(f.changed).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(role)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['Bob', 0, 2])
  expect(role.getAttribute('aria-disabled')).toBe('false')
  expect(screen.getByRole('button', { name: zh.libraryInvite }).getAttribute('aria-busy')).toBe('false')
})

it.each(['invite', 'access', 'remove'] as const)('keeps $action progress local and retains locked controls through failure and retry', async (action) => {
  const f = fixture()
  const access = await screen.findByRole('button', { name: `${zh.libraryMemberRole}: Bob` })
  await waitFor(() => { expect(access.getAttribute('aria-disabled')).toBe('false') })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  fireEvent.change(search, { target: { value: 'Bob' } }); search.setSelectionRange(0, 2)
  await waitFor(() => { expect(access.getAttribute('aria-disabled')).toBe('false') })
  const candidate = screen.getByRole('button', { name: 'Bob' })
  fireEvent.click(candidate)
  const invite = screen.getByRole('button', { name: zh.libraryInvite })
  const remove = screen.getByRole('button', { name: `${zh.libraryMemberRemove}: Bob` })
  const employee = screen.getByRole<HTMLButtonElement>('tab', { name: zh.libraryEmployee })
  const department = screen.getByRole('tab', { name: zh.libraryDepartment })
  const trigger = action === 'invite' ? invite : action === 'access' ? access : remove
  const original = f.read.getMockImplementation()!
  let gate = Promise.withResolvers<unknown>(), committed = false, writes = 0
  f.read.mockImplementation(async (method, payload) => {
    if (method === 'library.members.save' || method === 'library.members.remove') { writes++; return gate.promise }
    if (method === 'library.members.list' && committed) return page(action === 'remove' ? [alice] : [alice, { ...bob, role: 'EDITOR' }])
    return original(method, payload)
  })
  const start = () => {
    trigger.focus(); fireEvent.click(trigger)
    if (action === 'access') fireEvent.click(screen.getByRole('menuitem', { name: zh.libraryEditor }))
  }
  for (const outcome of ['failure', 'success'] as const) {
    start()
    await waitFor(() => { expect(writes).toBe(outcome === 'failure' ? 1 : 2) })
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(trigger)
    for (const neighbor of [invite, access, remove].filter(button => button !== trigger)) {
      expect(neighbor.getAttribute('aria-busy')).not.toBe('true')
      expect(neighbor.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(neighbor)
    }
    expect(employee.disabled).toBe(false)
    expect(employee.closest('[aria-disabled="true"]')).not.toBeNull()
    fireEvent.click(department); fireEvent.keyDown(employee, { key: 'ArrowRight' })
    expect(employee.getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('searchbox')).toBe(search)
    expect([search.value, search.selectionStart, search.selectionEnd]).toEqual(['Bob', 0, 2])
    expect(writes).toBe(outcome === 'failure' ? 1 : 2)
    if (outcome === 'failure') {
      await act(async () => { gate.reject(new Error('Member change unavailable')) })
      await screen.findByRole('alert')
      expect(trigger.getAttribute('aria-busy')).toBe('false')
      expect(document.activeElement).toBe(trigger)
      gate = Promise.withResolvers<unknown>()
    } else {
      committed = true
      await act(async () => { gate.resolve({ ...library, version: 2 }) })
    }
  }
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(screen.getByRole('searchbox')).toBe(search)
  expect(screen.getByRole('tab', { name: zh.libraryEmployee })).toBe(employee)
  expect(screen.getByRole('button', { name: zh.libraryInvite })).toBe(invite)
  if (action === 'remove') {
    await waitFor(() => { expect(screen.queryByRole('button', { name: `${zh.libraryMemberRemove}: Bob` })).toBeNull() })
    expect(document.activeElement).toBe(search)
  } else expect(document.activeElement).toBe(trigger)
  expect(writes).toBe(2)
  expect(f.changed).toHaveBeenCalledOnce()
})

it('retains failed access changes for retry and skips the confirmed role after success', async () => {
  const f = fixture(), original = f.read.getMockImplementation()!
  const role = await screen.findByRole('button', { name: `${zh.libraryMemberRole}: Bob` })
  await waitFor(() => { expect(role.getAttribute('aria-disabled')).toBe('false') })
  let currentRole = 'VIEWER', writes = 0
  f.read.mockImplementation(async (method, input) => {
    if (method === 'library.members.save') {
      writes++
      if (writes === 1) throw new Error('Permission update failed')
      currentRole = 'EDITOR'
      return { ...library, version: 2 }
    }
    if (method === 'library.members.list') return page([alice, { ...bob, role: currentRole }])
    return original(method, input)
  })
  role.focus(); fireEvent.click(role)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.libraryEditor }))
  const error = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  expect(role.getAttribute('aria-description')).toBe(zh.libraryViewer)
  expect(document.activeElement).toBe(role)
  fireEvent.click(role)
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: zh.libraryViewer })) })
  expect(screen.getByRole('alert')).toBe(error)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(writes).toBe(1)
  fireEvent.click(retry)
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(writes).toBe(1)
  fireEvent.click(role)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.libraryEditor }))
  await waitFor(() => { expect(role.getAttribute('aria-description')).toBe(zh.libraryEditor) })
  await waitFor(() => { expect(role.getAttribute('aria-disabled')).toBe('false') })
  const calls = f.read.mock.calls.length
  fireEvent.click(role)
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: zh.libraryEditor })) })
  expect(f.read.mock.calls).toHaveLength(calls)
  expect(writes).toBe(2)
  expect(f.changed).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: `${zh.libraryMemberRole}: Bob` })).toBe(role)
})

it('retains the chosen person and native access menu through failed search and retry', async () => {
  const f = fixture()
  const candidate = await screen.findByRole('button', { name: 'Bob' })
  await waitFor(() => { expect(candidate.getAttribute('aria-disabled')).toBe('false') })
  fireEvent.click(candidate)
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  const gate = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async method => method === 'library.get' ? library
    : method === 'library.members.list' ? page([alice, bob]) : gate.promise)
  search.focus(); fireEvent.change(search, { target: { value: 'missing' } }); search.setSelectionRange(1, 4)
  expect(screen.getByRole('button', { name: 'Bob' })).toBe(candidate)
  expect(candidate.getAttribute('aria-pressed')).toBe('true')
  await act(async () => { gate.reject(new Error('search failed')) })
  const error = await screen.findByRole('alert')
  expect(screen.queryByText(zh.libraryCandidatesEmpty)).toBeNull()
  expect(document.activeElement).toBe(search)
  expect(search.selectionEnd).toBe(4)
  const retry = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async method => method === 'library.get' ? library
    : method === 'library.members.list' ? page([alice, bob]) : retry.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  expect(screen.getByRole('alert')).toBe(error)
  await act(async () => { retry.resolve(page([])) })
  await screen.findByText(zh.libraryCandidatesEmpty)
  expect(screen.getByText(zh.librarySelectedMember.replace('{name}', 'Bob'))).toBeDefined()
  const access = screen.getByRole('button', { name: zh.libraryMemberRole })
  fireEvent.click(access)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.libraryEditor }))
  expect(access.textContent).toBe(zh.libraryEditor)
  expect(screen.getByRole('dialog', { name: zh.libraryMembers })).toBeDefined()
  f.read.mockImplementation(async method => method === 'library.get' || method === 'library.members.save' ? { ...library, version: 2 }
    : method === 'library.memberOptions.employees' ? page([{ id: 'bob', name: 'Bob' }]) : page([alice, bob]))
  fireEvent.click(screen.getByRole('button', { name: zh.libraryInvite }))
  await waitFor(() => { expect(f.changed).toHaveBeenCalledOnce() })
  expect(f.read).toHaveBeenCalledWith('library.members.save', expect.objectContaining({ subjectId: 'bob', role: 'EDITOR' }))
})

it('ignores an old people search after switching to departments', async () => {
  const f = fixture()
  await screen.findByRole('button', { name: 'Bob' })
  const late = Promise.withResolvers<unknown>()
  f.read.mockImplementation(async method => method === 'library.get' ? library
    : method === 'library.members.list' ? page([alice, bob])
      : method === 'library.memberOptions.departments' ? [{ id: 'sales', name: '销售部' }] : late.promise)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old request' } })
  await waitFor(() => { expect(f.read).toHaveBeenCalledWith('library.memberOptions.employees', expect.objectContaining({ query: 'old request' })) })
  fireEvent.click(screen.getByRole('tab', { name: zh.libraryDepartment }))
  const department = await screen.findByRole('button', { name: '销售部' })
  await act(async () => { late.resolve(page([{ id: 'late-person', name: '过期员工' }])) })
  expect(screen.queryByRole('button', { name: '过期员工' })).toBeNull()
  expect(screen.getByRole('button', { name: '销售部' })).toBe(department)
  expect(screen.getByRole('tab', { name: zh.libraryDepartment }).getAttribute('aria-selected')).toBe('true')
})

it.each(['button', 'escape'] as const)('publishes confirmed metadata before member failure and does not replay it on %s close', async (method) => {
  const f = fixture()
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  await screen.findByRole('button', { name: 'Bob' })
  const latest = { ...library, name: '已重新授权的共享空间', role: 'VIEWER', canManage: false, version: 2 }
  f.read.mockImplementation(async (name) => {
    if (name === 'library.get') return latest
    throw new Error('Member list unavailable')
  })
  fireEvent.change(search, { target: { value: 'Bob' } })
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: zh.libraryInvite })).toBeNull()
  expect(f.changed).not.toHaveBeenCalled()
  expect(f.confirmed).toHaveBeenLastCalledWith(latest)
  const confirmations = f.confirmed.mock.calls.length
  if (method === 'button') fireEvent.click(screen.getAllByRole('button', { name: commonZh.close }).at(-1)!)
  else fireEvent.keyDown(document, { key: 'Escape' })
  expect(f.close).toHaveBeenCalledExactlyOnceWith()
  expect(f.confirmed).toHaveBeenCalledTimes(confirmations)
  expect(f.read.mock.calls.some(([name]) => name === 'library.members.save')).toBe(false)
})


it.each(['error', 'close'] as const)('recovers removed member feedback focus without taking focus from $focus', async (focus) => {
  const f = fixture()
  const candidate = await screen.findByRole('button', { name: 'Bob' })
  await waitFor(() => { expect(candidate.getAttribute('aria-disabled')).toBe('false') })
  const response = Promise.withResolvers<unknown>()
  let fail = true
  f.read.mockImplementation(async (method) => {
    if (method === 'library.get') return library
    if (method === 'library.members.list') {
      if (fail) throw new ProductError('METHOD_NOT_ALLOWED', 'Private diagnostic', true)
      return response.promise
    }
    return page([{ id: 'bob', name: 'Bob' }])
  })
  const search = screen.getByRole<HTMLInputElement>('searchbox')
  search.focus(); fireEvent.change(search, { target: { value: 'Bob' } }); search.setSelectionRange(1, 2, 'backward')
  const error = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  retry.focus(); fireEvent.click(retry)
  await waitFor(() => { expect(retry.getAttribute('aria-disabled')).toBe('false') })
  expect(screen.getByRole('alert')).toBe(error)
  expect(document.activeElement).toBe(retry)
  fail = false
  fireEvent.click(retry)
  const target = focus === 'error' ? error : screen.getAllByRole('button', { name: zh.close }).at(-1)!
  target.focus()
  expect(document.activeElement).toBe(target)
  await act(async () => { response.resolve(page([alice, bob])) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(document.activeElement).toBe(focus === 'error' ? search : target)
  expect(screen.getByRole('searchbox')).toBe(search)
  expect([search.value, search.selectionStart, search.selectionEnd, search.selectionDirection]).toEqual(['Bob', 1, 2, 'backward'])
  expect(screen.getByRole('button', { name: 'Bob' })).toBe(candidate)
  expect(f.changed).not.toHaveBeenCalled()
})
