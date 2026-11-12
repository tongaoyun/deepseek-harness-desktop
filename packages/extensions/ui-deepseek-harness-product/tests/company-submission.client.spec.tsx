// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en, zh } from '../src/locales.ts'
import { CompanyContentSubmission } from '../src/client/CompanyContentSubmission.tsx'

const t = makeTranslate(zh, commonZh)
const english = makeTranslate(en, commonEn)
const candidate = { resourceKey: 'skills/orders', files: { 'skills/orders/SKILL.md': 'ZmlsZQ==' } }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function fixture(initialSession = Promise.resolve({ authenticated: true, employeeId: 'alice' })) {
  let listener: ((event: { type: string; payload?: unknown }) => void) | undefined
  const invoke = vi.fn(async (_namespace: string, method: string): Promise<unknown> => ({ ok: true, result: method === 'auth.getSession'
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

it.each((['prepare', 'inspect', 'submit'] as const).flatMap(stage => [false, true].map(elsewhere => ({ stage, elsewhere }))))(
  'hands owned action focus to Close after $stage confirms review status (elsewhere=$elsewhere)', async ({ stage, elsewhere }) => {
    const f = fixture()
    const response = Promise.withResolvers<unknown>()
    onTestFinished(() => { f.view.unmount(); response.resolve(undefined) })
    const prepare = vi.fn(async () => candidate)
    if (stage === 'prepare') prepare.mockRejectedValueOnce(new Error('Preparation failed'))
    if (stage === 'inspect') f.invoke.mockRejectedValueOnce(new Error('Inspection failed'))
    if (stage === 'submit') await open(prepare)
    else {
      await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
        cancelable: true, detail: { name: '订单核对', prepare },
      })))
      await screen.findByRole('alert')
    }
    f.invoke.mockImplementationOnce(async () => ({ ok: true, result: await response.promise }))
    const action = screen.getByRole<HTMLButtonElement>('button', { name: stage === 'submit' ? zh.companySubmitTitle : t('retry') })
    const closes = screen.getAllByRole<HTMLButtonElement>('button', { name: t('close') })
    action.focus()
    act(() => { action.click(); action.click() })
    if (elsewhere) closes[0]!.focus()
    const status = { status: stage === 'prepare' ? 'PUBLISHED' : stage === 'inspect' ? 'REJECTED' : 'SUBMITTED', reviewNote: '' }
    await act(async () => { response.resolve(stage === 'submit' ? status : { status }) })
    const notice = screen.getByRole('status')
    expect(document.activeElement).toBe(elsewhere ? closes[0] : closes.at(-1))
    const completed = screen.getByRole<HTMLButtonElement>('button', { name: zh.companySubmitTitle })
    expect(completed.disabled).toBe(true)
    fireEvent.click(completed)
    expect(f.invoke.mock.calls.filter(call => call[1] === 'content.submissions.submit')).toHaveLength(stage === 'submit' ? 1 : 0)
    expect(f.invoke.mock.calls.filter(call => call[1] === 'content.submissions.inspect')).toHaveLength(stage === 'inspect' ? 2 : 1)
    expect({ status: notice.textContent, focus: elsewhere ? 'header-close' : 'footer-close', disabled: completed.disabled }).toMatchSnapshot()
  },
)

it('retains action focus and permits retry when a review response is invalid', async () => {
  const f = fixture(); await open()
  f.invoke.mockResolvedValueOnce({ ok: true, result: { status: 'INVALID', reviewNote: '' } })
  const action = screen.getByRole<HTMLButtonElement>('button', { name: zh.companySubmitTitle })
  action.focus(); fireEvent.click(action)
  await screen.findByRole('alert')
  expect(document.activeElement).toBe(action)
  expect(action.disabled).toBe(false)
  expect(screen.queryByRole('status')).toBeNull()
})

it('keeps the failed submission and its button stable while retrying once', async () => {
  const f = fixture()
  const response = Promise.withResolvers<unknown>()
  onTestFinished(() => { f.view.unmount(); response.resolve({ status: 'SUBMITTED', reviewNote: '' }) })
  await open()
  f.invoke.mockRejectedValueOnce(new Error('Offline'))
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: zh.companySubmitTitle })
  submit.focus()
  fireEvent.click(submit)
  const notice = await screen.findByRole('alert')
  expect(document.activeElement).toBe(submit)
  f.invoke.mockImplementationOnce(async () => ({ ok: true, result: await response.promise }))
  act(() => { submit.click(); submit.click(); fireEvent.keyDown(submit, { key: 'Escape' }) })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: zh.companySubmitWorking })).toBe(submit)
  expect(document.activeElement).toBe(submit)
  expect(submit.disabled).toBe(false)
  expect(submit.getAttribute('aria-disabled')).toBe('true')
  expect(submit.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(screen.getAllByRole('button', { name: t('close') }).at(-1)!)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  expect(f.invoke.mock.calls.filter(call => call[1] === 'content.submissions.submit')).toHaveLength(2)
  expect({ message: notice.textContent, action: submit.textContent, focused: document.activeElement === submit })
    .toMatchSnapshot('Pending submission retry')
  await act(async () => { response.resolve({ status: 'SUBMITTED', reviewNote: '' }) })
  await screen.findByText(zh.companySubmitted)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['prepare', 'inspect', 'submit'] as const)('localizes the %s failure without rendering internal exception text or repeating the operation', async (stage) => {
  const f = fixture()
  const failure = new Error('Internal filesystem path /private/content with confidential diagnostics')
  if (stage === 'submit') {
    await open()
    f.invoke.mockRejectedValueOnce(failure)
    fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  } else {
    if (stage === 'inspect') f.invoke.mockRejectedValueOnce(failure)
    await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
      cancelable: true, detail: { name: '订单核对', prepare: async () => { if (stage === 'prepare') throw failure; return candidate } },
    })))
  }
  expect((await screen.findByRole('alert')).textContent).toBe(zh.companySubmitFailed)
  const calls = f.invoke.mock.calls.length
  f.view.rerender(<CompanyContentSubmission t={english} />)
  expect(screen.getByRole('alert').textContent).toBe(en.companySubmitFailed)
  expect(screen.getByRole('dialog').textContent).not.toContain('/private/content')
  expect(screen.getByRole('dialog').textContent).toContain('订单核对')
  expect(f.invoke).toHaveBeenCalledTimes(calls)
  if (stage === 'submit') expect(screen.getByText(en.companySubmitFiles.replace('{count}', '1'))).toBeDefined()
})

it('retains a recognized permission diagnostic when the submission language changes', async () => {
  const f = fixture(); await open()
  f.invoke.mockResolvedValueOnce({ ok: false, failure: { code: 'EMPLOYEE_UNAUTHORIZED', message: 'Private authentication diagnostic',
    retryable: false, resources: [] } })
  fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.employeeSignInRequired)
  f.view.rerender(<CompanyContentSubmission t={english} />)
  expect(screen.getByRole('alert').textContent).toBe(en.employeeSignInRequired)
  expect(screen.getByRole('dialog').textContent).not.toContain('Private authentication diagnostic')
  expect(f.invoke.mock.calls.filter(call => call[1] === 'content.submissions.submit')).toHaveLength(1)
})

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
  await screen.findByText(zh.companySubmitFailed)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.companySubmitTitle }).disabled).toBe(false)
  await act(async () => f.changeIdentity())
  expect(screen.queryByRole('dialog')).toBeNull()
  // The failed request already settled; its abort listener was released and
  // must not issue a second cancellation during identity cleanup.
  expect(f.cancel).not.toHaveBeenCalled()
})

it.each(['prepare', 'inspect'] as const)('retries a failed %s without closing the dialog or submitting unconfirmed content', async (stage) => {
  const f = fixture()
  const prepare = vi.fn(async () => candidate)
  if (stage === 'prepare') prepare.mockRejectedValueOnce(new Error('内容读取失败'))
  else f.invoke.mockImplementationOnce(async () => { throw new Error('审核状态读取失败') })
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
    cancelable: true, detail: { name: '订单核对', prepare },
  })))
  const notice = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: t('retry') })
  expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
  expect(f.invoke.mock.calls.filter(call => call[1].endsWith('submit'))).toHaveLength(0)
  const response = Promise.withResolvers<undefined>()
  onTestFinished(() => { f.view.unmount(); response.resolve(undefined) })
  if (stage === 'prepare') prepare.mockImplementationOnce(async () => { await response.promise; return candidate })
  else f.invoke.mockImplementationOnce(async () => { await response.promise; return { ok: true, result: { status: null } } })
  retry.focus()
  await act(async () => { fireEvent.click(retry); fireEvent.click(retry) })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: t('retry') })).toBe(retry)
  expect(document.activeElement).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status')).toBeNull()
  expect({ message: notice.textContent, action: retry.textContent, working: screen.queryByRole('status') !== null,
    focused: document.activeElement === retry })
    .toMatchSnapshot('Pending preparation retry')
  await act(async () => { response.resolve(undefined) })
  await screen.findByText('包含 1 个文件')
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.invoke.mock.calls.filter(call => call[1].endsWith('submit'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: zh.companySubmitTitle }))
  await screen.findByText('已提交，等待管理员审核。')
  expect(f.invoke.mock.calls.filter(call => call[1].endsWith('submit'))).toHaveLength(1)
})

it('cancels a preparation retry on close and ignores its late result', async () => {
  const f = fixture()
  const prepared = Promise.withResolvers<typeof candidate>()
  const prepare = vi.fn(async (_signal: AbortSignal) => prepared.promise).mockRejectedValueOnce(new Error('读取失败'))
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
    cancelable: true, detail: { name: '订单核对', prepare },
  })))
  fireEvent.click(await screen.findByRole('button', { name: t('retry') }))
  const signal = prepare.mock.calls[1]![0]
  expect(signal.aborted).toBe(false)
  fireEvent.click(screen.getAllByRole('button', { name: t('close') }).at(-1)!)
  expect(signal.aborted).toBe(true)
  await act(async () => { prepared.resolve(candidate) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.invoke.mock.calls.filter(call => call[1] !== 'auth.getSession')).toHaveLength(0)
})

it('uses the review status recovered by a retry to prevent a duplicate submission', async () => {
  const f = fixture()
  f.invoke.mockImplementationOnce(async () => { throw new Error('状态读取失败') })
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
    cancelable: true, detail: { name: '订单核对', prepare: async () => candidate },
  })))
  await screen.findByRole('alert')
  f.invoke.mockImplementationOnce(async () => ({ ok: true, result: { status: { status: 'SUBMITTED', reviewNote: '' } } }))
  fireEvent.click(screen.getByRole('button', { name: t('retry') }))
  await screen.findByText('已提交，等待管理员审核。')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh.companySubmitTitle }).disabled).toBe(true)
  expect(f.invoke.mock.calls.filter(call => call[1].endsWith('submit'))).toHaveLength(0)
})

it('replaces a pending retry with a new content intent without accepting the old result', async () => {
  const f = fixture()
  const previous = Promise.withResolvers<typeof candidate>()
  const next = Promise.withResolvers<typeof candidate>()
  onTestFinished(() => { f.view.unmount(); previous.resolve(candidate); next.resolve(candidate) })
  const prepare = vi.fn(async (_signal: AbortSignal) => previous.promise).mockRejectedValueOnce(new Error('读取失败'))
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
    cancelable: true, detail: { name: '订单核对', prepare },
  })))
  fireEvent.click(await screen.findByRole('button', { name: t('retry') }))
  const previousSignal = prepare.mock.calls[1]![0]
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', {
    cancelable: true, detail: { name: '新内容', prepare: () => next.promise },
  })))
  expect(previousSignal.aborted).toBe(true)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText('新内容')).toBeDefined()
  await act(async () => { previous.resolve(candidate) })
  expect(screen.queryByText('包含 1 个文件')).toBeNull()
  expect(screen.getByRole('button', { name: t('companySubmitWorking') }).getAttribute('aria-busy')).toBe('true')
  expect(f.invoke.mock.calls.filter(call => call[1] !== 'auth.getSession')).toHaveLength(0)
  await act(async () => { next.resolve(candidate) })
  expect(await screen.findByText('包含 1 个文件')).toBeDefined()
  expect(f.invoke.mock.calls.filter(call => call[1] === 'content.submissions.inspect')).toHaveLength(1)
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
  expect(closeButtons.at(-1)!.disabled).toBe(false)
  expect(closeButtons.at(-1)!.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(closeButtons[0]!)
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByRole('button', { name: t('companySubmitWorking') }).getAttribute('aria-busy')).toBe('true')
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
