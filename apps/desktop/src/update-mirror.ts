/** Credential-free, immutable package mirrors for native updater payloads. */
import type { DesktopUpdateHttpExecutor } from './update-http-executor.ts'

/** A public package directory containing the same versioned files as a GitHub release. */
export interface DesktopUpdateMirror {
  readonly packageUrl: string
  readonly githubRepository: string
}

/**
 * Read optional installer-owned mirror settings; omission retains the upstream download path.
 * @param manifest - Packaged application metadata.
 * @returns Validated mirror or undefined when this distribution declares none.
 */
export function desktopUpdateMirror(manifest: unknown): DesktopUpdateMirror | undefined {
  if (typeof manifest !== 'object' || manifest === null || !('dshDesktopUpdateMirror' in manifest)) return undefined
  const value = manifest.dshDesktopUpdateMirror
  if (typeof value !== 'object' || value === null || !('packageUrl' in value) || !('githubRepository' in value)
    || typeof value.packageUrl !== 'string' || typeof value.githubRepository !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value.githubRepository)) {
    throw new Error('desktop update: invalid package mirror configuration')
  }
  const url = new URL(value.packageUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !/^\/(?:[^/]+\/)*api\/packages\/[^/]+\/generic\/[^/]+\/$/u.test(url.pathname)) {
    throw new Error('desktop update: mirror requires a credential-free generic package directory')
  }
  return { packageUrl: url.href, githubRepository: value.githubRepository }
}

/**
 * Translate only immutable release payloads; feed checks and unrelated requests keep their original route.
 * @param source - Native provider URL, including optional differential blockmaps.
 * @param mirror - Installer-owned package mirror, or undefined for upstream routing.
 * @returns The exact version and filename on the mirror, or undefined for another request.
 */
export function mirroredUpdateUrl(source: URL, mirror: DesktopUpdateMirror | undefined): URL | undefined {
  if (mirror === undefined || source.origin !== 'https://github.com' || source.username || source.password || source.search || source.hash) return undefined
  const prefix = `/${mirror.githubRepository}/releases/download/v`
  if (!source.pathname.startsWith(prefix)) return undefined
  const parts = source.pathname.slice(prefix.length).split('/')
  if (parts.length !== 2 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(parts[0] ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|zip|dmg|blockmap)$/u.test(parts[1] ?? '')) return undefined
  return new URL(parts.join('/'), mirror.packageUrl)
}

/**
 * Fall back once only on unavailable external storage; integrity, authorization and cancellation failures stop.
 * @param error - Native transport failure.
 * @param options - Original updater cancellation token.
 * @returns Whether a second storage origin may serve the same immutable bytes.
 */
export function canFallbackUpdateMirror(error: unknown, options: Parameters<DesktopUpdateHttpExecutor['download']>[2]): boolean {
  if (options.cancellationToken.cancelled || !(error instanceof Error)) return false
  if ('statusCode' in error && typeof error.statusCode === 'number') {
    return [404, 408, 429, 500, 502, 503, 504].includes(error.statusCode)
  }
  return 'code' in error && typeof error.code === 'string'
    && ['DSH_UPDATE_HTTP_TRANSPORT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
      'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED',
      'ERR_INTERNET_DISCONNECTED', 'ERR_ADDRESS_UNREACHABLE'].includes(error.code)
}

/**
 * Find the immutable GitHub fallback for a provider-selected mirror payload.
 * @param source - Native provider URL.
 * @param mirror - Installer-owned package mirror, or undefined for upstream routing.
 * @returns Exact fallback URL, or undefined when this is not an owned mirror request.
 */
export function updateMirrorFallbackUrl(source: URL, mirror: DesktopUpdateMirror | undefined): URL | undefined {
  if (mirror === undefined || !source.href.startsWith(mirror.packageUrl)) return undefined
  const candidate = new URL(`https://github.com/${mirror.githubRepository}/releases/download/v${source.href.slice(mirror.packageUrl.length)}`)
  return mirroredUpdateUrl(candidate, mirror)?.href === source.href ? candidate : undefined
}
