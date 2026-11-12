import { expect, it } from 'vitest'
import { parseKnowledgeDocument, parseKnowledgeDocumentPreviewMetadata } from '../src/protocol.ts'

const identity = { id: 'document-1', knowledgeBaseId: 'base-1' }
const document = { ...identity, filename: 'policy.md', mediaType: 'text/markdown', sizeBytes: 12,
  status: 'QUEUED', chunkCount: 0, updatedAt: '2026-11-06T00:00:00Z' }

it('shares credential-free document metadata across management and model consumers', () => {
  expect(parseKnowledgeDocument({ ...document, apiKey: 'engine-secret', path: '/private/file', sourceUrl: null,
    manualContent: '说明', folderId: null, previewMaxBytes: 1024 }))
    .toEqual({ ...document, manualContent: '说明', folderId: null, previewMaxBytes: 1024 })
})

it.each([
  { sizeBytes: '12' }, { chunkCount: -1 }, { canManage: 'true' }, { folderId: 42 },
  { sourceType: {} }, { manualContent: false }, { previewMaxBytes: 0 }, { downloadMaxBytes: '1024' },
])('rejects invalid document response fields without coercion: %j', (fields) => {
  expect(() => parseKnowledgeDocument({ ...document, ...fields })).toThrow(expect.objectContaining({ code: 'INVALID_SERVER_RESPONSE' }))
})

it('normalizes common preview metadata for Host and Electron consumers', () => {
  expect(parseKnowledgeDocumentPreviewMetadata({ ...identity, filename: 'policy.docx', contentVersion: 'v1', sizeBytes: 12,
    sourceType: 'manual', previewMaxBytes: 1024, downloadMaxBytes: 2048 }, identity, { requireLimits: true }))
    .toEqual({ ...identity, filename: 'policy.docx', contentVersion: 'v1', sizeBytes: 12,
      sourceType: 'manual', previewMaxBytes: 1024, downloadMaxBytes: 2048 })
})

it.each([
  { ...identity, filename: 'policy.docx', contentVersion: 'v1', sizeBytes: 12, previewMaxBytes: 0, downloadMaxBytes: 1 },
  { ...identity, filename: 'policy.docx', contentVersion: 'v1', sizeBytes: 12, previewMaxBytes: 1 },
  { id: 'other', knowledgeBaseId: identity.knowledgeBaseId, filename: 'policy.docx', contentVersion: 'v1', sizeBytes: 12 },
])('rejects malformed or incomplete metadata (%j)', (value) => {
  expect(() => parseKnowledgeDocumentPreviewMetadata(value, identity, { requireLimits: true })).toThrow('Invalid original file metadata')
})
