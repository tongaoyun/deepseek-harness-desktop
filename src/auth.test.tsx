// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearDingTalkSession, openDingTalkLogin, resolveDingTalkSession, usesLocalDevelopmentSession } from './auth'
import { useEnterpriseSession } from './useEnterpriseSession'

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('DEV', true)
  vi.stubEnv('VITE_SKIP_DINGTALK_LOGIN', 'false')
})
afterEach(() => { vi.unstubAllEnvs(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__') })
const native = () => Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })

it('opens browser preview without ERP login or credentials', async () => {
  expect(await resolveDingTalkSession()).toMatchObject({ authenticated: true, sessionToken: '', user: { userId: 'local-development' } })
  await openDingTalkLogin()
  await clearDingTalkSession()
  expect(invoke).not.toHaveBeenCalled()
})

it('skips native login only when the development flag is enabled', async () => {
  native()
  vi.stubEnv('VITE_SKIP_DINGTALK_LOGIN', 'true')
  expect(usesLocalDevelopmentSession()).toBe(true)
  expect(await resolveDingTalkSession()).toMatchObject({ authenticated: true, expiresAt: null })
  await openDingTalkLogin()
  await clearDingTalkSession()
  expect(invoke).not.toHaveBeenCalled()
})

it.each([false, true])('preserves real native login when DEV=%s and bypass is unavailable', async (development) => {
  native()
  vi.stubEnv('DEV', development)
  vi.stubEnv('VITE_SKIP_DINGTALK_LOGIN', development ? 'false' : 'true')
  expect(usesLocalDevelopmentSession()).toBe(false)
  await resolveDingTalkSession()
  await openDingTalkLogin()
  await clearDingTalkSession()
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(['dingtalk_session', 'open_dingtalk_login', 'clear_dingtalk_session'])
  expect(invoke).toHaveBeenNthCalledWith(1, 'dingtalk_session')
})

it('can prepare the QR window without taking focus', async () => {
  native()
  vi.stubEnv('DEV', false)
  await openDingTalkLogin()
  expect(invoke).toHaveBeenCalledWith('open_dingtalk_login')
})

it.each([false, true])('returns to the local session after logout, native=%s', async (isNative) => {
  if (isNative) native()
  vi.stubEnv('VITE_SKIP_DINGTALK_LOGIN', 'true')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Preview() {
    const session = useEnterpriseSession()
    return <><span>{session.state}:{session.user?.userId}</span><button onClick={() => void session.logout()}>退出</button></>
  }
  try {
    await act(async () => root.render(<Preview />))
    expect(container.textContent).toContain('authenticated:local-development')
    await act(async () => container.querySelector('button')!.click())
    expect(container.textContent).toContain('authenticated:local-development')
    expect(invoke).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); container.remove() }
})
