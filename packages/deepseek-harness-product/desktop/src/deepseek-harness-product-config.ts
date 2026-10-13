/** Resolve product configuration in the credential-owning desktop module. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveKnowledgeFilePolicy, type KnowledgeFilePolicy } from './knowledge-file-policy.ts'
import type { DesktopSupportPolicy } from './desktop-support.ts'

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
    : fileURLToPath(new URL('../resources/product.json', import.meta.url))
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

/** Read packaged file policy; credentials and paths never come from Renderer.
 * @param options - Runtime paths and optional test file reader.
 * @returns Validated limits for the product-owned file transport.
 */
export function resolveDeepSeekHarnessKnowledgeFilePolicy(options: DeepSeekHarnessProductConfigOptions): KnowledgeFilePolicy {
  const path = options.packaged
    ? join(options.resourcesPath, 'deepseek-harness', 'product.json')
    : fileURLToPath(new URL('../resources/product.json', import.meta.url))
  const document: unknown = JSON.parse((options.readFile ?? ((file: string) => readFileSync(file, 'utf8')))(path))
  if (typeof document !== 'object' || document === null || Array.isArray(document) || !('version' in document) || document.version !== 1) {
    throw new Error(`deepseek-harness product: ${path} must use schema version 1`)
  }
  return resolveKnowledgeFilePolicy('knowledgeFiles' in document ? document.knowledgeFiles : undefined)
}

/** Read deployment-owned heartbeat intervals from the packaged product configuration.
 * @param options - Product resource location and optional test reader.
 * @returns Validated presence and full-report intervals.
 */
export function resolveDesktopSupportPolicy(options: DeepSeekHarnessProductConfigOptions): DesktopSupportPolicy {
  const path = options.packaged ? join(options.resourcesPath, 'deepseek-harness', 'product.json')
    : fileURLToPath(new URL('../resources/product.json', import.meta.url))
  const document: unknown = JSON.parse((options.readFile ?? ((file: string) => readFileSync(file, 'utf8')))(path))
  if (typeof document !== 'object' || document === null || !('support' in document)
    || typeof document.support !== 'object' || document.support === null
    || !('heartbeatIntervalMs' in document.support) || typeof document.support.heartbeatIntervalMs !== 'number'
    || !Number.isSafeInteger(document.support.heartbeatIntervalMs) || document.support.heartbeatIntervalMs < 60_000
    || document.support.heartbeatIntervalMs > 3_600_000
    || !('reportIntervalMs' in document.support) || typeof document.support.reportIntervalMs !== 'number'
    || !Number.isSafeInteger(document.support.reportIntervalMs) || document.support.reportIntervalMs < document.support.heartbeatIntervalMs
    || document.support.reportIntervalMs > 86_400_000) throw new Error('Invalid desktop support policy')
  return { heartbeatIntervalMs: document.support.heartbeatIntervalMs, reportIntervalMs: document.support.reportIntervalMs }
}
