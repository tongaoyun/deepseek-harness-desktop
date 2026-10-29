/** Validated knowledge operations over the authenticated product server. */
import type { DeepSeekHarnessApiClient } from './http-client.ts'
import { ProductError } from './errors.ts'
import { isKnowledgeResourceId, type KnowledgePdfParseMode } from './protocol.ts'

/** Native file selection is owned by the desktop; renderer payloads contain no paths. */
export interface KnowledgeUpload {
  /** Retain native-selected files with fixed destinations; return names and independent operation IDs. */
  choose(baseId: string, pdfParseMode: KnowledgePdfParseMode, folderId: string | null | undefined,
    signal?: AbortSignal): Promise<readonly KnowledgeUploadPending[]>
  /** Upload a retained file with its original request identity and destination. */
  send(baseId: string, operationId: string, pdfParseMode: KnowledgePdfParseMode,
    folderId: string | null | undefined, api: DeepSeekHarnessApiClient, signal?: AbortSignal): Promise<unknown>
  /** Release a retained native selection without repeating its remote write. */
  discard(baseId: string, operationId: string): void
  /** Read bounded employee-owned retry information without local paths or hashes. */
  pending(baseId: string): readonly KnowledgeUploadPending[]
}

/** Public identity of a native selection retained for an unconfirmed upload. */
export interface KnowledgeUploadPending {
  readonly operationId: string
  readonly filename: string
  readonly pdfParseMode: KnowledgePdfParseMode
  readonly folderId?: string | null | undefined
}

/** Dispatch knowledge management without exposing upstream URLs or credentials.
 * @param api Authenticated, main-owned server transport.
 * @param method Allowlisted knowledge method.
 * @param input Untrusted IPC payload.
 * @param upload Native file selection and upload.
 * @param signal Cancellation propagated to every remote request.
 * @returns Credential-free data or a validated one-based page.
 */
export async function invokeKnowledge(api: DeepSeekHarnessApiClient, method: string,
  input: Readonly<Record<string, unknown>>, upload?: KnowledgeUpload, signal?: AbortSignal): Promise<unknown> {
  const options = signal === undefined ? {} : { signal }
  if (method === 'knowledge.files.limits') {
    if (Object.keys(input).length > 0) invalid('file limits payload')
    return api.request('/api/v1/knowledge-file-limits', options)
  }
  if (method === 'knowledge.bases.create') {
    if (Object.keys(input).some(key => !['name', 'description', 'operationId'].includes(key))) invalid('personal library payload')
    const name = field(input, 'name', 120)
    const description = input.description === undefined ? '' : input.description
    if (typeof description !== 'string' || description.length > 1_000 || description.includes('\0')) invalid('description')
    return api.request('/api/v1/knowledge-bases', {
      ...options, method: 'POST', headers: writeHeaders(input),
      body: JSON.stringify({ name, description: description.trim(), scope: 'PERSONAL' }),
    })
  }
  if (method === 'knowledge.bases.delete') {
    if (Object.keys(input).some(key => key !== 'knowledgeBaseId')) invalid('personal library deletion payload')
    // The server computes ownership and authorization from the authenticated
    // employee. The product bridge never accepts an owner or scope claim.
    return api.requestNoContent(`/api/v1/knowledge-bases/${resource(input, 'knowledgeBaseId')}`, {
      ...options, method: 'DELETE',
    })
  }
  if (method === 'knowledge.sources.read') {
    return api.request(`/api/v1/knowledge-bases/sources/${resource(input, 'sourceId')}`, options)
  }
  const baseId = resource(input, 'knowledgeBaseId')
  const base = `/api/v1/knowledge-bases/${baseId}`
  const documents = `${base}/documents`
  if (method === 'knowledge.documents.upload.pending') {
    if (Object.keys(input).some(key => key !== 'knowledgeBaseId')) invalid('pending upload payload')
    return upload?.pending(decodeURIComponent(baseId)) ?? []
  }
  if (method === 'knowledge.folders.get') {
    if (Object.keys(input).some(key => !['knowledgeBaseId', 'folderId'].includes(key))) invalid('folder payload')
    return api.request(`${base}/folders/${resource(input, 'folderId')}`, options)
  }
  if (method === 'knowledge.documents.previewMetadata') {
    const documentId = knowledgePreviewIdentity(input).documentId
    return api.request(`${documents}/${encodeURIComponent(documentId)}/preview/metadata`, options)
  }
  if (method === 'knowledge.documents.list' || method === 'knowledge.documents.read' || method === 'knowledge.folders.list') {
    const page = integer(input.page ?? 1, 1, 1_000_000, 'page')
    const size = integer(input.size ?? 20, 1, 100, 'size')
    const params = new URLSearchParams()
    for (const key of ['query', 'format', 'status'] as const) {
      if (input[key] !== undefined) params.set(key, field(input, key, 200))
    }
    let path = method === 'knowledge.folders.list' ? `${base}/folders`
      : method === 'knowledge.documents.read' ? `${documents}/${resource(input, 'documentId')}/contents` : documents
    if (method === 'knowledge.documents.list' && input.folderId !== undefined) {
      params.set('folderId', input.folderId === null ? '' : decodedResource(input, 'folderId'))
    }
    if (method === 'knowledge.folders.list') {
      params.set('parentId', input.parentId == null ? '' : decodedResource(input, 'parentId'))
    }
    if (params.size > 0) path += `?${params.toString()}`
    const result = await api.list<unknown>(path, page, size, signal)
    return { items: result.data, page: result.pageIndex, size: result.pageSize, total: result.totalCount }
  }
  if (method === 'knowledge.documents.get') return api.request(`${documents}/${resource(input, 'documentId')}`, options)
  if (method === 'knowledge.documents.upload' || method === 'knowledge.documents.upload.select') {
    const allowed = method === 'knowledge.documents.upload' ? ['knowledgeBaseId', 'operationId', 'pdfParseMode', 'folderId'] : ['knowledgeBaseId', 'pdfParseMode', 'folderId']
    if (Object.keys(input).some(key => !allowed.includes(key))) invalid('upload payload')
    const pdfParseMode = input.pdfParseMode === undefined ? 'STANDARD' : input.pdfParseMode
    if (pdfParseMode !== 'STANDARD' && pdfParseMode !== 'TEXT') invalid('pdfParseMode')
    if (upload === undefined) throw new ProductError('KNOWLEDGE_UPLOAD_UNAVAILABLE', 'File selection is unavailable', false)
    const folderId = input.folderId === null || input.folderId === undefined ? input.folderId : decodedResource(input, 'folderId')
    if (method === 'knowledge.documents.upload.select') return upload.choose(decodeURIComponent(baseId), pdfParseMode, folderId, signal)
    return upload.send(decodeURIComponent(baseId), operation(input), pdfParseMode, folderId, api, signal)
  }
  if (method === 'knowledge.documents.upload.discard') {
    if (Object.keys(input).some(key => !['knowledgeBaseId', 'operationId'].includes(key))) invalid('upload discard payload')
    if (upload === undefined) throw new ProductError('KNOWLEDGE_UPLOAD_UNAVAILABLE', 'File selection is unavailable', false)
    upload.discard(decodeURIComponent(baseId), operation(input))
    return { discarded: true }
  }
  if (method === 'knowledge.documents.save') {
    const title = field(input, 'title', 255)
    const content = field(input, 'content', 1_000_000, false)
    if (new TextEncoder().encode(content).byteLength > 2 * 1024 * 1024) invalid('content')
    const updating = input.documentId !== undefined
    if (updating && input.folderId !== undefined) invalid('folderId for text update')
    const body = { title, content, ...(updating ? { expectedUpdatedAt: field(input, 'expectedUpdatedAt', 80) }
      : { folderId: input.folderId == null ? null : decodedResource(input, 'folderId') }) }
    return api.request(`${documents}/texts${updating ? `/${resource(input, 'documentId')}` : ''}`, {
      ...options, method: updating ? 'PUT' : 'POST', headers: writeHeaders(input), body: JSON.stringify(body),
    })
  }
  if (method === 'knowledge.documents.importUrl') {
    const url = new URL(field(input, 'url', 2_000))
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') invalid('url')
    const body = { url: url.href, folderId: input.folderId == null ? null : decodedResource(input, 'folderId'),
      ...(input.title === undefined ? {} : { title: field(input, 'title', 255) }) }
    return api.request(`${documents}/links`, { ...options, method: 'POST', headers: writeHeaders(input), body: JSON.stringify(body) })
  }
  if (method === 'knowledge.documents.reindex' || method === 'knowledge.documents.cancel') {
    if (Object.keys(input).some(key => !['knowledgeBaseId', 'documentId', 'operationId'].includes(key))) invalid('index job payload')
    return api.request(`${documents}/${resource(input, 'documentId')}/index-jobs`, {
      ...options, method: method === 'knowledge.documents.cancel' ? 'DELETE' : 'POST', headers: writeHeaders(input),
    })
  }
  if (method === 'knowledge.documents.delete') {
    return api.request(`${documents}/${resource(input, 'documentId')}`, { ...options, method: 'DELETE', headers: writeHeaders(input) })
  }
  if (method === 'knowledge.documents.move') {
    if (Object.keys(input).some(key => !['knowledgeBaseId', 'documentId', 'folderId', 'expectedFolderId', 'expectedUpdatedAt', 'operationId'].includes(key))) invalid('move payload')
    if (input.folderId !== null && input.folderId !== undefined) decodedResource(input, 'folderId')
    if (input.expectedFolderId !== null && input.expectedFolderId !== undefined) decodedResource(input, 'expectedFolderId')
    return api.request(`${documents}/${resource(input, 'documentId')}/location`, {
      ...options, method: 'PUT', headers: writeHeaders(input), body: JSON.stringify({ folderId: input.folderId ?? null,
        expectedFolderId: input.expectedFolderId ?? null, expectedUpdatedAt: field(input, 'expectedUpdatedAt', 80) }),
    })
  }
  if (method === 'knowledge.folders.create' || method === 'knowledge.folders.rename') {
    const updating = method === 'knowledge.folders.rename'
    return api.request(`${base}/folders${updating ? `/${resource(input, 'folderId')}` : ''}`, {
      ...options, method: updating ? 'PUT' : 'POST', headers: writeHeaders(input),
      body: JSON.stringify({ name: field(input, 'name', 80),
        ...(updating ? { expectedUpdatedAt: field(input, 'expectedUpdatedAt', 80) } : {}),
        ...(!updating ? { parentId: input.parentId == null ? null : decodedResource(input, 'parentId') } : {}),
      }),
    })
  }
  if (method === 'knowledge.folders.delete') {
    return api.request(`${base}/folders/${resource(input, 'folderId')}`, { ...options, method: 'DELETE' })
  }
  throw new ProductError('PRODUCT_METHOD_UNSUPPORTED', 'Unsupported knowledge operation', false)
}

/** Validate the IDs-only file preview request at the product IPC boundary.
 * @param input - Untrusted renderer or Host payload.
 * @returns Original resource identities.
 */
export function knowledgePreviewIdentity(input: Readonly<Record<string, unknown>>): { knowledgeBaseId: string; documentId: string } {
  if (Object.keys(input).some(key => !['knowledgeBaseId', 'documentId'].includes(key))) invalid('preview payload')
  return { knowledgeBaseId: decodedResource(input, 'knowledgeBaseId'), documentId: decodedResource(input, 'documentId') }
}

function invalid(fieldName: string): never {
  throw new ProductError('KNOWLEDGE_REQUEST_INVALID', `Invalid knowledge ${fieldName}`, false)
}
function decodedResource(input: Readonly<Record<string, unknown>>, key: string): string {
  const value = input[key]
  if (!isKnowledgeResourceId(value)) invalid(key)
  return value
}
function resource(input: Readonly<Record<string, unknown>>, key: string): string {
  return encodeURIComponent(decodedResource(input, key))
}
function field(input: Readonly<Record<string, unknown>>, key: string, max: number, trim = true): string {
  const raw = input[key]
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > max || raw.includes('\0')) invalid(key)
  return trim ? raw.trim() : raw
}
function integer(value: unknown, min: number, max: number, key: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(key)
  return value
}
function operation(input: Readonly<Record<string, unknown>>): string {
  const value = input.operationId
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/u.test(value)) invalid('operationId')
  return value
}
function writeHeaders(input: Readonly<Record<string, unknown>>): Record<string, string> {
  return { 'content-type': 'application/json', 'idempotency-key': operation(input) }
}
