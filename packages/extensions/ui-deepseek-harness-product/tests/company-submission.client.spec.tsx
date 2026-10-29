// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/locales.ts'
import { CompanyContentSubmission } from '../src/client/CompanyContentSubmission.tsx'

const t = makeTranslate(zh, commonZh)
const candidate = { resourceKey: 'skills/orders', files: { 'skills/orders/SKILL.md': 'ZmlsZQ==' } }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture(initialSession = Promise.resolve({ authenticated: true, employeeId: 'alice' })) {
  let listener: ((event: { type: string; payload?: unknown }) => void) | undefined
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true, result: method === 'auth.getSession'
    ? await initialSession
    : method.endsWith('inspect') ? { status: null } : { status: 'SUBMITTED', reviewNote: '' } }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel, subscribe: (_namespace: string, next: typeof listener) => { listener = next; return () => { listener = undefined } } } })
  const view = render(<CompanyContentSubmission t={t} />)
  return { invoke, cancel, view,
    changeSession: (payload: unknown) => listener?.({ type: 'session.changed', payload }),
    changeIdentity: () => listener?.({ type: 'session.changed', payload: { authenticated: true, employeeId: 'bob' } }) }
}
async function open(prepare: (signal: AbortSignal) => Promise<typeof candidate> = async () => candidate) {
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { cancelable: true, detail: { name: '订单核对', prepare } })))
  await screen.findByText('包含 1 个文件')
}
it('requires confirmation, submits only once and shows durable review status', async () => {
  const { invoke } = fixture(); await open()
  expect(invoke.mock.calls.filter(call => call[1] !== 'auth.getSession').map(call => call[1])).toEqual(['content.submissions.inspect'])
  expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
  fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  await screen.findByText('已提交，等待管理员审核。')
  expect(invoke.mock.calls.filter(call => call[1].endsWith('submit'))).toHaveLength(1)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.companySubmitTitle }).disabled).toBe(true)
})
it('retains content after failure and closes stale dialogs on identity changes', async () => {
  const f = fixture(); await open()
  f.invoke.mockRejectedValueOnce(new Error('网络不可用'))
  fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  await screen.findByText('网络不可用')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.companySubmitTitle }).disabled).toBe(false)
  await act(async () => f.changeIdentity())
  expect(screen.queryByRole('dialog')).toBeNull()
  // The failed request already settled; its abort listener was released and
  // must not issue a second cancellation during identity cleanup.
  expect(f.cancel).not.toHaveBeenCalled()
})
it('cancels preparation when closed or unmounted without submitting', async () => {
  const f = fixture()
  let signal: AbortSignal | undefined
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { detail: { name: 'Slow', prepare: async (caller: AbortSignal) => { signal = caller; return new Promise(() => {}) } }, cancelable: true })))
  fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!)
  expect(signal?.aborted).toBe(true)
  f.view.unmount()
  await waitFor(() => { expect(f.invoke.mock.calls.filter(call => call[1] !== 'auth.getSession')).toHaveLength(0) })
})

it('keeps an in-flight submission open when the same employee renews their login', async () => {
  const f = fixture(); await open()
  const response = Promise.withResolvers<{ ok: true; result: { status: string; reviewNote: string } }>()
  f.invoke.mockImplementationOnce(() => response.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  const cancellations = f.cancel.mock.calls.length
  await act(async () => f.changeSession({ authenticated: true, employeeId: 'alice', expiresAt: 'renewed' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(f.cancel).toHaveBeenCalledTimes(cancellations)
  await act(async () => { response.resolve({ ok: true, result: { status: 'SUBMITTED', reviewNote: '' } }) })
  expect(screen.getByText('已提交，等待管理员审核。')).toBeTruthy()
  await act(async () => f.changeSession({ authenticated: false }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('cancels a pending preparation when identity changes before the initial session read settles', async () => {
  const initialSession = Promise.withResolvers<{ authenticated: boolean; employeeId: string }>()
  const f = fixture(initialSession.promise)
  let preparation: AbortSignal | undefined
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
    cancelable: true, detail: { name: 'Pending', prepare: async (signal: AbortSignal) => { preparation = signal; return new Promise(() => {}) } },
  })))
  await act(async () => f.changeIdentity())
  expect(preparation?.aborted).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { initialSession.resolve({ authenticated: true, employeeId: 'alice' }) })
  await open()
  await act(async () => f.changeSession({ authenticated: true, employeeId: 'bob' }))
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('does not let a cancelled employee request unlock a newer submission', async () => {
  const f = fixture(); await open()
  let rejectOld!: (reason: Error) => void
  f.invoke.mockImplementationOnce(() => new Promise<never>((_resolve, reject) => { rejectOld = reject }))
  fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  await act(async () => f.changeIdentity())
  await open()
  let rejectNew!: (reason: Error) => void
  f.invoke.mockImplementationOnce(() => new Promise<never>((_resolve, reject) => { rejectNew = reject }))
  fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  await act(async () => { rejectOld(new Error('Old employee request cancelled')) })
  const closeButtons = screen.getAllByRole<HTMLButtonElement>('button', { name: '关闭' })
  expect(closeButtons.at(-1)!.disabled).toBe(true)
  fireEvent.click(closeButtons[0]!)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toBe(t('companySubmitWorking'))
  await act(async () => { rejectNew(new Error('New request cancelled')) })
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('keeps preparation and submission alive when the locale changes', async () => {
  const f = fixture()
  const prepared = Promise.withResolvers<typeof candidate>()
  let preparation: AbortSignal | undefined
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
    cancelable: true, detail: { name: '订单核对', prepare: (signal: AbortSignal) => { preparation = signal; return prepared.promise } },
  })))
  f.view.rerender(<CompanyContentSubmission t={(...args) => t(...args)} />)
  expect(preparation?.aborted).toBe(false)
  await act(async () => { prepared.resolve(candidate) })
  await screen.findByText('包含 1 个文件')
  const response = Promise.withResolvers<{ ok: true; result: { status: string; reviewNote: string } }>()
  f.invoke.mockImplementationOnce(() => response.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  const cancellations = f.cancel.mock.calls.length
  f.view.rerender(<CompanyContentSubmission t={(...args) => t(...args)} />)
  expect(f.cancel).toHaveBeenCalledTimes(cancellations)
  await act(async () => { response.resolve({ ok: true, result: { status: 'SUBMITTED', reviewNote: '' } }) })
  expect(screen.getByText('已提交，等待管理员审核。')).toBeTruthy()
  expect(screen.queryByText(t('companySubmitWorking'))).toBeNull()
  expect(screen.getAllByRole<HTMLButtonElement>('button', { name: '关闭' }).at(-1)!.disabled).toBe(false)
})
