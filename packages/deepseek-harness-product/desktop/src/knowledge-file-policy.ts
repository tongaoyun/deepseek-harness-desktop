/** Validated product file limits, independently configurable from official renderers. */

/** Deployment-specific limits for temporary files and preview transport. */
export interface KnowledgeFilePolicy {
  readonly previewMaxBytes: number
  readonly spreadsheetMaxBytes: number
  readonly officeInputMaxBytes: number
  readonly officeOutputMaxBytes: number
  readonly downloadMaxBytes: number
  readonly uploadMaxBytes: number
  readonly transferLifetimeMs: number
  readonly fileRequestTimeoutMs: number
  readonly maxTransfers: number
}

/** Fixed maximum payload size for one JSON or structured-clone file chunk. */
export const KNOWLEDGE_FILE_CHUNK_BYTES = 256 * 1024

/** Resolve and validate deployment configuration before accepting file requests.
 * @param value - Optional knowledgeFiles object from the main-owned product configuration.
 * @returns Complete limits aligned with the official preview defaults.
 */
export function resolveKnowledgeFilePolicy(value?: unknown): KnowledgeFilePolicy {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new Error('deepseek-harness product: knowledgeFiles must be an object')
  }
  const values = value === undefined ? {} : value as Readonly<Record<string, unknown>>
  const defaults: KnowledgeFilePolicy = {
    previewMaxBytes: 32 * 1024 * 1024,
    spreadsheetMaxBytes: 16 * 1024 * 1024,
    officeInputMaxBytes: 50 * 1024 * 1024,
    officeOutputMaxBytes: 100 * 1024 * 1024,
    downloadMaxBytes: 250 * 1024 * 1024,
    uploadMaxBytes: 50 * 1024 * 1024,
    transferLifetimeMs: 15 * 60_000,
    fileRequestTimeoutMs: 5 * 60_000,
    maxTransfers: 8,
  }
  if (Object.keys(values).some(key => !(key in defaults))) throw new Error('deepseek-harness product: unknown knowledgeFiles option')
  const result = { ...defaults }
  for (const key of Object.keys(defaults) as (keyof KnowledgeFilePolicy)[]) {
    const requested = values[key]
    if (requested === undefined) continue
    if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 1
      || (key === 'maxTransfers' ? requested > 64 : key === 'fileRequestTimeoutMs' ? requested > 1_800_000 : requested > 2 ** 31 - 1)) {
      throw new Error(`deepseek-harness product: knowledgeFiles.${key} must be a positive bounded integer`)
    }
    result[key] = requested
  }
  return result
}
