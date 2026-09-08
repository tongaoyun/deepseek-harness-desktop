// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ErpSessionStatus } from './auth'
import { listen } from '@tauri-apps/api/event'
import { useEnterpriseSession } from './useEnterpriseSession'

const { resolve, clear, open } = vi.hoisted(() => ({ resolve: vi.fn(), clear: vi.fn(), open: vi.fn() }))
vi.mock('./auth', async (importOriginal) => ({ ...await importOriginal<typeof import('./auth')>(), resolveErpSession: resolve, clearErpSession: clear, openErpLogin: open, isTauriRuntime: () => true, usesLocalDevelopmentSession: () => false }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let latest: ReturnType<typeof useEnterpriseSession>
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const valid = (): ErpSessionStatus => ({ authenticated: true, accessToken: 'fixture', expiresAt: Date.now() / 1_000 + 1_800, loginUrl: '', user: { userId: 'employee', displayName: 'Employee', department: '', teamId: '', position: '', dataPermission: '', companyId: '', companyName: '', role: 'operator' } })
const loggedOut = { authenticated: false, accessToken: '', expiresAt: null, user: null, loginUrl: '' }
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-07T00:00:00Z'))
  resolve.mockResolvedValue(valid())
  clear.mockResolvedValue(undefined)
  open.mockResolvedValue(undefined)
  vi.mocked(listen).mockResolvedValue(() => {})
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })
async function mount() {
  function View() { latest = useEnterpriseSession(); return <span>{latest.state}</span> }
  await act(async () => root.render(<View />))
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

it('retries a startup network error without opening a QR window', async () => {
  resolve.mockRejectedValueOnce(new Error('timeout'))
  await mount()
  expect(latest.state).toBe('error')
  expect(open).not.toHaveBeenCalled()
  await advance(15_000)
  expect(latest.state).toBe('authenticated')
})

it('keeps a valid session through a failed renewal and recovers online', async () => {
  await mount()
  resolve.mockRejectedValueOnce(new Error('offline'))
  await advance(25 * 60_000)
  expect(latest.state).toBe('authenticated')
  expect(latest.accessToken).toBe('fixture')
  expect(open).not.toHaveBeenCalled()
  resolve.mockResolvedValue(valid())
  await act(async () => { window.dispatchEvent(new Event('online')) })
  expect(latest.error).toBe('')
})

it('blocks an expired session while the ERP remains unavailable', async () => {
  await mount()
  resolve.mockRejectedValue(new Error('offline'))
  await advance(30 * 60_000)
  expect(latest.state).toBe('error')
  expect(latest.accessToken).toBe('')
  expect(open).not.toHaveBeenCalled()
})

it('opens login once when the ERP confirms logout', async () => {
  await mount()
  resolve.mockResolvedValue(loggedOut)
  await advance(25 * 60_000 + 4_500)
  expect(latest.state).toBe('required')
  expect(latest.user).toBeNull()
  expect(open).toHaveBeenCalledTimes(1)
})

it('rechecks an overdue session after waking without overlapping checks', async () => {
  await mount()
  vi.setSystemTime(Date.now() + 31 * 60_000)
  let finish!: (value: ErpSessionStatus) => void
  resolve.mockImplementationOnce(() => new Promise((done) => { finish = done }))
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')) })
  expect(resolve).toHaveBeenCalledTimes(2)
  await act(async () => finish(valid()))
  expect(latest.state).toBe('authenticated')
})

it('ignores a renewal that completes after logout', async () => {
  await mount()
  let finish!: (value: ErpSessionStatus) => void
  resolve.mockImplementationOnce(() => new Promise((done) => { finish = done }))
  await advance(25 * 60_000)
  resolve.mockResolvedValue(loggedOut)
  await act(async () => latest.logout())
  await act(async () => finish(valid()))
  expect(latest.state).toBe('required')
  expect(latest.accessToken).toBe('')
})

it('does not silently log back in after credential deletion fails', async () => {
  await mount()
  clear.mockRejectedValueOnce(new Error('storage unavailable'))
  await act(async () => latest.logout())
  await advance(60_000)
  expect(latest.state).toBe('error')
  expect(resolve).toHaveBeenCalledTimes(1)
  resolve.mockResolvedValue(loggedOut)
  await act(async () => latest.reopen())
  expect(clear).toHaveBeenCalledTimes(2)
  expect(latest.state).toBe('required')
})

it('ignores a late QR confirmation after authentication', async () => {
  await mount()
  const callback = vi.mocked(listen).mock.calls[0][1]
  await act(async () => callback({ event: 'erp-login-progress', id: 1, payload: 'authorizing' }))
  expect(latest.state).toBe('authenticated')
  expect(latest.accessToken).toBe('fixture')
  await advance(1_500)
  expect(resolve).toHaveBeenCalledTimes(1)
})

it('retries opening the QR window without misclassifying it as a network error', async () => {
  resolve.mockResolvedValue(loggedOut)
  open.mockRejectedValueOnce(new Error('window unavailable'))
  await mount()
  expect(latest.state).toBe('required')
  expect(latest.error).toBe('无法打开扫码窗口，请重新打开。')
  await act(async () => latest.reopen())
  expect(open).toHaveBeenCalledTimes(2)
  expect(latest.error).toBe('')
})

it('drops access immediately when the identity service explicitly denies permission', async () => {
  await mount()
  resolve.mockRejectedValue({ code: 'access_denied', httpStatus: 403 })
  await advance(25 * 60_000)
  expect(latest.state).toBe('error')
  expect(latest.accessToken).toBe('')
  expect(latest.error).toContain('账号权限')
  expect(open).not.toHaveBeenCalled()
})

it('distinguishes service failures from logout without exposing response details', async () => {
  resolve.mockRejectedValue({ code: 'identity_unavailable', httpStatus: 503, message: 'Cookie=secret' })
  await mount()
  expect(latest.error).toBe('ERP 身份服务暂时不可用，正在自动重试。')
  expect(open).not.toHaveBeenCalled()
})
