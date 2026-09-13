import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadHarnessExternalAgentsEnabled, loadHarnessHooksEnabled, loadHarnessLspEnabled, loadHarnessShellEnabled, loadHarnessToolsMode, saveHarnessExternalAgentsEnabled, saveHarnessHooksEnabled, saveHarnessLspEnabled, saveHarnessShellEnabled, saveHarnessToolsMode } from './runtimePreferences'

describe('runtime preferences', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
  })

  it('defaults to the existing native tools and enabled shell behavior', () => {
    localStorage.removeItem('xiaoyin.runtime.tools-mode')
    localStorage.removeItem('xiaoyin.runtime.allow-shell')
    localStorage.removeItem('xiaoyin.runtime.allow-lsp')
    localStorage.removeItem('xiaoyin.runtime.allow-external-agents')
    localStorage.removeItem('xiaoyin.runtime.allow-hooks')
    expect(loadHarnessToolsMode()).toBe('native')
    expect(loadHarnessShellEnabled()).toBe(true)
    expect(loadHarnessLspEnabled()).toBe(true)
    expect(loadHarnessExternalAgentsEnabled()).toBe(false)
    expect(loadHarnessHooksEnabled()).toBe(false)
  })

  it('round-trips explicit local capability choices', () => {
    expect(saveHarnessToolsMode('both')).toBe(true)
    expect(saveHarnessShellEnabled(false)).toBe(true)
    expect(saveHarnessLspEnabled(false)).toBe(true)
    expect(saveHarnessExternalAgentsEnabled(true)).toBe(true)
    expect(saveHarnessHooksEnabled(true)).toBe(true)
    expect(loadHarnessToolsMode()).toBe('both')
    expect(loadHarnessShellEnabled()).toBe(false)
    expect(loadHarnessLspEnabled()).toBe(false)
    expect(loadHarnessExternalAgentsEnabled()).toBe(true)
    expect(loadHarnessHooksEnabled()).toBe(true)
    saveHarnessToolsMode('native')
    saveHarnessShellEnabled(true)
    saveHarnessLspEnabled(true)
    saveHarnessExternalAgentsEnabled(false)
    saveHarnessHooksEnabled(false)
  })

  it('falls back safely when the WebView storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage unavailable') },
      setItem: () => { throw new Error('storage unavailable') },
    })
    expect(loadHarnessToolsMode()).toBe('native')
    expect(loadHarnessShellEnabled()).toBe(false)
    expect(loadHarnessLspEnabled()).toBe(false)
    expect(loadHarnessExternalAgentsEnabled()).toBe(false)
    expect(loadHarnessHooksEnabled()).toBe(false)
    expect(saveHarnessToolsMode('ptc')).toBe(false)
    expect(saveHarnessShellEnabled(false)).toBe(false)
    expect(saveHarnessLspEnabled(false)).toBe(false)
    expect(saveHarnessExternalAgentsEnabled(true)).toBe(false)
    expect(saveHarnessHooksEnabled(true)).toBe(false)
  })

  it('does not report a no-op storage write as saved', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    expect(saveHarnessShellEnabled(false)).toBe(false)
    expect(saveHarnessHooksEnabled(true)).toBe(false)
  })
})
