import { describe, expect, it, vi } from 'vitest'
import { XiaoyinNativeProcess } from '../src/xiaoyin-native-process.ts'

function receiveNativeResponse(process: XiaoyinNativeProcess, response: object): void {
  process['receive'](response)
}

describe('XiaoyinNativeProcess', () => {
  it('keeps a request pending when Node reports a successful write with null', async () => {
    let request = ''
    const process = new XiaoyinNativeProcess(undefined, undefined)
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
    receiveNativeResponse(process, { protocol: 'xiaoyin.native.v1', request_id: envelope.request_id, result: { ok: true } })

    await expect(response).resolves.toEqual({ ok: true })
  })

  it('accepts the Rust success envelope with a null error field', async () => {
    let request = ''
    const process = new XiaoyinNativeProcess(undefined, undefined)
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
      protocol: 'xiaoyin.native.v1',
      request_id: envelope.request_id,
      result: { ready: true },
      error: null,
    })

    await expect(response).resolves.toEqual({ ready: true })
  })
})
