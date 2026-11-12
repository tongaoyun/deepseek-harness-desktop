/** Validate native-owned upload selections before displaying or submitting them. */
import type { KnowledgeUploadPending } from '@deepseek-harness/product/bridge'

/** Read a bounded list of file identities without accepting renderer paths.
 * @param value Native IPC response.
 * @returns Validated operation IDs, filenames, PDF options, and destinations.
 */
export function uploadSelections(value: unknown): readonly KnowledgeUploadPending[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid pending uploads')
  const selections = value.map((row: unknown): KnowledgeUploadPending => {
    if (typeof row !== 'object' || row === null || !('operationId' in row) || typeof row.operationId !== 'string'
      || !/^[A-Za-z0-9._~-]{16,128}$/u.test(row.operationId) || !('pdfParseMode' in row)
      || row.pdfParseMode !== 'STANDARD' && row.pdfParseMode !== 'TEXT'
      || 'canConfigure' in row && row.canConfigure !== true
      || !('filename' in row) || typeof row.filename !== 'string' || row.filename.length === 0 || /[\\/\0]/u.test(row.filename)
      || 'canConfigure' in row && !/\.pdf$/iu.test(row.filename)
      || 'folderId' in row && row.folderId !== null && (typeof row.folderId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(row.folderId))) {
      throw new Error('Invalid pending upload')
    }
    return { operationId: row.operationId, filename: row.filename, pdfParseMode: row.pdfParseMode, ...('canConfigure' in row ? { canConfigure: true } : {}),
      ...('folderId' in row ? { folderId: row.folderId as string | null } : {}) }
  })
  if (new Set(selections.map(row => row.operationId)).size !== selections.length) throw new Error('Duplicate upload identities')
  return selections
}
