import { afterEach, expect, it, vi } from 'vitest'
import { DeepSeekHarnessProductIpc } from '../src/deepseek-harness-product-ipc.ts'

const connected = Object.getOwnPropertyDescriptor(process, 'connected')
const send = Object.getOwnPropertyDescriptor(process, 'send')
afterEach(() => {
  if (connected === undefined) Reflect.deleteProperty(process, 'connected')
  else Object.defineProperty(process, 'connected', connected)
  if (send === undefined) Reflect.deleteProperty(process, 'send')
  else Object.defineProperty(process, 'send', send)
  vi.useRealTimers()
})

function channel(write: (message: { type: string; requestId: string }, callback?: (error: Error | null) => void) => boolean): void {
  Object.defineProperties(process, {
    connected: { configurable: true, value: true },
    send: { configurable: true, value: write },
  })
}

it('cleans a synchronous IPC send failure before rejecting its caller', async () => {
  vi.useFakeTimers()
  const ipc = new DeepSeekHarnessProductIpc()
  const owner = new AbortController()
  const remove = vi.spyOn(owner.signal, 'removeEventListener')
  channel(() => { throw new Error('Closed channel') })
  await expect(ipc.invoke('connectors.list', undefined, owner.signal)).rejects.toThrow('Closed channel')
  expect(ipc['pending'].size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
})

it.each(['abort', 'timeout', 'close'])('settles every request when cancellation send throws during %s', async (mode) => {
  vi.useFakeTimers()
  const ipc = new DeepSeekHarnessProductIpc()
  channel((message) => {
    if (message.type === 'extension-cancel') throw new Error('Channel closed during cancel')
    return true
  })
  const owner = new AbortController()
  owner.signal.addEventListener('abort', (event) => { event.stopImmediatePropagation() })
  const first = ipc.invoke('connectors.list', undefined, owner.signal, 10)
  const firstFailure = expect(first).rejects.toThrow(mode === 'abort' ? 'Caller stopped' : mode === 'timeout' ? 'timed out' : 'Host stopped')
  if (mode === 'abort') owner.abort(new Error('Caller stopped'))
  else if (mode === 'timeout') await vi.advanceTimersByTimeAsync(10)
  else {
    const second = ipc.invoke('connectors.list')
    const secondFailure = expect(second).rejects.toThrow('Host stopped')
    ipc.close()
    await secondFailure
  }
  if (mode === 'abort') await vi.advanceTimersByTimeAsync(10)
  await firstFailure
  expect(ipc['pending'].size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('consumes asynchronous cancellation write errors without changing the caller failure', async () => {
  const ipc = new DeepSeekHarnessProductIpc()
  channel((message, callback) => {
    if (message.type === 'extension-cancel') {
      expect(callback).toBeTypeOf('function')
      callback?.(new Error('Closed asynchronously'))
    }
    return true
  })
  const owner = new AbortController()
  const pending = ipc.invoke('connectors.list', undefined, owner.signal)
  owner.abort(new Error('Caller stopped'))
  await expect(pending).rejects.toThrow('Caller stopped')
  ipc.close()
})


it('correlates successful replies and ignores late replies after cancellation', async () => {
  vi.useFakeTimers()
  const ipc = new DeepSeekHarnessProductIpc()
  let requestId = ''
  channel((message, callback) => {
    if (message.type === 'extension-invoke') requestId = message.requestId
    callback?.(null)
    return true
  })
  const response = ipc.invoke('connectors.list')
  expect(ipc.handle({ type: 'unrelated' })).toBe(false)
  expect(ipc.handle({ type: 'extension-result', requestId, result: ['fixture'] })).toBe(true)
  await expect(response).resolves.toEqual(['fixture'])
  expect(vi.getTimerCount()).toBe(0)
  const owner = new AbortController()
  const cancelled = ipc.invoke('connectors.list', undefined, owner.signal)
  owner.abort(new Error('Caller stopped'))
  await expect(cancelled).rejects.toThrow('Caller stopped')
  expect(ipc.handle({ type: 'extension-result', requestId, result: ['late'] })).toBe(true)
  expect(ipc['pending'].size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  ipc.close()
  await expect(ipc.invoke('connectors.list')).rejects.toThrow('unavailable')
})
