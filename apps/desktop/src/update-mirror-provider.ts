/** HTTPS release discovery and native generic-provider resolution for public package mirrors. */
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js'
import { parseUpdateInfo } from 'electron-updater/out/providers/Provider.js'
import { CancellationToken, type AppUpdater, type UpdateInfo } from 'electron-updater'
import { canFallbackUpdateMirror, desktopUpdateMirror, mirroredUpdateUrl, type DesktopUpdateMirror } from './update-mirror.ts'

/** Retains native feed parsing, architecture selection and differential update behavior. */
export class DesktopUpdateMirrorProvider extends GenericProvider {
  private readonly mirror: DesktopUpdateMirror
  private readonly feedChannel: 'nightly' | 'latest'
  private cachedFeed: { readonly url: string; readonly info: UpdateInfo } | undefined

  constructor(options: Extract<Parameters<AppUpdater['setFeedURL']>[0], { provider: 'custom' }>,
    updater: ConstructorParameters<typeof GenericProvider>[1], runtime: ConstructorParameters<typeof GenericProvider>[2]) {
    const settings: unknown = options.mirror
    const channel: unknown = options.channel
    const mirror = desktopUpdateMirror({ dshDesktopUpdateMirror: settings })
    if (mirror === undefined) throw new Error('desktop update: missing package mirror')
    if (channel !== 'nightly' && channel !== 'latest') throw new Error('desktop update: invalid mirror channel')
    super({ provider: 'generic', url: `https://github.com/${mirror.githubRepository}/releases/latest/download/`, channel }, updater, runtime)
    this.mirror = mirror
    this.feedChannel = channel
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    try { return await this.getApiVersion() }
    catch (error) {
      // Anonymous API rate limits use 403; both discovery routes retain HTTPS and the same published release.
      if (!(error instanceof Error && 'statusCode' in error && error.statusCode === 403)
        && !canFallbackUpdateMirror(error, { cancellationToken: new CancellationToken() })) throw error
      return super.getLatestVersion()
    }
  }

  override resolveFiles(info: UpdateInfo): ReturnType<GenericProvider['resolveFiles']> {
    return super.resolveFiles(info).map(file => ({ ...file, url: mirroredUpdateUrl(file.url, this.mirror) ?? file.url }))
  }

  private async getApiVersion(): Promise<UpdateInfo> {
    const api = `https://api.github.com/repos/${this.mirror.githubRepository}/releases/`
    const release: unknown = JSON.parse(await this.httpRequest(new URL(`${api}latest`),
      { accept: 'application/vnd.github+json', 'cache-control': 'no-cache' }) ?? 'null')
    if (typeof release !== 'object' || release === null || !('tag_name' in release) || typeof release.tag_name !== 'string'
      || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(release.tag_name)
      || !('draft' in release) || release.draft !== false || !('assets' in release) || !Array.isArray(release.assets)) {
      throw new Error('desktop update: invalid public release metadata')
    }
    const filename = `${this.getCustomChannelName(this.feedChannel)}.yml`
    const assets: readonly unknown[] = release.assets
    const matches = assets.filter((asset): asset is { name: string; url: string } =>
      typeof asset === 'object' && asset !== null && 'name' in asset && asset.name === filename
      && 'url' in asset && typeof asset.url === 'string')
    const [asset] = matches
    if (matches.length !== 1 || asset === undefined || !asset.url.startsWith(`${api}assets/`)
      || !/^\d+$/u.test(asset.url.slice(`${api}assets/`.length))) {
      throw new Error('desktop update: missing or invalid public update feed')
    }
    const url = new URL(asset.url)
    if (this.cachedFeed?.url === url.href && this.cachedFeed.info.version === release.tag_name.slice(1)) return this.cachedFeed.info
    const info = parseUpdateInfo(await this.httpRequest(url, { accept: 'application/octet-stream' }), filename, url)
    if (info.version !== release.tag_name.slice(1)) throw new Error('desktop update: feed version differs from its release')
    this.cachedFeed = { url: url.href, info }
    return info
  }
}
