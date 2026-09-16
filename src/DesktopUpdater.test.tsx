// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopUpdater } from './DesktopUpdater'

const mocks = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn(), state: { phase: 'current', currentVersion: '0.1.50', downloadedBytes: 0 } }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('./updater', () => ({ isUpdatableDesktop: () => true, useDesktopUpdater: () => ({ state: mocks.state, checkForUpdates: mocks.check, install: mocks.install }) }))
afterEach(() => vi.clearAllMocks())

it('shows current version as status while keeping check updates as an action', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<DesktopUpdater variant="settings" />))
    expect(container.querySelector('h3')?.textContent).toBe('已是最新版本')
    expect(container.textContent).toContain('v0.1.50')
    expect(container.querySelector('button')?.textContent).toBe('检查更新')
    await act(async () => container.querySelector('button')!.click())
    expect(mocks.check).toHaveBeenCalledOnce()
  } finally { await act(async () => root.unmount()); container.remove() }
})
