// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ErpSessionStatus } from './auth'
import { useEnterpriseSession } from './useEnterpriseSession'

const { resolve, clear, open } = vi.hoisted(() => ({ resolve: vi.fn(), clear: vi.fn(), open: vi.fn() }))
vi.mock('./auth', () => ({ resolveErpSession: resolve, clearErpSession: clear, openErpLogin: open, isTauriRuntime: () => true, usesLocalDevelopmentSession: () => false }))
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
