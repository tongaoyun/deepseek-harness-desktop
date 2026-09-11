// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { listenHarnessNotifications, type HarnessNotification } from './harness'
import { beginExecutionTurn } from './executionRuntime'
import { useHarnessNotifications, type StreamingTaskState } from './useHarnessNotifications'

vi.mock('./harness', async (original) => ({ ...await original<object>(), listenHarnessNotifications: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('ignores late events after stopping without affecting other tasks', async () => {
  let listener: (notification: HarnessNotification) => void = () => {}
  vi.mocked(listenHarnessNotifications).mockImplementation(async (callback) => { listener = callback; return () => {} })
  const state = (): StreamingTaskState => {
    const runtime = beginExecutionTurn({ taskId: 'task', sessionId: 'session', operationScope: 'scope', now: '', createId: () => 'test' })
    return { monitor: runtime.monitor, execution: runtime.thread, messages: [{ role: 'assistant', text: '已收到的部分', pending: true }], responseKey: '', cancellationRequested: false }
  }
  const first = state(); const other = state()
  const onCurrentUpdate = vi.fn(); const onTaskUpdate = vi.fn()
  const streamingTasksRef = { current: new Map([['one', first], ['two', other]]) }
  const currentTaskIdRef = { current: 'one' }
  function Host() { useHarnessNotifications({ currentTaskIdRef, streamingTasksRef, onCurrentUpdate, onTaskUpdate }); return null }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Host />))
    first.cancellationRequested = true
    const event = (taskId: string): HarnessNotification => ({ taskId, requestId: 1, event: { event: { method: 'session.status', params: { sessionId: 's', status: 'idle' } } } })
    await act(async () => listener(event('one')))
    expect(onCurrentUpdate).not.toHaveBeenCalled()
    expect(onTaskUpdate).not.toHaveBeenCalled()
    expect(first.messages[0].text).toBe('已收到的部分')
    await act(async () => listener(event('two')))
    expect(onTaskUpdate).toHaveBeenCalledOnce()
    expect(onTaskUpdate.mock.calls[0][0]).toBe('two')
    expect(onCurrentUpdate).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove() }
})
