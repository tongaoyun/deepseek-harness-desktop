import { describe, expect, it } from 'vitest'
import { updateDownloadProgress } from './updater'

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
