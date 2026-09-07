// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { FeedbackButton } from './FeedbackButton'
import { validateFeedbackImages } from './feedback'
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => vi.restoreAllMocks())

it('opens outside a hidden account menu, preserves failed drafts, and submits text with images once', async () => {
  let sequence = 0
  const revoke = vi.fn()
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:test-${++sequence}`), revokeObjectURL: revoke })
  const submit = vi.fn().mockRejectedValueOnce(new Error('连接失败')).mockResolvedValueOnce(undefined)
  const container = document.body.appendChild(document.createElement('section'))
  const root = createRoot(container)
  const click = async (label: string) => { await act(async () => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent === label); expect(button).toBeTruthy(); button!.click() }) }
  try {
    await act(async () => root.render(<FeedbackButton onFeedback={submit} onOpen={() => { container.hidden = true }} />))
    await act(async () => container.querySelector('button')!.click())
    const dialog = document.querySelector<HTMLFormElement>('[role="dialog"]')!
    expect(dialog.closest('[hidden]')).toBeNull()
    const area = dialog.querySelector('textarea')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, '出错了\n附图说明'); area.dispatchEvent(new Event('input', { bubbles: true })) })
    const file = new File(['png'], '问题截图.png', { type: 'image/png' })
    await act(async () => { const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { files: [file] } }); area.dispatchEvent(event) })
    expect(dialog.querySelector('img')?.alt).toBe('问题截图.png')
    await click('提交反馈')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('连接失败')
    expect(area.value).toContain('出错了')
    expect(dialog.querySelectorAll('img')).toHaveLength(1)
    await act(async () => { dialog.requestSubmit(); dialog.requestSubmit() })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit).toHaveBeenLastCalledWith('出错了\n附图说明', 'BUG', [file])
    expect(document.querySelector('[role="status"]')?.textContent).toContain('已提交')
    expect(revoke).toHaveBeenCalledWith('blob:test-1')
    await click('完成')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('validates image count, content types and sizes', () => {
  const file = new File(['x'], 'x.png', { type: 'image/png' })
  expect(validateFeedbackImages([file], 4)).toContain('4 张')
  expect(validateFeedbackImages([new File(['x'], 'x.svg', { type: 'image/svg+xml' })], 0)).toContain('PNG')
  expect(validateFeedbackImages([new File([], 'x.png', { type: 'image/png' })], 0)).toContain('不能为空')
  expect(validateFeedbackImages([file], 0)).toBe('')
})
