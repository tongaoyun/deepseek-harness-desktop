import { describe, expect, it, vi } from 'vitest'
import { DeepSeekHarnessNativeProcess } from '../src/deepseek-harness-native-process.ts'

function receiveNativeResponse(process: DeepSeekHarnessNativeProcess, response: object): void {
  process['receive'](response)
}

describe('DeepSeekHarnessNativeProcess', () => {
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
