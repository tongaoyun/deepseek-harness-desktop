/** Resolve DeepSeekHarness-owned product configuration without exposing it to Renderer. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Inputs used to locate and validate the packaged product configuration. */
export interface DeepSeekHarnessProductConfigOptions {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
  readonly environment?: NodeJS.ProcessEnv
  readonly readFile?: (path: string) => string
}

interface DeepSeekHarnessProductConfigDocument {
  readonly version: 1
  readonly serverUrl: string
}

function validateServerUrl(value: unknown, source: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`deepseek-harness product: ${source} must define a non-empty serverUrl`)
  }
  let url: URL
  try { url = new URL(value.trim()) } catch {
    throw new Error(`deepseek-harness product: ${source} serverUrl must be an absolute HTTP(S) URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || !['', '/'].includes(url.pathname)) {
    throw new Error(`deepseek-harness product: ${source} serverUrl must be an HTTP(S) origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

/**
 * Resolve the DeepSeekHarness server origin. Packaged applications always use their
 * packaged resource; only unpackaged development launches accept an override.
 * @param options - Runtime paths and optional development environment.
 * @returns Validated DeepSeekHarness server origin.
 */
export function resolveDeepSeekHarnessProductServerUrl(options: DeepSeekHarnessProductConfigOptions): string {
  const environment = options.environment ?? process.env
  const developmentOverride = options.packaged ? undefined : environment.DEEPSEEK_HARNESS_SERVER_URL?.trim()
  if (developmentOverride !== undefined && developmentOverride !== '') {
    return validateServerUrl(developmentOverride, 'DEEPSEEK_HARNESS_SERVER_URL')
  }
  const path = options.packaged
    ? join(options.resourcesPath, 'deepseek-harness', 'product.json')
    : join(options.appPath, 'resources', 'deepseek-harness-product.json')
  let document: unknown
  try {
    const raw = (options.readFile ?? ((file: string) => readFileSync(file, 'utf8')))(path)
    document = JSON.parse(raw)
  } catch (error) {
    throw new Error(`deepseek-harness product: unable to read ${path}`, { cause: error })
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)
    || (document as { version?: unknown }).version !== 1) {
    throw new Error(`deepseek-harness product: ${path} must use schema version 1`)
  }
  return validateServerUrl((document as DeepSeekHarnessProductConfigDocument).serverUrl, path)
}
