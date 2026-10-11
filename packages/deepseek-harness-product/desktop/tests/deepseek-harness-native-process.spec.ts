import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { DeepSeekHarnessNativeProcess } from '../src/deepseek-harness-native-process.ts'

function receiveNativeResponse(process: DeepSeekHarnessNativeProcess, response: object): void {
  process['receive'](response)
}

describe('DeepSeekHarnessNativeProcess', () => {
  it('cancels pending native work and ignores its late response without leaking timers', async () => {
    vi.useFakeTimers()
    try {
      const sidecar = new DeepSeekHarnessNativeProcess(undefined, undefined)
      let request = ''
      Object.assign(sidecar, { child: { stdin: { write: (chunk: string) => { request = chunk } } } })
      const controller = new AbortController()
      const pending = sidecar.invoke('health', undefined, controller.signal)
      const rejected = expect(pending).rejects.toThrow('cancel native')
      controller.abort(new Error('cancel native'))
      await rejected
      expect(vi.getTimerCount()).toBe(0)
      const envelope = JSON.parse(request) as { request_id: string }
      receiveNativeResponse(sidecar, { protocol: 'deepseek-harness.native.v1', request_id: envelope.request_id, result: {} })
      await expect(sidecar.invoke('health', undefined, controller.signal)).rejects.toThrow('cancel native')
    } finally { vi.useRealTimers() }
  })

  it('waits for confirmed exit and escalates an unresponsive sidecar to SIGKILL', async () => {
    vi.useFakeTimers()
    try {
      const sidecar = new DeepSeekHarnessNativeProcess(undefined, undefined)
      const child = Object.assign(new EventEmitter(), { kill: vi.fn((signal: string) => {
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit'))
        return true
      }) })
      Object.assign(sidecar, { child })
      let stopped = false
      const pending = sidecar.stop().then(() => { stopped = true })
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(stopped).toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)
      await pending
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(stopped).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('fails before product plugins load when the executable is not configured', async () => {
    const process = new DeepSeekHarnessNativeProcess(undefined, undefined)
    await expect(process.start()).rejects.toThrow('executable is not configured')
  })

  it('fails before product plugins load when the configured executable is missing', async () => {
    const process = new DeepSeekHarnessNativeProcess('/missing/deepseek-harness-native', undefined)
    await expect(process.start()).rejects.toThrow('executable is missing')
  })

  it('keeps a request pending when Node reports a successful write with null', async () => {
    let request = ''
    const process = new DeepSeekHarnessNativeProcess(undefined, undefined)
    Object.assign(process, { child: {
      stdin: {
        write: vi.fn((chunk: string, callback: (error?: Error | null) => void) => {
          request = chunk
          callback(null)
        }),
      },
    } })

    const response = process.invoke('health')
    const envelope = JSON.parse(request) as { request_id: string }
    receiveNativeResponse(process, { protocol: 'deepseek-harness.native.v1', request_id: envelope.request_id, result: { ok: true } })

    await expect(response).resolves.toEqual({ ok: true })
  })

  it('accepts the Rust success envelope with a null error field', async () => {
    let request = ''
    const process = new DeepSeekHarnessNativeProcess(undefined, undefined)
    Object.assign(process, { child: {
      stdin: {
        write: vi.fn((chunk: string, callback: (error?: Error | null) => void) => {
          request = chunk
          callback(null)
        }),
      },
    } })

    const response = process.invoke('health')
    const envelope = JSON.parse(request) as { request_id: string }
    receiveNativeResponse(process, {
      protocol: 'deepseek-harness.native.v1',
      request_id: envelope.request_id,
      result: { ready: true },
      error: null,
    })

    await expect(response).resolves.toEqual({ ready: true })
  })
})
