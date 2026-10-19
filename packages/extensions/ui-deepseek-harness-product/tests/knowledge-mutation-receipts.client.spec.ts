import { expect, it } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { productErrorMessage } from '../src/client/product-errors.ts'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
import { confirmKnowledgeDocumentMutation, confirmKnowledgeFolderDeletion } from '../src/client/knowledge-mutation-receipts.ts'

const target = { knowledgeBaseId: 'personal', documentId: 'document', folderId: 'destination' }
const document = { id: target.documentId, knowledgeBaseId: target.knowledgeBaseId, filename: 'Notes.md', mediaType: 'text/markdown',
  sizeBytes: 20, status: 'QUEUED', chunkCount: 0, updatedAt: '2026-10-20T00:00:00Z' }
const unknownOutcome = { code: 'IDEMPOTENCY_OPERATION_UNKNOWN', retryable: true }

it('requires the moved document, destination and explicit acknowledgement', () => {
  const receipt = { documentId: target.documentId, folderId: target.folderId, moved: true }
  for (const value of [null, [], {}, { ...receipt, documentId: 'other' }, { ...receipt, folderId: 'other' },
    { ...receipt, moved: false }, { documentId: target.documentId, moved: true }]) {
    expect(() => { confirmKnowledgeDocumentMutation('move', value, target) }).toThrow(expect.objectContaining(unknownOutcome))
  }
  confirmKnowledgeDocumentMutation('move', receipt, target)
  confirmKnowledgeDocumentMutation('move', { ...receipt, folderId: null }, { ...target, folderId: null })
})

it('requires a deletion task for the requested document', () => {
  const receipt = { documentId: target.documentId, taskId: 'task', status: 'DELETING' }
  for (const value of [null, {}, { ...receipt, documentId: 'other' }, { ...receipt, taskId: '' },
    { documentId: target.documentId, status: 'DELETING' }, { ...receipt, status: 'READY' }]) {
    expect(() => { confirmKnowledgeDocumentMutation('delete', value, target) }).toThrow(expect.objectContaining(unknownOutcome))
  }
  confirmKnowledgeDocumentMutation('delete', receipt, target)
})

it.each(['reindex', 'cancel'] as const)('requires complete matching document metadata for %s', (action) => {
  const receipt = { ...document, status: action === 'cancel' ? 'CANCELLED' : 'QUEUED' }
  for (const value of [null, {}, { id: target.documentId }, { ...receipt, id: 'other' }, { ...receipt, knowledgeBaseId: 'other' },
    { ...receipt, filename: '' }, { ...receipt, updatedAt: '' }, { ...receipt, status: '' },
    ...(action === 'cancel' ? [{ ...receipt, status: 'PROCESSING' }] : [])]) {
    expect(() => { confirmKnowledgeDocumentMutation(action, value, target) }).toThrow(expect.objectContaining(unknownOutcome))
  }
  confirmKnowledgeDocumentMutation(action, receipt, target)
})

it('accepts deletion or confirmed absence of the selected folder', () => {
  for (const value of [null, {}, { deleted: true }, { folderId: 'other', deleted: true }, { folderId: 'folder', deleted: 'true' }]) {
    expect(() => { confirmKnowledgeFolderDeletion(value, 'folder') }).toThrow(expect.objectContaining(unknownOutcome))
  }
  confirmKnowledgeFolderDeletion({ folderId: 'folder', deleted: true }, 'folder')
  confirmKnowledgeFolderDeletion({ folderId: 'folder', deleted: false }, 'folder')
})

it('distinguishes file operation recovery from retained editor drafts', () => {
  const error = new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Private diagnostics', true)
  const t = (key: DeepSeekHarnessProductKey) => zh[key]
  expect(productErrorMessage(error, t, 'knowledgeChangeFailed')).toBe(`${zh.knowledgeChangeUnconfirmed} (${error.code})`)
  expect(productErrorMessage(error, t, 'knowledgeSaveFailed')).toBe(`${zh.knowledgeOperationUnknown} (${error.code})`)
})
