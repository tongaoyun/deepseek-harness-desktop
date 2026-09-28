/** Resolve Xiaoyin-owned product configuration without exposing it to Renderer. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Inputs used to locate and validate the packaged product configuration. */
export interface XiaoyinProductConfigOptions {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
  readonly environment?: NodeJS.ProcessEnv
  readonly readFile?: (path: string) => string
}

interface XiaoyinProductConfigDocument {
  readonly version: 1
  readonly serverUrl: string
}

function validateServerUrl(value: unknown, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`xiaoyin product: ${source} must define a non-empty serverUrl`)
  }
  let url: URL
  try { url = new URL(value.trim()) } catch {
    throw new Error(`xiaoyin product: ${source} serverUrl must be an absolute HTTP(S) URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || !['', '/'].includes(url.pathname)) {
    throw new Error(`xiaoyin product: ${source} serverUrl must be an HTTP(S) origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

/**
 * Resolve the Xiaoyin server origin. Packaged applications always use their
 * packaged resource; only unpackaged development launches accept an override.
 * @param options - Runtime paths and optional development environment.
 * @returns Validated Xiaoyin server origin.
 */
export function resolveXiaoyinProductServerUrl(options: XiaoyinProductConfigOptions): string {
  const environment = options.environment ?? process.env
  const developmentOverride = options.packaged ? undefined : environment.XIAOYIN_SERVER_URL?.trim()
  if (developmentOverride !== undefined && developmentOverride !== '') {
    return validateServerUrl(developmentOverride, 'XIAOYIN_SERVER_URL')
  }
  const path = options.packaged
    ? join(options.resourcesPath, 'xiaoyin', 'product.json')
    : join(options.appPath, 'resources', 'xiaoyin-product.json')
  let document: unknown
  try {
    const raw = (options.readFile ?? ((file: string) => readFileSync(file, 'utf8')))(path)
    document = JSON.parse(raw)
  } catch (error) {
    throw new Error(`xiaoyin product: unable to read ${path}`, { cause: error })
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)
    || (document as { version?: unknown }).version !== 1) {
    throw new Error(`xiaoyin product: ${path} must use schema version 1`)
  }
  return validateServerUrl((document as XiaoyinProductConfigDocument).serverUrl, path)
}
