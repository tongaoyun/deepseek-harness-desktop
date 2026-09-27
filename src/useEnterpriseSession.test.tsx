// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DingTalkSessionStatus } from './auth'
import { listen } from '@tauri-apps/api/event'
import { useEnterpriseSession } from './useEnterpriseSession'

const { resolve, clear, open } = vi.hoisted(() => ({ resolve: vi.fn(), clear: vi.fn(), open: vi.fn() }))
vi.mock('./auth', async (importOriginal) => ({ ...await importOriginal<typeof import('./auth')>(), resolveDingTalkSession: resolve, clearDingTalkSession: clear, openDingTalkLogin: open, isTauriRuntime: () => true, usesLocalDevelopmentSession: () => false }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let latest: ReturnType<typeof useEnterpriseSession>
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const valid = (): DingTalkSessionStatus => ({ authenticated: true, sessionToken: 'fixture', expiresAt: Date.now() / 1_000 + 1_800, loginUrl: '', user: { userId: 'employee', displayName: 'Employee', department: '', teamId: '', position: '', dataPermission: '', companyId: '', companyName: '', role: 'operator' } })
const loggedOut = { authenticated: false, sessionToken: '', expiresAt: null, user: null, loginUrl: '' }
const missingCookie = { ...loggedOut, diagnostic: { code: 'cookie_missing' as const, cookieCount: 0, httpStatus: null, checkedAt: 0, appVersion: 'test', os: 'macos', arch: 'aarch64', runId: 'test', debugBuild: true } }
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

it('retries a startup network error without opening an authorization page', async () => {
  resolve.mockRejectedValueOnce(new Error('timeout'))
  await mount()
  expect(latest.state).toBe('error')
  expect(open).not.toHaveBeenCalled()
  await advance(15_000)
  expect(latest.state).toBe('authenticated')
})

it('rechecks a startup session miss before opening authorization', async () => {
  resolve.mockResolvedValueOnce(missingCookie).mockResolvedValueOnce(valid())
  await mount()
  expect(latest.state).toBe('checking')
  expect(open).not.toHaveBeenCalled()
  await advance(1_500)
  expect(latest.state).toBe('authenticated')
  expect(open).not.toHaveBeenCalled()
})

it('opens official DingTalk authorization after a repeated startup session miss', async () => {
  resolve.mockResolvedValue(missingCookie)
  await mount()
  expect(latest.state).toBe('checking')
  await advance(1_500)
  expect(latest.state).toBe('required')
  expect(open).toHaveBeenCalledTimes(1)
  await act(async () => latest.reopen())
  expect(open).toHaveBeenCalledTimes(2)
})

it('opens official DingTalk authorization after an expired session', async () => {
  resolve.mockResolvedValue({ ...loggedOut, diagnostic: { ...missingCookie.diagnostic, code: 'session_rejected' } })
  await mount()
  expect(latest.state).toBe('required')
  expect(open).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalled()
})

it('opens authorization on a background renewal expiry', async () => {
  await mount()
  resolve.mockResolvedValue({ ...loggedOut, diagnostic: { ...missingCookie.diagnostic, code: 'session_rejected' } })
  await advance(25 * 60_000)
  expect(open).toHaveBeenCalled()
})

it('reopens authorization for an explicit retry', async () => {
  resolve.mockResolvedValue(missingCookie)
  await mount()
  await advance(1_500)
  await act(async () => latest.reopen())
  expect(open).toHaveBeenCalled()
})

it('shows a manual retry in progress and a distinct result when ERP is still unavailable', async () => {
  resolve.mockRejectedValue({ code: 'network_error' })
  await mount()
  let fail!: (reason: unknown) => void
  resolve.mockImplementationOnce(() => new Promise((_done, reject) => { fail = reject }))
  let retry!: Promise<void>
  act(() => { retry = latest.reopen() })
  expect(latest.state).toBe('checking')
  expect(latest.error).toBe('')
  await act(async () => { fail({ code: 'network_error' }); await retry })
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(latest.state).toBe('error')
  expect(latest.error).toBe('重新检查后仍未成功：暂时无法连接小胤服务，正在自动重试。')
})

it('runs a requested manual retry after an automatic check already in flight', async () => {
  resolve.mockRejectedValue({ code: 'network_error' })
  await mount()
  let fail!: (reason: unknown) => void
  resolve.mockImplementationOnce(() => new Promise((_done, reject) => { fail = reject }))
  await advance(15_000)
  expect(resolve).toHaveBeenCalledTimes(2)
  await act(async () => { await latest.reopen() })
  expect(latest.state).toBe('checking')
  await act(async () => fail({ code: 'network_error' }))
  await advance(0)
  expect(resolve).toHaveBeenCalledTimes(3)
  expect(latest.error).toContain('重新检查后仍未成功')
})

it('keeps a valid session through a failed renewal and recovers online', async () => {
  await mount()
  resolve.mockRejectedValueOnce(new Error('offline'))
  await advance(25 * 60_000)
  expect(latest.state).toBe('authenticated')
  expect(latest.sessionToken).toBe('fixture')
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
  expect(latest.sessionToken).toBe('')
  expect(open).not.toHaveBeenCalled()
})

it('shows login without opening a window when the ERP confirms logout', async () => {
  await mount()
  resolve.mockResolvedValue(loggedOut)
  await advance(25 * 60_000 + 4_500)
  expect(latest.state).toBe('required')
  expect(latest.user).toBeNull()
  expect(open).not.toHaveBeenCalled()
})

it('rechecks an overdue session after waking without overlapping checks', async () => {
  await mount()
  vi.setSystemTime(Date.now() + 31 * 60_000)
  let finish!: (value: DingTalkSessionStatus) => void
  resolve.mockImplementationOnce(() => new Promise((done) => { finish = done }))
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')) })
  expect(resolve).toHaveBeenCalledTimes(2)
  await act(async () => finish(valid()))
  expect(latest.state).toBe('authenticated')
})

it('ignores a renewal that completes after logout', async () => {
  await mount()
  let finish!: (value: DingTalkSessionStatus) => void
  resolve.mockImplementationOnce(() => new Promise((done) => { finish = done }))
  await advance(25 * 60_000)
  resolve.mockResolvedValue(loggedOut)
  await act(async () => latest.logout())
  await act(async () => finish(valid()))
  expect(latest.state).toBe('required')
  expect(latest.sessionToken).toBe('')
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
  await act(async () => callback({ event: 'dingtalk-login-progress', id: 1, payload: 'authorizing' }))
  expect(latest.state).toBe('authenticated')
  expect(latest.sessionToken).toBe('fixture')
  await advance(1_500)
  expect(resolve).toHaveBeenCalledTimes(1)
})

it('retries opening authorization without misclassifying it as a network error', async () => {
  resolve.mockResolvedValue(loggedOut)
  open.mockRejectedValueOnce(new Error('window unavailable'))
  await mount()
  expect(latest.state).toBe('required')
  expect(open).not.toHaveBeenCalled()
  await act(async () => latest.reopen())
  expect(latest.error).toBe('无法打开钉钉授权，请重试。')
  await act(async () => latest.reopen())
  expect(open).toHaveBeenCalledTimes(2)
  expect(latest.error).toBe('')
})

it('drops access immediately when the identity service explicitly denies permission', async () => {
  await mount()
  resolve.mockRejectedValue({ code: 'access_denied', httpStatus: 403 })
  await advance(25 * 60_000)
  expect(latest.state).toBe('error')
  expect(latest.sessionToken).toBe('')
  expect(latest.error).toContain('账号权限')
  expect(open).not.toHaveBeenCalled()
})

it('distinguishes service failures from logout without exposing response details', async () => {
  resolve.mockRejectedValue({ code: 'identity_unavailable', httpStatus: 503, message: 'Cookie=secret' })
  await mount()
  expect(latest.error).toBe('小胤身份服务暂时不可用，正在自动重试。')
  expect(open).not.toHaveBeenCalled()
})
