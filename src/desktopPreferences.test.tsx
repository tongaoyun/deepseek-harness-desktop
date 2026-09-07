// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { readDesktopPreferences, saveDesktopPreferences, useApplyDesktopPreferences } from './desktopPreferences'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('applies preferences immediately, restores stored choices and tolerates invalid storage', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  function Host() { useApplyDesktopPreferences(); return null }
  try {
    await act(async () => root.render(<Host />))
    await act(async () => saveDesktopPreferences({ fontSize: 18, wide: true, reduceMotion: true }))
    expect(document.documentElement.style.getPropertyValue('--conversation-font-size')).toBe('18px')
    expect(document.documentElement.style.getPropertyValue('--conversation-max-width')).toBe('1040px')
    expect(document.documentElement.dataset.reduceMotion).toBe('true')
    expect(readDesktopPreferences().fontSize).toBe(18)
    localStorage.setItem('xiaoyin.desktop-preferences.v1', '{invalid')
    expect(readDesktopPreferences()).toEqual({ fontSize: 14, wide: false, reduceMotion: false })
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() }
})
