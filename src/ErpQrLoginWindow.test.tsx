// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErpQrLoginWindow } from './ErpQrLoginWindow'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ close: vi.fn() }),
}))

describe('ERP QR login window', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    invoke.mockReset()
    invoke.mockImplementation((command: string) => command === 'erp_qr_login_configuration'
      ? Promise.resolve({ loginUrl: 'https://login.dingtalk.com/login/qrcode.htm?goto=trusted' })
      : Promise.resolve())
    container = document.createElement('div')
    document.body.append(container)
  })

  afterEach(() => container.remove())

  it('accepts a login code only from the embedded DingTalk login page', async () => {
    const root = createRoot(container)
    await act(async () => {
      root.render(<ErpQrLoginWindow />)
      await Promise.resolve()
    })
    const frame = container.querySelector<HTMLIFrameElement>('iframe')!
    expect(frame.src).toContain('https://login.dingtalk.com/login/qrcode.htm')

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        data: 'forged-code',
        origin: 'https://example.com',
        source: frame.contentWindow,
      }))
      window.dispatchEvent(new MessageEvent('message', {
        data: 'trusted-code',
        origin: 'https://login.dingtalk.com',
        source: frame.contentWindow,
      }))
      window.dispatchEvent(new MessageEvent('message', {
        data: 'second-code',
        origin: 'https://login.dingtalk.com',
        source: frame.contentWindow,
      }))
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith('complete_erp_qr_login', { loginTmpCode: 'trusted-code' })
    expect(invoke).not.toHaveBeenCalledWith('complete_erp_qr_login', { loginTmpCode: 'forged-code' })
    expect(invoke).not.toHaveBeenCalledWith('complete_erp_qr_login', { loginTmpCode: 'second-code' })
    await act(async () => root.unmount())
  })
})
