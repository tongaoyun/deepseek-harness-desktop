// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskVisuals } from './TaskVisuals'
import { loadHarnessImagePreview } from './localArtifactPreview'
import type { TaskVisualArtifact } from './types'

vi.mock('./localArtifactPreview', () => ({ loadHarnessImagePreview: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const observers: Array<{ change: (visible: boolean) => void; disconnect: ReturnType<typeof vi.fn> }> = []
const data = 'data:image/png;base64,aW1hZ2U='
const visual = (id: string): TaskVisualArtifact => ({ id, attachmentId: id, name: `截图 ${id}`, mediaType: 'image/png', width: 1000, height: 800, sourceTool: 'computer_use_observe', createdAt: '' })
beforeEach(() => {
  observers.length = 0
  vi.mocked(loadHarnessImagePreview).mockReset().mockResolvedValue(data)
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn()
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push({ change: (visible) => callback([{ isIntersecting: visible }]), disconnect: this.disconnect }) }
    observe() {}
  })
  let id = 0
  URL.createObjectURL = vi.fn(() => `blob:test-${++id}`)
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => vi.unstubAllGlobals())
async function fixture(run: (container: HTMLElement, render: (items: TaskVisualArtifact[]) => Promise<void>) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const render = async (items: TaskVisualArtifact[]) => { await act(async () => root.render(<TaskVisuals visuals={items} />)) }
  try { await run(container, render) } finally { await act(async () => root.unmount()); container.remove() }
}
it('bounds initial screenshot cards and releases images when leaving the viewport', async () => {
  await fixture(async (container, render) => {
    await render(Array.from({ length: 100 }, (_, i) => visual(String(i))))
    expect(observers).toHaveLength(6)
    expect(loadHarnessImagePreview).not.toHaveBeenCalled()
    await act(async () => observers[0].change(true))
    expect(loadHarnessImagePreview).toHaveBeenCalledOnce()
    expect(container.querySelector('img')?.src).toBe('blob:test-1')
    await act(async () => observers[0].change(false))
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1')
    expect(container.querySelector('img')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.visuals-load-more')!.click())
    expect(observers).toHaveLength(12)
    expect(loadHarnessImagePreview).toHaveBeenCalledOnce()
  })
  expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true)
})
it('isolates one failed screenshot, retries it, and traps/restores lightbox focus', async () => {
  vi.mocked(loadHarnessImagePreview).mockRejectedValueOnce(new Error('文件缺失'))
  await fixture(async (container, render) => {
    await render([visual('bad'), visual('good')])
    await act(async () => { observers[0].change(true); observers[1].change(true) })
    expect(container.querySelectorAll('img')).toHaveLength(1)
    const retry = container.querySelector<HTMLButtonElement>('[aria-label="重新加载 截图 bad"]')!
    await act(async () => retry.click())
    expect(container.querySelectorAll('img')).toHaveLength(2)
    const opener = container.querySelector<HTMLButtonElement>('[aria-label="查看 截图 bad"]')!
    await act(async () => { opener.focus(); opener.click() })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭截图')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
})
it('ignores late screenshot reads after switching tasks, without allocating a leaked URL', async () => {
  let finish!: (data: string) => void
  vi.mocked(loadHarnessImagePreview).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  await fixture(async (_container, render) => {
    await render([visual('old')])
    await act(async () => observers[0].change(true))
    await render([visual('new')])
    await act(async () => finish(data))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
  })
})
it('balances observers and image URLs across repeated conversation switches', async () => {
  await fixture(async (_container, render) => {
    for (let index = 0; index < 100; index++) {
      await render([visual(`task-${index}`)])
      await act(async () => observers.at(-1)!.change(true))
    }
  })
  expect(URL.createObjectURL).toHaveBeenCalledTimes(100)
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(100)
  expect(observers.every((observer) => observer.disconnect.mock.calls.length === 1)).toBe(true)
})
