// @vitest-environment jsdom
/** Product presentation retains the native input and button behavior. */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Button, Input } from '../src/client/plugin-ui.ts'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

it('preserves native submit and reset types while default actions never submit', async () => {
  const submit = vi.fn((event: React.FormEvent<HTMLFormElement>) => { event.preventDefault() })
  await act(async () => { root.render(<form onSubmit={submit}>
    <Input aria-label="专家名称" name="name" defaultValue="初始名称" />
    <Button>预览</Button><Button type="submit" variant="primary" size="sm">保存</Button>
    <Button type="reset">重置</Button>
  </form>) })
  const [preview, save, reset] = container.querySelectorAll('button')
  await act(async () => { preview.click() })
  expect(submit).not.toHaveBeenCalled()
  await act(async () => { save.click() })
  expect(submit).toHaveBeenCalledOnce()
  const input = container.querySelector('input')!
  input.value = '尚未保存'
  await act(async () => { reset.click() })
  expect(input.value).toBe('初始名称')
})

it('disables a busy destructive action and preserves its native accessible name', async () => {
  const click = vi.fn()
  await act(async () => { root.render(<Button danger loading onClick={click} aria-label="删除专家">
    删除
  </Button>) })
  const button = container.querySelector('button')!
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('aria-label')).toBe('删除专家')
  await act(async () => { button.click() })
  expect(click).not.toHaveBeenCalled()
  await act(async () => { root.render(<Button danger onClick={click}>删除</Button>) })
  expect(button.disabled).toBe(false)
  await act(async () => { button.click() })
  expect(click).toHaveBeenCalledOnce()
})

it('forwards icons and input events through the native controls', async () => {
  const input = vi.fn()
  await act(async () => { root.render(<>
    <Input aria-label="搜索专家" type="search" icon={<span data-testid="search-icon" />} onInput={input} />
    <Button icon={<span data-testid="add-icon" />}>新建专家</Button>
  </>) })
  expect(container.querySelectorAll('[data-testid="search-icon"]')).toHaveLength(1)
  expect(container.querySelectorAll('button [data-testid="add-icon"]')).toHaveLength(1)
  const search = container.querySelector('input')!
  expect(search.type).toBe('search')
  await act(async () => search.dispatchEvent(new Event('input', { bubbles: true })))
  expect(input).toHaveBeenCalledOnce()
})
