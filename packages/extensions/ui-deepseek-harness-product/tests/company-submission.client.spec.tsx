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
function fixture() {
  let listener: ((event: { type: string }) => void) | undefined
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true, result: method.endsWith('inspect') ? { status: null } : { status: 'SUBMITTED', reviewNote: '' } }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel, subscribe: (_namespace: string, next: typeof listener) => { listener = next; return () => { listener = undefined } } } })
  const view = render(<CompanyContentSubmission t={t} />)
  return { invoke, cancel, view, changeIdentity: () => listener?.({ type: 'session.changed' }) }
}
async function open(prepare: (signal: AbortSignal) => Promise<typeof candidate> = async () => candidate) {
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { cancelable: true, detail: { name: '订单核对', prepare } })))
  await screen.findByText('包含 1 个文件')
}
it('requires confirmation, submits only once and shows durable review status', async () => {
  const { invoke } = fixture(); await open()
  expect(invoke.mock.calls.map(call => call[1])).toEqual(['content.submissions.inspect'])
  expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
  fireEvent.click(screen.getByRole('button', { name: '提交到公司' }))
  await screen.findByText('已提交，等待管理员审核。')
  expect(invoke.mock.calls.filter(call => call[1].endsWith('submit'))).toHaveLength(1)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交到公司' }).disabled).toBe(true)
})
it('retains content after failure and closes stale dialogs on identity changes', async () => {
  const f = fixture(); await open()
  f.invoke.mockRejectedValueOnce(new Error('网络不可用'))
  fireEvent.click(screen.getByRole('button', { name: '提交到公司' }))
  await screen.findByText('网络不可用')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交到公司' }).disabled).toBe(false)
  await act(async () => f.changeIdentity())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.cancel).toHaveBeenCalled()
})
it('cancels preparation when closed or unmounted without submitting', async () => {
  const f = fixture()
  let signal: AbortSignal | undefined
  await act(async () => document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { detail: { name: 'Slow', prepare: async (caller: AbortSignal) => { signal = caller; return new Promise(() => {}) } }, cancelable: true })))
  fireEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!)
  expect(signal?.aborted).toBe(true)
  f.view.unmount()
  await waitFor(() => { expect(f.invoke).not.toHaveBeenCalled() })
})
