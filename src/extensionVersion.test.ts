import { describe, expect, it } from 'vitest'
import { compareDesktopVersions, desktopVersion, isDesktopVersionCompatible } from './extensionVersion'

describe('desktop version requirements', () => {
  it('accepts supported versions and rejects a newer minimum', () => {
    expect(desktopVersion).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(isDesktopVersionCompatible('0.1.30')).toBe(true)
    expect(isDesktopVersionCompatible('0.2.0')).toBe(false)
    expect(isDesktopVersionCompatible('not-a-version')).toBe(false)
  })

  it('compares prereleases numerically and ignores build metadata', () => {
    expect(compareDesktopVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1)
    expect(compareDesktopVersions('1.0.0-rc.2', '1.0.0')).toBe(-1)
    expect(compareDesktopVersions('1.0.0+build.2', '1.0.0+build.1')).toBe(0)
    expect(compareDesktopVersions('1.02.0', '1.2.0')).toBeUndefined()
  })
})
