import { expect, it, vi } from 'vitest'
import { CancellationToken, NsisUpdater } from 'electron-updater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js'
import { DesktopUpdateHttpExecutor } from '../src/update-http-executor.ts'
import { DesktopUpdateMirrorProvider } from '../src/update-mirror-provider.ts'
import { canFallbackUpdateMirror, desktopUpdateMirror, mirroredUpdateUrl } from '../src/update-mirror.ts'

const mirror = { packageUrl: 'http://gitea.test/traefik/gitea/api/packages/company/generic/desktop-internal/', githubRepository: 'company/downloads' }
const source = new URL('https://github.com/company/downloads/releases/download/v1.2.3-alpha.1/desktop-x64.zip')
const expected = new URL('1.2.3-alpha.1/desktop-x64.zip', mirror.packageUrl)
const token = new CancellationToken()
const api = 'https://api.github.com/repos/company/downloads/releases/'
const feedInfo = { version: '1.2.3-alpha.1', releaseDate: '2026-10-31T00:00:00.000Z',
  path: source.href, sha512: 'expected-digest',
  files: [{ url: source.href, sha512: 'expected-digest', size: 123 }] }

function provider(platform: 'darwin' | 'win32' = 'darwin', channel: 'nightly' | 'latest' = 'nightly') {
  const updater = new NsisUpdater(null, { version: '1.0.0', name: 'update-provider-test', isPackaged: false,
    appUpdateConfigPath: '/unused/app-update.yml', userDataPath: '/unused', baseCachePath: '/unused',
    whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {},
  })
  updater.channel = channel
  return new DesktopUpdateMirrorProvider({ provider: 'custom', mirror, channel }, updater,
    { executor: new DesktopUpdateHttpExecutor(1000, undefined, mirror), platform, isUseMultipleRangeRequest: false })
}

it.each([['darwin', 'nightly'], ['win32', 'nightly'], ['darwin', 'latest'], ['win32', 'latest']] as const)(
  'discovers the same immutable %s %s release through the anonymous HTTPS API', async (platform, channel) => {
    const filename = `${channel}${platform === 'darwin' ? '-mac' : ''}.yml`
    const request = vi.spyOn(ElectronHttpExecutor.prototype, 'request')
      .mockResolvedValueOnce(JSON.stringify({ tag_name: 'v1.2.3-alpha.1', draft: false,
        assets: [{ name: filename, url: `${api}assets/123` }] })).mockResolvedValueOnce(JSON.stringify(feedInfo))
    try {
      const native = provider(platform, channel)
      const info = await native.getLatestVersion()
      expect(info).toEqual(feedInfo)
      expect(native.resolveFiles(info)[0]?.url).toEqual(expected)
      expect(request.mock.calls.map(([options]) => `${options.protocol}//${options.hostname}${options.path}`))
        .toEqual([`${api}latest`, `${api}assets/123`])
      expect(request.mock.calls.map(([options]) => options.headers)).toEqual([
        { accept: 'application/vnd.github+json', 'cache-control': 'no-cache' }, { accept: 'application/octet-stream' },
      ])
    } finally { request.mockRestore() }
  })

it.each([403, 429, 503, 'ETIMEDOUT'])('uses the original HTTPS feed when the public API is unavailable (%s)', async (failure) => {
  const error = Object.assign(new Error('unavailable'), typeof failure === 'number' ? { statusCode: failure } : { code: failure })
  const request = vi.spyOn(ElectronHttpExecutor.prototype, 'request').mockRejectedValueOnce(error)
    .mockResolvedValueOnce(JSON.stringify(feedInfo))
  try {
    expect(await provider().getLatestVersion()).toEqual(feedInfo)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1]?.[0].hostname).toBe('github.com')
    expect(new URL(`https://github.com${request.mock.calls[1]?.[0].path}`).pathname)
      .toBe('/company/downloads/releases/latest/download/nightly-mac.yml')
  } finally { request.mockRestore() }
})

it('reuses one immutable API asset until its version or asset ID changes', async () => {
  const release = { tag_name: 'v1.2.3-alpha.1', draft: false, assets: [{ name: 'nightly-mac.yml', url: `${api}assets/123` }] }
  const changed = { ...release, assets: [{ name: 'nightly-mac.yml', url: `${api}assets/456` }] }
  const request = vi.spyOn(ElectronHttpExecutor.prototype, 'request')
    .mockResolvedValueOnce(JSON.stringify(release)).mockResolvedValueOnce(JSON.stringify(feedInfo))
    .mockResolvedValueOnce(JSON.stringify(release))
    .mockResolvedValueOnce(JSON.stringify(changed)).mockResolvedValueOnce(JSON.stringify(feedInfo))
  try {
    const native = provider()
    expect(await native.getLatestVersion()).toEqual(feedInfo)
    expect(await native.getLatestVersion()).toEqual(feedInfo)
    expect(request).toHaveBeenCalledTimes(3)
    expect(await native.getLatestVersion()).toEqual(feedInfo)
    expect(request.mock.calls.map(([options]) => options.path)).toEqual([
      '/repos/company/downloads/releases/latest', '/repos/company/downloads/releases/assets/123',
      '/repos/company/downloads/releases/latest', '/repos/company/downloads/releases/latest',
      '/repos/company/downloads/releases/assets/456',
    ])
  } finally { request.mockRestore() }
})

it('stops on TLS or malformed metadata instead of concealing a trust or publication failure', async () => {
  const original = vi.spyOn(GenericProvider.prototype, 'getLatestVersion').mockResolvedValue(feedInfo)
  const request = vi.spyOn(ElectronHttpExecutor.prototype, 'request')
  const release = { tag_name: 'v1.2.3-alpha.1', draft: false, assets: [{ name: 'nightly-mac.yml', url: `${api}assets/123` }] }
  try {
    request.mockRejectedValueOnce(Object.assign(new Error('TLS failed'), { code: 'ERR_CERT_AUTHORITY_INVALID' }))
    await expect(provider().getLatestVersion()).rejects.toThrow('TLS failed')
    request.mockResolvedValueOnce('{broken json')
    await expect(provider().getLatestVersion()).rejects.toBeInstanceOf(SyntaxError)
    for (const invalid of [null, { ...release, draft: true }, { ...release, tag_name: 'latest' }, { ...release, assets: [] },
      { ...release, assets: [...release.assets, ...release.assets] },
      { ...release, assets: [{ name: 'nightly-mac.yml', url: 'http://api.github.com/repos/company/downloads/releases/assets/123' }] },
      { ...release, assets: [{ name: 'nightly-mac.yml', url: `${api}assets/123?token=secret` }] },
      { ...release, assets: [{ name: 'nightly-mac.yml', url: `${api}assets/../latest` }] }]) {
      request.mockResolvedValueOnce(JSON.stringify(invalid))
      await expect(provider().getLatestVersion()).rejects.toThrow(/public (?:release metadata|update feed)/u)
    }
    request.mockResolvedValueOnce(JSON.stringify(release)).mockResolvedValueOnce(JSON.stringify({ ...feedInfo, version: '0.0.1' }))
    await expect(provider().getLatestVersion()).rejects.toThrow('feed version differs')
    expect(original).not.toHaveBeenCalled()
  } finally { request.mockRestore(); original.mockRestore() }
})

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
