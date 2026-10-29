import { expect, it } from 'vitest'
import { parseKnowledgeDocumentPreviewMetadata } from '../src/protocol.ts'

const identity = { id: 'document-1', knowledgeBaseId: 'base-1' }

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
