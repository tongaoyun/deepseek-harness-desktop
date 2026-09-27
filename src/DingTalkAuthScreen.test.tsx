// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DingTalkAuthScreen } from './DingTalkAuthScreen'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('keeps the retry control visible and disabled while checking', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const onReopen = vi.fn()
  await act(async () => root.render(<DingTalkAuthScreen authorizing={false} checking={true} error="" onReopen={onReopen} />))
  const button = container.querySelector('button')!
  expect(button.textContent).toBe('正在检查…')
  expect(button.disabled).toBe(true)
  await act(async () => root.render(<DingTalkAuthScreen authorizing={false} checking={false} error="暂时无法连接钉钉登录服务" onReopen={onReopen} />))
  expect(button.textContent).toBe('重新打开钉钉')
  expect(button.disabled).toBe(false)
  await act(async () => button.click())
  expect(onReopen).toHaveBeenCalledOnce()
  await act(async () => root.render(<DingTalkAuthScreen authorizing={false} checking={false} error="" onReopen={onReopen} />))
  expect(button.textContent).toBe('打开钉钉')
  expect(container.textContent).toContain('已登录钉钉的账号无需扫码')
  await act(async () => root.unmount())
  container.remove()
})
