import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadHarnessExternalAgentsEnabled, loadHarnessHooksEnabled, loadHarnessLspEnabled, loadHarnessShellEnabled, saveHarnessExternalAgentsEnabled, saveHarnessHooksEnabled, saveHarnessLspEnabled, saveHarnessShellEnabled } from './runtimePreferences'

describe('runtime preferences', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
  })

  it('defaults to enabled shell behavior and disabled optional capabilities', () => {
    expect(loadHarnessShellEnabled('employee-one')).toBe(true)
    expect(loadHarnessLspEnabled('employee-one')).toBe(false)
    expect(loadHarnessExternalAgentsEnabled('employee-one')).toBe(false)
    expect(loadHarnessHooksEnabled('employee-one')).toBe(false)
  })

  it('round-trips explicit local capability choices without sharing them between employees', () => {
    expect(saveHarnessShellEnabled('employee-one', false)).toBe(true)
    expect(saveHarnessLspEnabled('employee-one', true)).toBe(true)
    expect(saveHarnessExternalAgentsEnabled('employee-one', true)).toBe(true)
    expect(saveHarnessHooksEnabled('employee-one', true)).toBe(true)
    expect(loadHarnessShellEnabled('employee-one')).toBe(false)
    expect(loadHarnessLspEnabled('employee-one')).toBe(true)
    expect(loadHarnessExternalAgentsEnabled('employee-one')).toBe(true)
    expect(loadHarnessHooksEnabled('employee-one')).toBe(true)
    expect(loadHarnessShellEnabled('employee-two')).toBe(true)
    expect(loadHarnessLspEnabled('employee-two')).toBe(false)
    expect(loadHarnessExternalAgentsEnabled('employee-two')).toBe(false)
    expect(loadHarnessHooksEnabled('employee-two')).toBe(false)
  })

  it('falls back safely when the WebView storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage unavailable') },
      setItem: () => { throw new Error('storage unavailable') },
    })
    expect(loadHarnessShellEnabled('employee-one')).toBe(false)
    expect(loadHarnessLspEnabled('employee-one')).toBe(false)
    expect(loadHarnessExternalAgentsEnabled('employee-one')).toBe(false)
    expect(loadHarnessHooksEnabled('employee-one')).toBe(false)
    expect(saveHarnessShellEnabled('employee-one', false)).toBe(false)
    expect(saveHarnessLspEnabled('employee-one', false)).toBe(false)
    expect(saveHarnessExternalAgentsEnabled('employee-one', true)).toBe(false)
    expect(saveHarnessHooksEnabled('employee-one', true)).toBe(false)
  })

  it('does not report a no-op storage write as saved', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    expect(saveHarnessShellEnabled('employee-one', false)).toBe(false)
    expect(saveHarnessHooksEnabled('employee-one', true)).toBe(false)
  })

  it('rejects unowned runtime preferences', () => {
    expect(loadHarnessShellEnabled('')).toBe(false)
    expect(saveHarnessShellEnabled('', true)).toBe(false)
  })
})
