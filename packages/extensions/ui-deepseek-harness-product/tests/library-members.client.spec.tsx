// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { LibraryMembers } from '../src/client/LibraryMembers.tsx'
import { zh } from '../src/locales.ts'
const t = makeTranslate(zh, commonZh)
const library = { id: '11111111-1111-4111-8111-111111111111', name: '团队', description: '', scope: 'TEAM',
  ownerId: 'alice', companyId: 'company', role: 'OWNER', canManage: true, version: 1,
  createdAt: '2026-11-16T01:00:00Z', updatedAt: '2026-11-16T01:00:00Z' } as const
const alice = { subjectType: 'EMPLOYEE', subjectId: 'alice', name: 'Alice', role: 'OWNER' }
const bob = { subjectType: 'EMPLOYEE', subjectId: 'bob', name: 'Bob', role: 'VIEWER' }
function page(data: readonly unknown[]) {
  return { data, pageIndex: 1, pageSize: 20, totalCount: data.length, totalPages: data.length ? 1 : 0 }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture() {
  const read = vi.fn(async (method: string, _payload?: unknown): Promise<unknown> => {
    if (method === 'library.get') return library
    if (method === 'library.members.list') return page([alice, bob])
    if (method === 'library.memberOptions.employees') return page([{ id:'bob',name:'Bob' }])
    if (method === 'library.memberOptions.departments') return [{ id:'sales',name:'销售部' }]
    return { ...library, version: 2 }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke: async (_namespace: string, method: string, payload: unknown) => ({ ok:true,result:await read(method,payload) }), cancel:vi.fn(),subscribe:()=>()=>{} } })
  const changed=vi.fn(), close=vi.fn()
  render(<LibraryMembers library={library} t={t} onChanged={changed} onClose={close} />)
  return { read,changed,close }
}
it('keeps controls and focus through failed and retried reads, and recovers focus after removal', async () => {
  const f=fixture()
  const role=await screen.findByRole('combobox',{ name:`${zh.libraryMemberRole}: Bob` })
  const search=screen.getByRole<HTMLInputElement>('searchbox')
  search.focus(); fireEvent.change(search,{ target:{ value:'Bob' } }); search.setSelectionRange(0,2)
  await waitFor(()=>{expect(f.read).toHaveBeenCalledWith('library.members.list',expect.objectContaining({ query:'Bob' }))})
  expect(screen.getByRole('combobox',{ name:`${zh.libraryMemberRole}: Bob` })).toBe(role)
  expect(document.activeElement).toBe(search); expect(search.selectionEnd).toBe(2)
  const gate=Promise.withResolvers<unknown>()
  f.read.mockImplementation(async (method) => {
    if(method==='library.get') return library
    if(method==='library.members.remove') return gate.promise
    return page([alice])
  })
  const remove=screen.getByRole('button',{ name:`${zh.libraryMemberRemove}: Bob` })
  remove.focus(); fireEvent.click(remove); fireEvent.click(remove)
  expect(f.read.mock.calls.filter(([method])=>method==='library.members.remove')).toHaveLength(1)
  await act(async()=>gate.resolve({ ...library,version:2 }))
  await waitFor(()=>expect(screen.queryByRole('combobox',{ name:`${zh.libraryMemberRole}: Bob` })).toBeNull())
  expect(document.activeElement).toBe(search)
  expect(f.changed).toHaveBeenCalledOnce()
})
it('preserves selection and draft on conflict and refreshes the version before resubmission',async()=>{
  const f=fixture()
  await screen.findByText('Bob')
  fireEvent.click(screen.getByRole('button',{ name:zh.libraryInvite }))
  const candidate=await screen.findByRole('combobox',{ name:zh.libraryChooseMember })
  await waitFor(()=>expect(candidate.textContent).toContain('Bob'))
  fireEvent.change(candidate,{ target:{ value:'bob' } })
  let fail=true
  f.read.mockImplementation(async (method)=>{
    if(method==='library.get') return { ...library,version:3 }
    if(method==='library.memberOptions.employees') return page([{ id:'bob',name:'Bob' }])
    if(method==='library.members.save'){if(fail)throw new Error('conflict');return { ...library,version:4 }}
    return page([alice,bob])
  })
  const submit=screen.getByRole('button',{ name:zh.libraryInvite })
  submit.focus(); fireEvent.click(submit)
  await screen.findByRole('alert')
  expect(screen.getByRole('combobox',{ name:zh.libraryChooseMember })).toBe(candidate)
  expect((candidate as HTMLSelectElement).value).toBe('bob')
  fireEvent.click(screen.getByRole('button',{ name:zh.retry }))
  await waitFor(()=>expect(f.read).toHaveBeenCalledWith('library.memberOptions.employees',expect.anything()))
  await waitFor(()=>expect(submit.getAttribute('aria-disabled')).toBe('false'))
  fail=false; fireEvent.click(submit)
  await waitFor(()=>expect(f.changed).toHaveBeenCalledWith(expect.objectContaining({ version:4 })))
  expect(f.read).toHaveBeenLastCalledWith('library.members.list',expect.anything())
  expect(f.read.mock.calls.filter(([m])=>m==='library.members.save').at(-1)?.[1]).toMatchObject({ version:3,subjectId:'bob',role:'VIEWER' })
  expect(document.activeElement).toBe(screen.getByRole('searchbox'))
})
it('removes owner actions immediately after transfer and reads permissions again on retry',async()=>{
  const f=fixture(); await screen.findByText('Bob')
  fireEvent.click(screen.getByRole('button',{ name:zh.libraryTransfer }))
  const candidate=await screen.findByRole('combobox',{ name:zh.libraryChooseMember })
  await waitFor(()=>expect(candidate.textContent).toContain('Bob')); fireEvent.change(candidate,{ target:{ value:'bob' } })
  f.read.mockImplementation(async (method)=>{
    if(method==='library.get'||method==='library.owner.transfer')return { ...library,ownerId:'bob',role:'EDITOR',version:2 }
    return page([{ ...alice,role:'EDITOR' },{ ...bob,role:'OWNER' }])
  })
  fireEvent.click(screen.getByRole('button',{ name:zh.libraryTransfer }))
  await waitFor(()=>expect(f.changed).toHaveBeenCalledWith(expect.objectContaining({ role:'EDITOR' })))
  expect(screen.queryByRole('button',{ name:zh.libraryInvite })).toBeNull()
  expect(screen.queryByRole('button',{ name:zh.libraryTransfer })).toBeNull()
  expect(screen.queryByRole('combobox')).toBeNull()
})
