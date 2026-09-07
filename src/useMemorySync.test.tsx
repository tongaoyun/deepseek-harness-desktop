// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useMemorySync } from './useMemorySync'
import { syncMemoryProfile } from './memory'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('./memory', () => ({ syncMemoryProfile: vi.fn(async () => ({ syncConflict: true })) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('syncs at startup, online and focus, deduplicates conflict notices and removes listeners on unmount', async () => {
  const notify = vi.fn()
  const Host = () => { useMemorySync('u', '/memory', 'token', notify); return null }
  const box = document.body.appendChild(document.createElement('div')); const root = createRoot(box)
  await act(async () => root.render(<Host />))
  await act(async () => window.dispatchEvent(new Event('online')))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(syncMemoryProfile).toHaveBeenCalledTimes(3)
  expect(notify).toHaveBeenCalledOnce()
  await act(async () => root.unmount())
  await act(async () => window.dispatchEvent(new Event('online')))
  expect(syncMemoryProfile).toHaveBeenCalledTimes(3)
  box.remove(); vi.clearAllMocks()
})
