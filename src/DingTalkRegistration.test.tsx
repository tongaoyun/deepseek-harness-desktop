// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DingTalkRegistration } from './DingTalkRegistration'
import { beginDingTalkRegistration, pollDingTalkRegistration, type DingTalkRegistrationResult } from './localIm'

vi.mock('./localIm', () => ({ beginDingTalkRegistration: vi.fn(), pollDingTalkRegistration: vi.fn() }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr') } }))
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.mocked(beginDingTalkRegistration).mockResolvedValue({ deviceCode: 'one', verificationUri: 'https://open.dingtalk.com/registration', expiresIn: 60, interval: 2 })
  vi.mocked(pollDingTalkRegistration).mockResolvedValue({ status: 'WAITING' })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })
it('polls until success, returns credentials once, then stops', async () => {
  const authorized = vi.fn()
  await act(async () => root.render(<DingTalkRegistration revision={0} onAuthorized={authorized} />))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(authorized).not.toHaveBeenCalled()
  vi.mocked(pollDingTalkRegistration).mockResolvedValue({ status: 'SUCCESS', clientId: 'app', clientSecret: 'test-secret' })
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(authorized).toHaveBeenCalledExactlyOnceWith('app', 'test-secret')
  expect(container.textContent).toContain('扫码成功')
  expect(container.textContent).not.toContain('test-secret')
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(pollDingTalkRegistration).toHaveBeenCalledTimes(2)
})
it('ignores late authorization from a refreshed QR session', async () => {
  let resolve!: (value: DingTalkRegistrationResult) => void
  vi.mocked(pollDingTalkRegistration).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  const authorized = vi.fn()
  await act(async () => root.render(<DingTalkRegistration revision={0} onAuthorized={authorized} />))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  await act(async () => root.render(<DingTalkRegistration revision={1} onAuthorized={authorized} />))
  await act(async () => resolve({ status: 'SUCCESS', clientId: 'stale', clientSecret: 'stale-secret' }))
  expect(authorized).not.toHaveBeenCalled()
  expect(beginDingTalkRegistration).toHaveBeenCalledTimes(2)
})
it('stops expired sessions and exposes an actionable error', async () => {
  vi.mocked(pollDingTalkRegistration).mockResolvedValue({ status: 'EXPIRED' })
  await act(async () => root.render(<DingTalkRegistration revision={0} onAuthorized={vi.fn()} />))
  await act(async () => vi.advanceTimersByTimeAsync(20000))
  expect(container.querySelector('[role=alert]')?.textContent).toContain('请刷新')
  expect(pollDingTalkRegistration).toHaveBeenCalledTimes(1)
})
it('retries transient polling errors but stops after the registration becomes invalid', async () => {
  vi.mocked(pollDingTalkRegistration).mockResolvedValueOnce({ status: 'RETRY' })
    .mockRejectedValueOnce(new Error('扫码会话已失效，请重新获取二维码'))
  await act(async () => root.render(<DingTalkRegistration revision={0} onAuthorized={vi.fn()} />))
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(container.querySelector('[role=status]')?.textContent).toContain('正在重试')
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(container.querySelector('[role=alert]')?.textContent).toContain('重新获取二维码')
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(pollDingTalkRegistration).toHaveBeenCalledTimes(2)
})
it('shows initialization failures instead of a fake QR', async () => {
  vi.mocked(beginDingTalkRegistration).mockRejectedValue(new Error('请使用桌面端'))
  await act(async () => root.render(<DingTalkRegistration revision={0} onAuthorized={vi.fn()} />))
  expect(container.querySelector('[role=alert]')?.textContent).toBe('请使用桌面端')
  expect(container.querySelector('img')).toBeNull()
  expect(pollDingTalkRegistration).not.toHaveBeenCalled()
})
