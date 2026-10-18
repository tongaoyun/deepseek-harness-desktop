// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopFeedback } from '../src/client/DesktopFeedback.tsx'
import { zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function previewUrls() {
  const create = vi.fn((file: File) => `blob:${file.name}`), revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  return { create, revoke }
}

function feedbackBridge(fail = false) {
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown, _requestId?: string) => method === 'support.feedback.submit' && fail
    ? { ok: false, failure: { code: 'SERVER_ERROR', message: 'fixture error', retryable: true, resources: [] } }
    : { ok: true, result: method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee-1' } : { status: 'READY' } })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn(), subscribe: () => () => {} } })
  return invoke
}

it('previews screenshots inside the content editor and releases removed previews without device reporting', async () => {
  const invoke = feedbackBridge()
  const { revoke } = previewUrls()
  const view = render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  const textarea = screen.getByLabelText(zh.feedbackMessage)
  fireEvent.paste(textarea, { clipboardData: { files: [new File(['jpeg'], 'pasted.jpg', { type: 'image/jpeg' })], getData: () => '' } })
  expect(await screen.findByAltText('pasted.jpg')).toBeTruthy()
  expect(screen.getByAltText('pasted.jpg').closest('[aria-busy]')?.contains(textarea)).toBe(true)
  fireEvent.drop(textarea, { dataTransfer: { types: ['Files'], files: [new File(['webp'], 'dropped.webp', { type: 'image/webp' })] } })
  expect(await screen.findByAltText('dropped.webp')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: `${zh.remove} pasted.jpg` }))
  expect(screen.queryByAltText('pasted.jpg')).toBeNull()
  expect(revoke).toHaveBeenCalledWith('blob:pasted.jpg')
  expect(document.querySelector('input[type="file"]')).toBeNull()
  expect(document.body.textContent).not.toContain('重试上报')
  expect(invoke.mock.calls.some(call => call[1].startsWith('support.device.'))).toBe(false)
  view.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:pasted.jpg')
  expect(revoke).toHaveBeenCalledWith('blob:dropped.webp')
})

it('rejects invalid attachments atomically and preserves text clipboard behavior', async () => {
  feedbackBridge(); previewUrls()
  render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  const input = screen.getByLabelText(zh.feedbackMessage)
  fireEvent.paste(input, { clipboardData: { files: [new File(['gif'], 'bad.gif', { type: 'image/gif' })], getData: () => '' } })
  expect(screen.getByRole('alert').textContent).toBe(zh.feedbackImagesInvalid)
  expect(screen.queryByAltText('bad.gif')).toBeNull()
  fireEvent.paste(input, { clipboardData: { files: Array.from({ length: 4 }, (_, i) => new File(['png'], `${i}.png`, { type: 'image/png' })), getData: () => '' } })
  expect(await screen.findAllByRole('img')).toHaveLength(4)
  fireEvent.paste(input, { clipboardData: { files: [new File(['png'], 'fifth.png', { type: 'image/png' })], getData: () => '' } })
  expect(screen.getByRole('alert').textContent).toBe(zh.feedbackImagesInvalid)
  expect(screen.queryByAltText('fifth.png')).toBeNull()
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files: [] } })
  screen.getByLabelText(zh.feedbackMessage).dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})

it('retains image bytes and previews for an unsuccessful submission', async () => {
  const invoke = feedbackBridge(true); previewUrls()
  render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  const image = new File(['png'], 'retained.png', { type: 'image/png' })
  Object.defineProperty(image, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer })
  fireEvent.paste(screen.getByLabelText(zh.feedbackMessage), { clipboardData: { files: [image], getData: () => '' } })
  fireEvent.change(screen.getByLabelText(zh.feedbackMessage), { target: { value: '图片反馈' } })
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  await screen.findByRole('alert')
  expect(screen.getByAltText('retained.png')).toBeTruthy()
  const first = invoke.mock.calls.find(call => call[1] === 'support.feedback.submit')
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  await waitFor(() => { expect(invoke.mock.calls.filter(call => call[1] === 'support.feedback.submit')).toHaveLength(2) })
  const second = invoke.mock.calls.filter(call => call[1] === 'support.feedback.submit')[1]
  expect(second?.[2]).toEqual(first?.[2])
  expect(first?.[2]).toMatchObject({ images: [{ name: 'retained.png', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }] })
})

it('inserts mixed clipboard text at the selection and keeps images within the message length limit', async () => {
  feedbackBridge(); previewUrls()
  render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  const input = screen.getByRole('textbox', { name: zh.feedbackMessage })
  fireEvent.change(input, { target: { value: '前文后文' } })
  expect(input).toBeInstanceOf(HTMLTextAreaElement)
  if (!(input instanceof HTMLTextAreaElement)) throw new Error('Expected feedback textarea')
  input.setSelectionRange(2, 2)
  fireEvent.paste(input, { clipboardData: { files: [new File(['png'], 'mixed.png', { type: 'image/png' })], getData: () => '截图说明' } })
  expect(input.value).toBe('前文截图说明后文')
  expect(await screen.findByAltText('mixed.png')).toBeTruthy()
  fireEvent.change(input, { target: { value: '文'.repeat(1999) } })
  input.setSelectionRange(1999, 1999)
  fireEvent.paste(input, { clipboardData: { files: [new File(['png'], 'limit.png', { type: 'image/png' })], getData: () => '末尾' } })
  expect(input.value).toBe('文'.repeat(1999) + '末')
  expect(await screen.findByAltText('limit.png')).toBeTruthy()
})

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
