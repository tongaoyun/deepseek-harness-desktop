/** Native generic-provider resolution with immutable payloads on a public package mirror. */
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider.js'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { desktopUpdateMirror, mirroredUpdateUrl, type DesktopUpdateMirror } from './update-mirror.ts'

/** Retains native feed parsing, architecture selection and differential update behavior. */
export class DesktopUpdateMirrorProvider extends GenericProvider {
  private readonly mirror: DesktopUpdateMirror

  constructor(options: Extract<Parameters<AppUpdater['setFeedURL']>[0], { provider: 'custom' }>,
    updater: ConstructorParameters<typeof GenericProvider>[1], runtime: ConstructorParameters<typeof GenericProvider>[2]) {
    const settings: unknown = options.mirror
    const channel: unknown = options.channel
    const mirror = desktopUpdateMirror({ dshDesktopUpdateMirror: settings })
    if (mirror === undefined) throw new Error('desktop update: missing package mirror')
    if (channel !== 'nightly' && channel !== 'latest') throw new Error('desktop update: invalid mirror channel')
    super({ provider: 'generic', url: `https://github.com/${mirror.githubRepository}/releases/latest/download/`, channel }, updater, runtime)
    this.mirror = mirror
  }

  override resolveFiles(info: UpdateInfo): ReturnType<GenericProvider['resolveFiles']> {
    return super.resolveFiles(info).map(file => ({ ...file, url: mirroredUpdateUrl(file.url, this.mirror) ?? file.url }))
  }
}
