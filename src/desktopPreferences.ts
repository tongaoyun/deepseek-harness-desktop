import { useEffect, useState } from 'react'
const KEY = 'xiaoyin.desktop-preferences.v1'
const EVENT = 'xiaoyin:preferences-changed'
export interface DesktopPreferences { fontSize: 14 | 16 | 18; wide: boolean; reduceMotion: boolean }
export const defaultDesktopPreferences: DesktopPreferences = { fontSize: 14, wide: false, reduceMotion: false }
export function readDesktopPreferences(): DesktopPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { fontSize: [14, 16, 18].includes(value?.fontSize) ? value.fontSize : 14, wide: value?.wide === true, reduceMotion: value?.reduceMotion === true }
  } catch { return defaultDesktopPreferences }
}
export function saveDesktopPreferences(value: DesktopPreferences) {
  localStorage.setItem(KEY, JSON.stringify(value))
  window.dispatchEvent(new Event(EVENT))
}
export function useDesktopPreferences() {
  const [preferences, setPreferences] = useState(readDesktopPreferences)
  useEffect(() => {
    const refresh = () => setPreferences(readDesktopPreferences())
    window.addEventListener(EVENT, refresh); window.addEventListener('storage', refresh)
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [])
  return preferences
}
export function useApplyDesktopPreferences() {
  const value = useDesktopPreferences()
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--conversation-font-size', `${value.fontSize}px`)
    root.style.setProperty('--conversation-max-width', value.wide ? '1040px' : '800px')
    root.dataset.reduceMotion = String(value.reduceMotion)
  }, [value])
}
