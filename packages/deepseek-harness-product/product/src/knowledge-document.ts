/** Credential-free document metadata shared by employee pages and model tools. */
import { ProductError } from './errors.ts'

/** Document metadata and optional manager-only editable text. */
export interface KnowledgeDocument {
  readonly id: string
  readonly knowledgeBaseId: string
  readonly filename: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly status: string
  readonly chunkCount: number
  readonly failureMessage?: string
  readonly updatedAt: string
  readonly sourceType?: string
  readonly sourceUrl?: string
  readonly manualContent?: string
  /** Detail-only permission projection; list actions use the library's management permission. */
  readonly canManage?: boolean
  readonly folderId?: string | null
  readonly previewMaxBytes?: number
  readonly downloadMaxBytes?: number
  readonly uploadMaxBytes?: number
}

/** Read document metadata without forwarding undeclared server fields.
 * @param value - Untrusted product document response.
 * @returns Validated metadata; callers confirm operation-specific identities separately.
 */
export function parseKnowledgeDocument(value: unknown): KnowledgeDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid()
  const row = value as Record<string, unknown>
  for (const key of ['failureMessage', 'sourceType', 'sourceUrl', 'manualContent']) {
    if (row[key] != null && typeof row[key] !== 'string') throw invalid()
  }
  if (row.canManage != null && typeof row.canManage !== 'boolean'
    || row.folderId != null && typeof row.folderId !== 'string') throw invalid()
  for (const key of ['previewMaxBytes', 'downloadMaxBytes', 'uploadMaxBytes']) {
    if (row[key] != null && (typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || row[key] < 1)) throw invalid()
  }
  return {
    id: text(row.id), knowledgeBaseId: text(row.knowledgeBaseId), filename: text(row.filename),
    mediaType: text(row.mediaType), sizeBytes: count(row.sizeBytes), status: text(row.status),
    chunkCount: count(row.chunkCount), updatedAt: text(row.updatedAt),
    ...Object.fromEntries(['failureMessage', 'sourceType', 'sourceUrl', 'manualContent'].flatMap(key =>
      typeof row[key] === 'string' ? [[key, row[key]]] : [])),
    ...(typeof row.canManage === 'boolean' ? { canManage: row.canManage } : {}),
    ...(row.folderId === null || typeof row.folderId === 'string' ? { folderId: row.folderId } : {}),
    ...Object.fromEntries(['previewMaxBytes', 'downloadMaxBytes', 'uploadMaxBytes'].flatMap(key =>
      typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] > 0 ? [[key, row[key]]] : [])),
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw invalid()
  return value
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid()
  return value
}
function invalid(): ProductError {
  return new ProductError('INVALID_SERVER_RESPONSE', 'Invalid knowledge document response', false)
}
