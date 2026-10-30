/** Electron-native inactivity deadlines for updater checks, full downloads, and blockmap requests. */
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import type { RequestOptions } from 'node:http'
import type { ClientRequest, IncomingMessage } from 'electron'
import { canFallbackUpdateMirror, mirroredUpdateUrl, updateMirrorFallbackUrl, type DesktopUpdateMirror } from './update-mirror.ts'

/** Retains electron-updater transport and proxy handling while bounding silent connections. */
export class DesktopUpdateHttpExecutor extends ElectronHttpExecutor {
  /**
   * @param idleTimeoutMs - Maximum silence before headers or between response chunks, not a total download deadline.
   * @param proxyLogin - Existing updater login event forwarding.
   * @param mirror - Optional credential-free payload mirror; native hash verification remains mandatory.
   */
  constructor(private readonly idleTimeoutMs: number, proxyLogin?: ConstructorParameters<typeof ElectronHttpExecutor>[0],
    private readonly mirror?: DesktopUpdateMirror) {
    super(proxyLogin)
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 2_147_483_647) {
      throw new Error('desktop update: HTTP idle timeout must be an integer from 1000 through 2147483647')
    }
  }

  override createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
    if (this.mirror !== undefined) {
      const directory = new URL(this.mirror.packageUrl)
      if (options.protocol === directory.protocol && options.hostname === directory.hostname
        && String(options.port ?? '') === directory.port && options.path?.startsWith(directory.pathname)) {
        // Differential requests enter here directly; retain byte ranges without forwarding credentials.
        options = { ...options, auth: undefined,
          headers: Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) => name.toLowerCase() === 'range')) }
      }
    }
    const request = super.createRequest(options, (response: IncomingMessage) => {
      // The native full-download path otherwise discards HTTP status when creating its Error.
      if (response.statusCode >= 400) {
        request.emit('error', Object.assign(new Error(`Desktop update HTTP request failed (${response.statusCode})`),
          { statusCode: response.statusCode, code: `HTTP_ERROR_${response.statusCode}` }))
        request.abort()
        return
      }
      callback(response)
    })
    // Electron HTTP errors can omit their code. HTTPS errors retain their TLS classification.
    if (options.protocol === 'http:') {
      request.prependOnceListener('error', (error: Error) => {
        if (!('code' in error)) Object.assign(error, { code: 'DSH_UPDATE_HTTP_TRANSPORT' })
      })
    }
    return request
  }

  override async download(url: URL, destination: string, options: Parameters<ElectronHttpExecutor['download']>[2]): Promise<string> {
    const fallback = updateMirrorFallbackUrl(url, this.mirror) ?? url
    const mirror = mirroredUpdateUrl(url, this.mirror) ?? (fallback === url ? undefined : url)
    if (mirror === undefined) return super.download(url, destination, options)
    try { return await super.download(mirror, destination, { ...options, headers: null }) }
    catch (error) {
      if (!canFallbackUpdateMirror(error, options)) throw error
      return super.download(fallback, destination, options)
    }
  }

  override async downloadToBuffer(url: URL, options: Parameters<ElectronHttpExecutor['downloadToBuffer']>[1]): Promise<Buffer> {
    const fallback = updateMirrorFallbackUrl(url, this.mirror) ?? url
    const mirror = mirroredUpdateUrl(url, this.mirror) ?? (fallback === url ? undefined : url)
    if (mirror === undefined) return super.downloadToBuffer(url, options)
    try { return await super.downloadToBuffer(mirror, { ...options, headers: null }) }
    catch (error) {
      if (!canFallbackUpdateMirror(error, options)) throw error
      return super.downloadToBuffer(fallback, options)
    }
  }

  override addErrorAndTimeoutHandlers(request: ClientRequest, reject: (error: Error) => void): void {
    // The upstream socket timer is for Node HTTP; Electron ClientRequest has response/close events instead.
    super.addErrorAndTimeoutHandlers(request, reject, this.idleTimeoutMs)
    let response: IncomingMessage | undefined
    let timer: ReturnType<typeof setTimeout>
    const stop = (): void => {
      clearTimeout(timer)
      request.off('response', onResponse)
      request.off('abort', stop)
      request.off('error', stop)
      response?.off('data', refresh)
      response?.off('end', stop)
      response?.off('error', stop)
    }
    const refresh = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stop()
        reject(Object.assign(new Error('Desktop update connection timed out'), { code: 'ETIMEDOUT' }))
        request.abort()
      }, this.idleTimeoutMs)
    }
    const onResponse = (incoming: IncomingMessage): void => {
      response = incoming
      response.on('data', refresh)
      response.once('end', stop)
      response.once('error', stop)
      refresh()
    }
    request.once('response', onResponse)
    // Electron 44 can emit writable close after finish, before response headers arrive.
    request.once('abort', stop)
    request.once('error', stop)
    refresh()
  }
}
