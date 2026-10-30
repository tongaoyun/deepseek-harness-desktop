import { expect, it, vi } from 'vitest'
import { CancellationToken } from 'electron-updater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { DesktopUpdateHttpExecutor } from '../src/update-http-executor.ts'
import { canFallbackUpdateMirror, desktopUpdateMirror, mirroredUpdateUrl } from '../src/update-mirror.ts'

const mirror = { packageUrl: 'http://gitea.test/traefik/gitea/api/packages/company/generic/desktop-internal/', githubRepository: 'company/downloads' }
const source = new URL('https://github.com/company/downloads/releases/download/v1.2.3-alpha.1/desktop-x64.zip')
const expected = new URL('1.2.3-alpha.1/desktop-x64.zip', mirror.packageUrl)
const token = new CancellationToken()

it('maps only the configured repository and preserves immutable version and filename', () => {
  expect(desktopUpdateMirror({ dshDesktopUpdateMirror: mirror })).toEqual(mirror)
  expect(desktopUpdateMirror({})).toBeUndefined()
  expect(mirroredUpdateUrl(source, mirror)).toEqual(expected)
  for (const value of ['https://github.com/other/downloads/releases/download/v1.2.3/a.zip',
    'https://github.com/company/downloads/releases/latest/download/nightly.yml',
    `${source}?secret=value`, 'https://github.com/company/downloads/releases/download/v1.2.3/sub/a.zip',
    'https://github.com/company/downloads/releases/download/v../a.zip', 'https://elsewhere.test/a.zip']) {
    expect(mirroredUpdateUrl(new URL(value), mirror)).toBeUndefined()
  }
  for (const packageUrl of ['https://user:password@gitea.test/api/packages/a/generic/b/',
    'file:///api/packages/a/generic/b/', 'https://gitea.test/api/packages/a/generic/b/?token=x',
    'https://gitea.test/arbitrary/']) {
    expect(() => desktopUpdateMirror({ dshDesktopUpdateMirror: { ...mirror, packageUrl } })).toThrow()
  }
})

it('uses the native download and digest checks on the mirror before consulting GitHub', async () => {
  const options = { cancellationToken: token, sha512: 'native-expected-hash', headers: { Authorization: 'private', Cookie: 'private' } }
  const native = vi.spyOn(ElectronHttpExecutor.prototype, 'download').mockResolvedValue('/downloaded')
  try {
    const executor = new DesktopUpdateHttpExecutor(1000, undefined, mirror)
    expect(await executor.download(source, '/destination', options)).toBe('/downloaded')
    expect(native).toHaveBeenCalledExactlyOnceWith(expected, '/destination', { ...options, headers: null })
    native.mockReset().mockRejectedValueOnce(Object.assign(new Error('unavailable'), { statusCode: 503 })).mockResolvedValue('/fallback')
    expect(await executor.download(source, '/destination', options)).toBe('/fallback')
    expect(native.mock.calls.map(call => call[0])).toEqual([expected, source])
    expect(native.mock.calls[1]?.[2]).toBe(options)
  } finally { native.mockRestore() }
})

it('never falls back on cancellation, authorization, digest mismatch or unknown native failures', async () => {
  for (const failure of [Object.assign(new Error('unauthorized'), { statusCode: 401 }),
    Object.assign(new Error('forbidden'), { statusCode: 403 }),
    Object.assign(new Error('digest mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' }), new Error('unknown')]) {
    const native = vi.spyOn(ElectronHttpExecutor.prototype, 'download').mockRejectedValue(failure)
    try {
      await expect(new DesktopUpdateHttpExecutor(1000, undefined, mirror).download(source, '/destination', { cancellationToken: token })).rejects.toBe(failure)
      expect(native).toHaveBeenCalledOnce()
    } finally { native.mockRestore() }
  }
  const cancelled = new CancellationToken()
  cancelled.cancel()
  expect(canFallbackUpdateMirror(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    { cancellationToken: cancelled })).toBe(false)
})

it('uses the same routing for blockmaps, and never catches errors from the fallback', async () => {
  const native = vi.spyOn(ElectronHttpExecutor.prototype, 'downloadToBuffer')
    .mockRejectedValueOnce(Object.assign(new Error('not found'), { statusCode: 404 })).mockRejectedValueOnce(new Error('fallback failed'))
  const blockmap = new URL(`${source}.blockmap`)
  try {
    await expect(new DesktopUpdateHttpExecutor(1000, undefined, mirror).downloadToBuffer(blockmap, { cancellationToken: token })).rejects.toThrow('fallback failed')
    expect(native.mock.calls.map(call => call[0])).toEqual([new URL(`${expected}.blockmap`), blockmap])
  } finally { native.mockRestore() }
})
