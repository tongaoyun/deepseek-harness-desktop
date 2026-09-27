// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ConnectorJsonModal } from './ExtensionPageActions'

it('awaits each save, reports partial failures and retries only unsaved entries', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let finish: (() => void) | undefined
  const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    .mockRejectedValueOnce(new Error('磁盘写入失败')).mockResolvedValue(undefined)
  const close = vi.fn()
  try {
    await act(async () => root.render(<ConnectorJsonModal existingIds={['existing']} onClose={close} onSave={save} />))
    const input = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, JSON.stringify({ mcpServers: {
        first: { command: 'node' }, second: { type: 'streamable-http', url: 'https://example.com/mcp' }, existing: { command: 'node' }, bad: {},
      } }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('导入 2 个服务')
    expect(container.textContent).toContain('已存在')
    await act(async () => container.querySelector<HTMLButtonElement>('footer button:last-child')!.click())
    expect(save).toHaveBeenCalledTimes(1)
    expect(container.querySelector('textarea')!.disabled).toBe(true)
    expect(close).not.toHaveBeenCalled()
    await act(async () => finish!())
    expect(save).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('已保存并启用')
    expect(container.textContent).toContain('磁盘写入失败')
    await act(async () => container.querySelector<HTMLButtonElement>('footer button:last-child')!.click())
    expect(save).toHaveBeenCalledTimes(3)
    expect(save.mock.calls[2]![0].id).toBe('second')
    expect(container.textContent).toContain('导入 0 个服务')
    expect(container.textContent).not.toContain('磁盘写入失败')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
