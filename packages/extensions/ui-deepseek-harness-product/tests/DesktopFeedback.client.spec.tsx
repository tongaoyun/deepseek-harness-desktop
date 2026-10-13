// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopFeedback } from '../src/client/DesktopFeedback.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('keeps failed feedback and its operation ID for retries and returns only a receipt', async () => {
  let succeed = false
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown, _requestId?: string) => method === 'support.feedback.submit'
    ? succeed ? { ok: true, result: { id: 'receipt-1' } }
      : { ok: false, failure: { code: 'SERVER_ERROR', message: 'private diagnostic', retryable: true, resources: [] } }
    : { ok: true, result: method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee-1' } : { status: 'READY' } })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn(), subscribe: () => () => {} } })
  render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  const input = screen.getByLabelText(zh.feedbackMessage)
  fireEvent.change(input, { target: { value: '文件查看失败，请处理' } })
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.feedbackSendFailed)
  expect(screen.getByLabelText(zh.feedbackMessage)).toHaveProperty('value', '文件查看失败，请处理')
  const first = invoke.mock.calls.find(call => call[1] === 'support.feedback.submit')
  succeed = true
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  await screen.findByText('receipt-1')
  const calls = invoke.mock.calls.filter(call => call[1] === 'support.feedback.submit')
  expect(calls).toHaveLength(2)
  expect(calls[1]?.[2]).toEqual(first?.[2])
  expect(screen.getByLabelText(zh.feedbackMessage)).toHaveProperty('value', '')
  expect(document.body.textContent).not.toContain('private diagnostic')
})

it('cancels an in-flight request on close and retains the unsent draft on reopening', async () => {
  let rejectFeedback: ((reason: Error) => void) | undefined
  const cancel = vi.fn(() => { rejectFeedback?.(new Error('cancelled')) })
  const onClose = vi.fn()
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown, _requestId?: string) => method === 'support.feedback.submit'
    ? new Promise<never>((_resolve, reject) => { rejectFeedback = reject }) : { ok: true, result: method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee-1' } : { status: 'PENDING' } })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel, subscribe: () => () => {} } })
  const props = { onClose, t: (key: keyof typeof zh) => zh[key] }
  const view = render(<DesktopFeedback {...props} open />)
  fireEvent.change(screen.getByLabelText(zh.feedbackMessage), { target: { value: '保留草稿' } })
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  await waitFor(() =>{  expect(invoke.mock.calls.some(call => call[1] === 'support.feedback.submit')).toBe(true) })
  fireEvent.click(screen.getAllByRole('button', { name: zh.close }).at(-1)!)
  expect(cancel).toHaveBeenCalledWith('product', expect.any(String))
  expect(onClose).toHaveBeenCalledOnce()
  view.rerender(<DesktopFeedback {...props} open={false} />)
  view.rerender(<DesktopFeedback {...props} open />)
  expect(screen.getByLabelText(zh.feedbackMessage)).toHaveProperty('value', '保留草稿')
})

it('clears a previous employee draft when the account changes while the dialog is closed', async () => {
  let event: ((value: { namespace: string; type: string; payload: unknown }) => void) | undefined
  const invoke = vi.fn(async (_namespace: string, method: string) => ({ ok: true,
    result: method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee-1' } : { status: 'READY' } }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn(), subscribe: (_namespace: string, listener: typeof event) => { event = listener; return () => {} } } })
  const props = { onClose: () => undefined, t: (key: keyof typeof zh) => zh[key] }
  const view = render(<DesktopFeedback {...props} open />)
  await waitFor(() =>{  expect(invoke.mock.calls.some(call => call[1] === 'auth.getSession')).toBe(true) })
  fireEvent.change(screen.getByLabelText(zh.feedbackMessage), { target: { value: '员工一的草稿' } })
  view.rerender(<DesktopFeedback {...props} open={false} />)
  await act(async () => {
    event?.({ namespace: 'product', type: 'session.changed', payload: { authenticated: true, employeeId: 'employee-2' } })
  })
  view.rerender(<DesktopFeedback {...props} open />)
  expect(screen.getByLabelText(zh.feedbackMessage)).toHaveProperty('value', '')
})
