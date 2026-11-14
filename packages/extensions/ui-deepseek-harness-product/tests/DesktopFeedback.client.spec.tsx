// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopFeedback } from '../src/client/DesktopFeedback.tsx'
import { en, zh } from '../src/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function previewUrls() {
  const create = vi.fn((file: File) => `blob:${file.name}`), revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  return { create, revoke }
}

function feedbackBridge(fail = false) {
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown, _requestId?: string): Promise<unknown> => method === 'support.feedback.submit' && fail
    ? { ok: false, failure: { code: 'SERVER_ERROR', message: 'fixture error', retryable: true, resources: [] } }
    : { ok: true, result: method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee-1' } : { status: 'READY' } })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn(), subscribe: () => () => {} } })
  return invoke
}

it('keeps failed feedback and the send button stable while retrying once', async () => {
  const invoke = feedbackBridge(true)
  const response = Promise.withResolvers<{ ok: true; result: { id: string } }>()
  const view = render(<DesktopFeedback open onClose={vi.fn()} t={key => zh[key]} />)
  onTestFinished(() => { view.unmount(); response.resolve({ ok: true, result: { id: 'released' } }) })
  fireEvent.change(screen.getByLabelText(zh.feedbackMessage), { target: { value: '保留失败草稿' } })
  const send = screen.getByRole<HTMLButtonElement>('button', { name: zh.feedbackSend })
  send.focus()
  fireEvent.click(send)
  const error = await screen.findByRole('alert')
  await waitFor(() => { expect(send.disabled).toBe(false) })
  invoke.mockImplementationOnce(() => response.promise)
  act(() => { send.click(); send.click() })
  expect(screen.getByRole('alert')).toBe(error)
  expect(send.disabled).toBe(false)
  expect(send.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(send)
  expect(send.getAttribute('aria-busy')).toBe('true')
  expect(send.classList.contains('product-control-pending')).toBe(true)
  await waitFor(() => { expect(invoke.mock.calls.filter(call => call[1] === 'support.feedback.submit')).toHaveLength(2) })
  expect({ error: error.textContent, action: send.querySelector('[aria-hidden="false"]')?.textContent, busy: send.getAttribute('aria-busy'),
    focused: document.activeElement === send }).toMatchSnapshot()
  await act(async () => { response.resolve({ ok: true, result: { id: 'confirmed' } }) })
  await screen.findByText('confirmed')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: zh.feedbackSend })).toBe(send)
  expect(document.activeElement).toBe(screen.getByLabelText(zh.feedbackMessage))
  const calls = invoke.mock.calls.filter(call => call[1] === 'support.feedback.submit')
  expect(calls[1]?.[2]).toEqual(calls[0]?.[2])
})

it('keeps focus on another control when feedback completes after the user moves there', async () => {
  const invoke = feedbackBridge()
  const response = Promise.withResolvers<{ ok: true; result: { id: string } }>()
  const view = render(<DesktopFeedback open onClose={vi.fn()} t={key => zh[key]} />)
  onTestFinished(() => { view.unmount(); response.resolve({ ok: true, result: { id: 'released' } }) })
  fireEvent.change(screen.getByLabelText(zh.feedbackMessage), { target: { value: '保留操作位置' } })
  invoke.mockImplementationOnce(() => response.promise)
  const send = screen.getByRole('button', { name: zh.feedbackSend })
  send.focus()
  fireEvent.click(send)
  const close = screen.getAllByRole('button', { name: zh.close }).at(-1)!
  close.focus()
  await act(async () => { response.resolve({ ok: true, result: { id: 'confirmed' } }) })
  await screen.findByText('confirmed')
  expect(document.activeElement).toBe(close)
})

it('previews screenshots inside the content editor and releases removed previews without device reporting', async () => {
  const invoke = feedbackBridge()
  const { create, revoke } = previewUrls()
  const view = render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  const textarea = screen.getByLabelText(zh.feedbackMessage)
  fireEvent.paste(textarea, { clipboardData: { files: [new File(['jpeg'], 'pasted.jpg', { type: 'image/jpeg' })], getData: () => '' } })
  expect(await screen.findByAltText('pasted.jpg')).toBeTruthy()
  expect(screen.getByAltText('pasted.jpg').closest('[aria-busy]')?.contains(textarea)).toBe(true)
  fireEvent.drop(textarea, { dataTransfer: { types: ['Files'], files: [new File(['webp'], 'dropped.webp', { type: 'image/webp' })] } })
  const retained = await screen.findByAltText('dropped.webp')
  fireEvent.click(screen.getByRole('button', { name: `${zh.remove} pasted.jpg` }))
  expect(screen.queryByAltText('pasted.jpg')).toBeNull()
  expect(revoke).toHaveBeenCalledWith('blob:pasted.jpg')
  expect(screen.getByAltText('dropped.webp')).toBe(retained)
  expect(create).toHaveBeenCalledTimes(2)
  expect(revoke).not.toHaveBeenCalledWith('blob:dropped.webp')
  expect(document.querySelector('input[type="file"]')).toBeNull()
  expect(document.body.textContent).not.toContain('重试上报')
  expect(invoke.mock.calls.some(call => call[1].startsWith('support.device.'))).toBe(false)
  view.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:pasted.jpg')
  expect(revoke).toHaveBeenCalledWith('blob:dropped.webp')
})

it.each(['zh', 'en'] as const)('returns focus and the saved selection to the feedback draft after removing screenshots in %s', async (language) => {
  feedbackBridge()
  const { revoke } = previewUrls()
  const text = language === 'zh' ? zh : en
  render(<DesktopFeedback open onClose={vi.fn()} t={key => text[key]} />)
  const input = screen.getByLabelText<HTMLTextAreaElement>(text.feedbackMessage)
  fireEvent.change(input, { target: { value: '保留反馈草稿' } })
  input.setSelectionRange(1, 3)
  fireEvent.paste(input, { clipboardData: { files: ['first.png', 'middle.png', 'last.png'].map(name => new File(['png'], name, { type: 'image/png' })), getData: () => '' } })
  const retained = await screen.findByAltText('last.png')
  for (const name of ['middle.png', 'last.png', 'first.png']) {
    const remove = screen.getByRole('button', { name: `${text.remove} ${name}` })
    remove.focus()
    fireEvent.click(remove)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('保留反馈草稿')
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3])
    expect(revoke).toHaveBeenCalledWith(`blob:${name}`)
    if (name === 'middle.png') expect(screen.getByAltText('last.png')).toBe(retained)
  }
  expect({ focused: document.activeElement?.getAttribute('id') === input.id, draft: input.value,
    images: screen.queryAllByRole('img').length }).toMatchSnapshot()
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

it('translates attachment errors without discarding the feedback draft', () => {
  feedbackBridge()
  const view = render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  const input = screen.getByLabelText(zh.feedbackMessage)
  fireEvent.change(input, { target: { value: '保留草稿' } })
  fireEvent.paste(input, { clipboardData: { files: [new File(['gif'], 'bad.gif', { type: 'image/gif' })], getData: () => '' } })
  expect(screen.getByRole('alert').textContent).toBe(zh.feedbackImagesInvalid)
  view.rerender(<DesktopFeedback open onClose={() => undefined} t={key => en[key]} />)
  expect(screen.getByRole('alert').textContent).toBe(en.feedbackImagesInvalid)
  expect(screen.getByLabelText(en.feedbackMessage)).toHaveProperty('value', '保留草稿')
})

it('translates submission failures without resending or changing their retry identity', async () => {
  const invoke = feedbackBridge(true)
  const view = render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  fireEvent.change(screen.getByLabelText(zh.feedbackMessage), { target: { value: '保留失败反馈' } })
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.feedbackSendFailed)
  const first = invoke.mock.calls.find(call => call[1] === 'support.feedback.submit')
  view.rerender(<DesktopFeedback open onClose={() => undefined} t={key => en[key]} />)
  expect(screen.getByRole('alert').textContent).toBe(en.feedbackSendFailed)
  expect(invoke.mock.calls.filter(call => call[1] === 'support.feedback.submit')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: en.feedbackSend }))
  await screen.findByRole('alert')
  expect(invoke.mock.calls.filter(call => call[1] === 'support.feedback.submit')[1]?.[2]).toEqual(first?.[2])
})

it('retains image bytes and previews for an unsuccessful submission', async () => {
  const invoke = feedbackBridge(true); previewUrls()
  const response = Promise.withResolvers<{ ok: false; failure: { code: string; message: string; retryable: boolean; resources: [] } }>()
  const view = render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  onTestFinished(() => { view.unmount(); response.resolve({ ok: false, failure: { code: 'SERVER_ERROR', message: 'released', retryable: true, resources: [] } }) })
  const image = new File(['png'], 'retained.png', { type: 'image/png' })
  Object.defineProperty(image, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer })
  fireEvent.paste(screen.getByLabelText(zh.feedbackMessage), { clipboardData: { files: [image], getData: () => '' } })
  fireEvent.change(screen.getByLabelText(zh.feedbackMessage), { target: { value: '图片反馈' } })
  const preview = screen.getByAltText('retained.png')
  const remove = screen.getByRole<HTMLButtonElement>('button', { name: `${zh.remove} retained.png` })
  invoke.mockImplementationOnce(() => response.promise)
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  await waitFor(() => { expect(invoke.mock.calls.some(call => call[1] === 'support.feedback.submit')).toBe(true) })
  expect(remove.disabled).toBe(true)
  expect(remove.classList.contains('product-control-pending')).toBe(true)
  fireEvent.click(remove)
  expect(screen.getByAltText('retained.png')).toBe(preview)
  await act(async () => { response.resolve({ ok: false, failure: { code: 'SERVER_ERROR', message: 'fixture error', retryable: true, resources: [] } }) })
  await screen.findByRole('alert')
  expect(screen.getByAltText('retained.png')).toBe(preview)
  expect(screen.getByRole('button', { name: `${zh.remove} retained.png` })).toBe(remove)
  expect(remove.disabled).toBe(false)
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
  expect([input.selectionStart, input.selectionEnd]).toEqual([6, 6])
  expect(await screen.findByAltText('mixed.png')).toBeTruthy()
  fireEvent.change(input, { target: { value: '文'.repeat(1999) } })
  input.setSelectionRange(1999, 1999)
  fireEvent.paste(input, { clipboardData: { files: [new File(['png'], 'limit.png', { type: 'image/png' })], getData: () => '末尾' } })
  expect(input.value).toBe('文'.repeat(1999) + '末')
  expect([input.selectionStart, input.selectionEnd]).toEqual([2000, 2000])
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

it.each([{}, { id: '' }, { id: '   ' }, { id: 42 }])('retains feedback and its operation ID for a malformed receipt %j', async (receipt) => {
  let result = receipt
  const invoke = vi.fn(async (_namespace: string, method: string, _payload?: unknown) => ({ ok: true,
    result: method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee-1' } : result }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn(), subscribe: () => () => {} } })
  render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  fireEvent.change(screen.getByLabelText(zh.feedbackMessage), { target: { value: '保留反馈内容' } })
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.feedbackSendFailed)
  expect(screen.getByLabelText(zh.feedbackMessage)).toHaveProperty('value', '保留反馈内容')
  const first = invoke.mock.calls.find(call => call[1] === 'support.feedback.submit')
  result = { id: 'confirmed-receipt' }
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  await screen.findByText('confirmed-receipt')
  expect(invoke.mock.calls.filter(call => call[1] === 'support.feedback.submit')[1]?.[2]).toEqual(first?.[2])
  expect(screen.getByLabelText(zh.feedbackMessage)).toHaveProperty('value', '')
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

it('clears an unconfirmed employee draft and cancels its request when identity changes before the initial read', async () => {
  const initial = Promise.withResolvers<{ ok: true; result: { authenticated: boolean; employeeId: string } }>()
  const response = Promise.withResolvers<{ ok: true; result: { id: string } }>()
  let event: ((value: { namespace: string; type: string; payload: unknown }) => void) | undefined
  const invoke = vi.fn(async (_namespace: string, method: string) => method === 'auth.getSession' ? initial.promise : response.promise)
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel, subscribe: (_namespace: string, listener: typeof event) => { event = listener; return () => {} } } })
  const { revoke } = previewUrls()
  render(<DesktopFeedback open onClose={() => undefined} t={key => zh[key]} />)
  const input = screen.getByLabelText(zh.feedbackMessage)
  const image = new File(['png'], 'employee-one.png', { type: 'image/png' })
  Object.defineProperty(image, 'arrayBuffer', { value: async () => new Uint8Array([1]).buffer })
  fireEvent.paste(input, { clipboardData: { files: [image], getData: () => '' } })
  fireEvent.change(input, { target: { value: '员工一的私密反馈' } })
  fireEvent.click(screen.getByRole('button', { name: zh.feedbackSend }))
  await waitFor(() => { expect(invoke.mock.calls.some(call => call[1] === 'support.feedback.submit')).toBe(true) })
  await act(async () => event?.({ namespace: 'product', type: 'session.changed', payload: { authenticated: true, employeeId: 'employee-2' } }))
  expect(input).toHaveProperty('value', '')
  expect(screen.queryByAltText('employee-one.png')).toBeNull()
  expect(revoke).toHaveBeenCalledWith('blob:employee-one.png')
  expect(cancel).toHaveBeenCalledWith('product', expect.any(String))
  fireEvent.change(input, { target: { value: '员工二的反馈' } })
  await act(async () => {
    initial.resolve({ ok: true, result: { authenticated: true, employeeId: 'employee-1' } })
    response.resolve({ ok: true, result: { id: 'old-employee-receipt' } })
  })
  expect(input).toHaveProperty('value', '员工二的反馈')
  expect(screen.queryByText('old-employee-receipt')).toBeNull()
  await act(async () => event?.({ namespace: 'product', type: 'session.changed', payload: { authenticated: true, employeeId: 'employee-2' } }))
  expect(input).toHaveProperty('value', '员工二的反馈')
})
