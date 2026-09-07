import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(), close: vi.fn(async () => {}), stopIm: vi.fn(async () => {}), closeApproval: vi.fn(async () => {}),
}))
const lines = new EventEmitter()
vi.mock('node:readline', () => ({ createInterface: () => lines }))
vi.mock('./runtime.js', () => ({ DeepSeekHarnessRuntime: class { close = mocks.close } }))
vi.mock('./im-runtime.js', () => ({ LocalImRuntime: class { stop = mocks.stopIm } }))
vi.mock('./approval-bridge.js', () => ({ ApprovalBridge: class {
  start = async () => ({ url: 'http://local-test', token: 'test' })
  close = mocks.closeApproval
} }))
vi.mock('./server.js', () => ({ HostServer: class { handle = mocks.handle } }))

it('aborts an active request on desktop EOF, drops queued work and disposes all services once', async () => {
  const originals = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, process.listeners(signal)]))
  const stdoutListeners = process.stdout.listeners('error')
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  let finish: () => void = () => {}
  mocks.handle.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
  try {
    await import('./index.js')
    lines.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent.run' }))
    await Promise.resolve()
    expect(mocks.handle).toHaveBeenCalledOnce()
    lines.emit('line', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'agent.run' }))
    lines.emit('close')
    lines.emit('close')
    process.stdout.emit('error', Object.assign(new Error('desktop closed'), { code: 'EPIPE' }))
    expect(mocks.close).toHaveBeenCalledOnce()
    expect(mocks.stopIm).toHaveBeenCalledOnce()
    expect(mocks.closeApproval).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())
    finish()
    await Promise.resolve(); await Promise.resolve()
    expect(mocks.handle).toHaveBeenCalledOnce()
  } finally {
    finish(); exit.mockRestore()
    for (const [signal, before] of originals) for (const listener of process.listeners(signal)) if (!before.includes(listener)) process.removeListener(signal, listener)
    for (const listener of process.stdout.listeners('error')) if (!stdoutListeners.includes(listener)) process.stdout.removeListener('error', listener)
  }
})
