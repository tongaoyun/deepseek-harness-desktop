/** Resolve product configuration in the credential-owning desktop module. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveKnowledgeFilePolicy, type KnowledgeFilePolicy } from './knowledge-file-policy.ts'
import type { DesktopSupportPolicy } from './desktop-support.ts'
import { resolveConnectorProxyPolicy, type ConnectorProxyPolicy } from './connector-proxy.ts'

/** Inputs used to locate and validate the packaged product configuration. */
export interface DeepSeekHarnessProductConfigOptions {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly environment?: NodeJS.ProcessEnv
  readonly readFile?: (path: string) => string
}

/** Validated deployment settings shared by one desktop extension lifetime. */
export interface DeepSeekHarnessProductConfig {
  readonly serverUrl: string
  readonly knowledgeFiles: KnowledgeFilePolicy
  readonly support: DesktopSupportPolicy
  readonly connectorProxy: ConnectorProxyPolicy
  readonly companyContentRefreshIntervalMs: number
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
 * Read deployment settings once before starting product resources. Packaged apps
 * always use their server origin; development may override only the origin.
 * @param options - Runtime paths and optional development environment.
 * @returns Validated settings retained for this extension's lifetime; unreadable or invalid resources throw.
 */
export function resolveDeepSeekHarnessProductConfig(options: DeepSeekHarnessProductConfigOptions): DeepSeekHarnessProductConfig {
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
    || !('version' in document) || document.version !== 1) {
    throw new Error(`deepseek-harness product: ${path} must use schema version 1`)
  }
  const environment = options.environment ?? process.env
  const developmentOverride = options.packaged ? undefined : environment.DEEPSEEK_HARNESS_SERVER_URL?.trim()
  const serverUrl = developmentOverride !== undefined && developmentOverride !== ''
    ? validateServerUrl(developmentOverride, 'DEEPSEEK_HARNESS_SERVER_URL')
    : validateServerUrl('serverUrl' in document ? document.serverUrl : undefined, path)
  const support = 'support' in document ? document.support : undefined
  if (typeof support !== 'object' || support === null
    || !('heartbeatIntervalMs' in support) || typeof support.heartbeatIntervalMs !== 'number'
    || !Number.isSafeInteger(support.heartbeatIntervalMs) || support.heartbeatIntervalMs < 60_000
    || support.heartbeatIntervalMs > 3_600_000
    || !('reportIntervalMs' in support) || typeof support.reportIntervalMs !== 'number'
    || !Number.isSafeInteger(support.reportIntervalMs) || support.reportIntervalMs < support.heartbeatIntervalMs
    || support.reportIntervalMs > 86_400_000) throw new Error('Invalid desktop support policy')
  if (!('companyContentRefreshIntervalMs' in document)
    || typeof document.companyContentRefreshIntervalMs !== 'number' || !Number.isSafeInteger(document.companyContentRefreshIntervalMs)
    || document.companyContentRefreshIntervalMs < 1000 || document.companyContentRefreshIntervalMs > 3_600_000) {
    throw new Error('Invalid company content refresh interval')
  }
  return {
    serverUrl,
    knowledgeFiles: resolveKnowledgeFilePolicy('knowledgeFiles' in document ? document.knowledgeFiles : undefined),
    support: { heartbeatIntervalMs: support.heartbeatIntervalMs, reportIntervalMs: support.reportIntervalMs },
    connectorProxy: resolveConnectorProxyPolicy('connectorProxy' in document ? document.connectorProxy : undefined),
    companyContentRefreshIntervalMs: document.companyContentRefreshIntervalMs,
  }
}
