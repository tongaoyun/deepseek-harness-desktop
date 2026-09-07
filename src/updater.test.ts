import { describe, expect, it } from 'vitest'
import { isUnsupportedUpdaterPlatformError, isWindowsPlatform, isUpdatablePlatform, updateDownloadProgress } from './updater'

describe('desktop updater platform', () => {
  it('supports Mac and Windows updates but not Linux or mobile browsers', () => {
    expect(isUpdatablePlatform('Macintosh; Intel Mac OS X', 'MacIntel')).toBe(true)
    expect(isUpdatablePlatform('Windows NT 10.0', 'Win32')).toBe(true)
    expect(isUpdatablePlatform('Linux x86_64', 'Linux')).toBe(false)
    expect(isUpdatablePlatform('iPhone', 'iPhone')).toBe(false)
  })
  it('identifies Windows separately from Mac', () => {
    expect(isWindowsPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32')).toBe(true)
    expect(isWindowsPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel')).toBe(false)
  })
})

describe('isUnsupportedUpdaterPlatformError', () => {
  it('recognizes the expected macOS error from a Windows-only update feed', () => {
    expect(isUnsupportedUpdaterPlatformError(new Error(
      'None of the fallback platforms `["darwin-aarch64-app", "darwin-aarch64"]` were found in the response `platforms` object',
    ))).toBe(true)
  })

  it('does not hide Windows feed or network errors', () => {
    expect(isUnsupportedUpdaterPlatformError(
      'None of the fallback platforms `["windows-x86_64"]` were found in the response `platforms` object',
    )).toBe(false)
    expect(isUnsupportedUpdaterPlatformError(new Error('network timeout'))).toBe(false)
  })
})

describe('updateDownloadProgress', () => {
  it('tracks bounded download progress from Tauri updater events', () => {
    let progress = updateDownloadProgress({ downloadedBytes: 900 }, {
      event: 'Started',
      data: { contentLength: 1_000 },
    })
    expect(progress).toEqual({ downloadedBytes: 0, totalBytes: 1_000, percent: 0 })

    progress = updateDownloadProgress(progress, { event: 'Progress', data: { chunkLength: 450 } })
    progress = updateDownloadProgress(progress, { event: 'Progress', data: { chunkLength: 700 } })
    expect(progress).toEqual({ downloadedBytes: 1_150, totalBytes: 1_000, percent: 100 })

    progress = updateDownloadProgress(progress, { event: 'Finished' })
    expect(progress).toEqual({ downloadedBytes: 1_000, totalBytes: 1_000, percent: 100 })
  })

  it('supports servers that omit content length', () => {
    const progress = updateDownloadProgress({ downloadedBytes: 0 }, {
      event: 'Progress',
      data: { chunkLength: 512 },
    })
    expect(progress).toEqual({ downloadedBytes: 512 })
  })
})
