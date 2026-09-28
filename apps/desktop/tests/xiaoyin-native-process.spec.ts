import { describe, expect, it, vi } from 'vitest'
import { XiaoyinNativeProcess } from '../src/xiaoyin-native-process.ts'

interface NativeProcessTestAccess {
  child: { stdin: { write: (chunk: string, callback: (error?: Error | null) => void) => void } }
  receive(response: { protocol: string; request_id: string; result?: unknown }): void
}

describe('XiaoyinNativeProcess', () => {
  it('keeps a request pending when Node reports a successful write with null', async () => {
    let request = ''
    const process = new XiaoyinNativeProcess(undefined, undefined)
    const access = process as unknown as NativeProcessTestAccess
    access.child = {
      stdin: {
        write: vi.fn((chunk: string, callback: (error?: Error | null) => void) => {
          request = chunk
          callback(null)
        }),
      },
    }

    const response = process.invoke('health')
    const envelope = JSON.parse(request) as { request_id: string }
    access.receive({ protocol: 'xiaoyin.native.v1', request_id: envelope.request_id, result: { ok: true } })

    await expect(response).resolves.toEqual({ ok: true })
  })
})
