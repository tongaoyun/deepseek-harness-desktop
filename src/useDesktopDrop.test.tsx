// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useDesktopDrop } from './useDesktopDrop'

const mock = vi.hoisted(() => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({ onDragDropEvent: mock.listen }) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('tracks native drag entry, blocks active tasks, and reports listener errors', async () => {
  let event!: (value: { payload: { type: string; paths?: string[] } }) => void
  const stop = vi.fn(), paths = vi.fn().mockResolvedValue(undefined), error = vi.fn()
  mock.listen.mockImplementation(async (callback) => { event = callback; return stop })
  let active = false
  function Host({ running = false, enabled = true }) { active = useDesktopDrop({ enabled, running, onPaths: paths, onError: error }); return null }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    await act(async () => event({ payload: { type: 'enter' } }))
    expect(active).toBe(true)
    await act(async () => event({ payload: { type: 'drop', paths: ['/tmp/a.txt'] } }))
    expect(active).toBe(false); expect(paths).toHaveBeenCalledWith(['/tmp/a.txt'])
    await act(async () => root.render(<Host running />))
    await act(async () => event({ payload: { type: 'drop', paths: ['/tmp/b.txt'] } }))
    expect(paths).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledWith(expect.stringContaining('等待当前任务'))
    const feedback = document.body.appendChild(document.createElement('div')); feedback.dataset.feedbackDrop = ''
    await act(async () => event({ payload: { type: 'drop', paths: ['/tmp/feedback.png'] } }))
    expect(paths).toHaveBeenCalledOnce()
    feedback.remove()
    await act(async () => root.render(<Host enabled={false} />))
    expect(stop).toHaveBeenCalledOnce()
    mock.listen.mockRejectedValueOnce(new Error('listener unavailable'))
    await act(async () => root.render(<Host />))
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('拖拽暂不可用'))
  } finally { await act(async () => root.unmount()); container.remove() }
})
