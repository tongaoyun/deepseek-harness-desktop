// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LocalSchedulesPanel } from './LocalSchedulesPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('uses the compact composer, defaults to daily 09:00 and saves a chosen model', async () => {
  const save = vi.fn(async () => [])
  const controller = { items: [], error: '', save, refresh: vi.fn(), action: vi.fn(async () => {}) }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<LocalSchedulesPanel controller={controller} models={['test-model']} onOpenTask={() => {}} />))
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-new-button')!.click())
    expect(container.textContent).not.toContain('识别时间')
    expect(container.querySelector('.schedule-composer [aria-label="任务模型"]')).not.toBeNull()
    expect(container.querySelector('.schedule-composer [aria-label="添加附件"]')).not.toBeNull()
    expect(container.querySelector('form')!.checkValidity()).toBe(false)
    const time = container.querySelector<HTMLInputElement>('[aria-label="执行时刻"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(time, '09:')
      time.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(time.checkValidity()).toBe(false)
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-clock-columns [aria-label="小时"] [aria-pressed=true]')!.click())
    expect(time.value).toBe('09:00')
    expect(time.checkValidity()).toBe(true)
    await act(async () => {
      const name = container.querySelector<HTMLInputElement>('input[maxlength="100"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '日报')
      name.dispatchEvent(new Event('input', { bubbles: true }))
      const prompt = container.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, '整理日报')
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="任务模型"] button')[1].click())
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ cronExpression: '0 9 * * *', prompt: '整理日报', model: 'test-model', directories: [] }), undefined)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows recovery instead of an empty catalog when schedules cannot be read', async () => {
  const refresh = vi.fn()
  const controller = { items: [], error: '本机调度已暂停', save: vi.fn(), refresh, action: vi.fn() }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<LocalSchedulesPanel controller={controller} onOpenTask={() => {}} />))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('本机调度已暂停')
    expect(container.textContent).not.toContain('暂无定时任务')
    await act(async () => container.querySelector<HTMLButtonElement>('.schedule-toolbar [role="tab"]:last-child')!.click())
    expect(container.textContent).not.toContain('暂无执行记录')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '重新检查并恢复')!.click())
    expect(refresh).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); container.remove() }
})
