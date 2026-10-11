import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'
import { invokeKnowledge } from '../src/knowledge-bridge.ts'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'

const operationId = 'knowledge-operation-0001'
function client(transport: typeof fetch) {
  return new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'main-only-token',
    getEmployeeId: () => 'employee', fetch: transport })
}
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}
function cancelled(signal?: AbortSignal | null): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : new Error('Cancelled request')
}

it('creates a personal library from the authenticated identity with a stable retry key', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { id: 'mine', scope: 'PERSONAL', canManage: true } }))
  const api = client(transport)
  try {
    const input = { name: ' My files ', description: ' Notes ', operationId }
    await invokeKnowledge(api, 'knowledge.bases.create', input)
    await invokeKnowledge(api, 'knowledge.bases.create', input)
    const init = transport.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(operationId)
    expect(new Headers(init?.headers).get('x-deepseek-harness-employee-id')).toBe('employee')
    expect(init?.body).toBe(JSON.stringify({ name: 'My files', description: 'Notes', scope: 'PERSONAL' }))
    expect(transport.mock.calls[1]?.[1]?.body).toBe(init?.body)
    for (const forged of [{ scope: 'COMPANY' }, { ownerEmployeeId: 'other' }, { departmentId: 'other' }, { referenceKey: 'shared' }]) {
      await expect(invokeKnowledge(api, 'knowledge.bases.create', { ...input, ...forged }))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    }
    expect(transport).toHaveBeenCalledTimes(2)
  } finally { api.close() }
})

it('deletes a personal library through the server-owned 204 endpoint', async () => {
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    expect(requestUrl(input)).toBe('https://product.test/api/v1/knowledge-bases/mine')
    expect(init?.method).toBe('DELETE')
    return new Response(null, { status: 204 })
  })
  const api = client(transport)
  try {
    await expect(invokeKnowledge(api, 'knowledge.bases.delete', { knowledgeBaseId: 'mine' })).resolves.toBeUndefined()
    await expect(invokeKnowledge(api, 'knowledge.bases.delete', { knowledgeBaseId: 'mine', ownerEmployeeId: 'other' }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(transport).toHaveBeenCalledTimes(1)
  } finally { api.close() }
})

it('reads server-owned file limits without allowing renderer overrides', async () => {
  const limits = { previewMaxBytes: 50_000_000, downloadMaxBytes: 250_000_000, uploadMaxBytes: 50_000_000 }
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: limits }))
  const api = client(transport)
  try {
    await expect(invokeKnowledge(api, 'knowledge.files.limits', {})).resolves.toEqual(limits)
    const call = transport.mock.calls[0]
    if (!call) throw new Error('Limits request missing')
    expect(requestUrl(call[0])).toBe('https://product.test/api/v1/knowledge-file-limits')
    await expect(invokeKnowledge(api, 'knowledge.files.limits', { uploadMaxBytes: 1_000_000_000 }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(transport).toHaveBeenCalledTimes(1)
  } finally { api.close() }
})

it('preserves filtered one-based paging metadata through the product bridge', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: [{ id: 'document' }],
    pageIndex: 3, pageSize: 20, totalCount: 101, totalPages: 6 }))
  const api = client(transport)
  try {
    expect(await invokeKnowledge(api, 'knowledge.documents.list', {
      knowledgeBaseId: 'base', page: 3, size: 20, folderId: 'folder', query: 'policy', format: 'pdf', status: 'READY',
    })).toEqual({ items: [{ id: 'document' }], page: 3, size: 20, total: 101 })
    const input = transport.mock.calls[0]?.[0]
    if (input === undefined) throw new Error('Request missing')
    const url = new URL(requestUrl(input))
    expect(url.pathname).toBe('/api/v1/knowledge-bases/base/documents')
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: 'policy', format: 'pdf', status: 'READY', folderId: 'folder', page: '3', size: '20' })
  } finally { api.close() }
})

it('retains the retry key and optimistic update timestamp without trusting an owner claim', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { id: 'document', status: 'QUEUED' } }))
  const api = client(transport)
  try {
    const payload = { knowledgeBaseId: 'base', documentId: 'document', title: 'Policy', content: '# Policy',
      expectedUpdatedAt: '2026-10-10T00:00:00Z', operationId, employeeId: 'forged' }
    await invokeKnowledge(api, 'knowledge.documents.save', payload)
    await invokeKnowledge(api, 'knowledge.documents.save', payload)
    const init = transport.mock.calls[0]?.[1]
    expect(init?.method).toBe('PUT')
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(operationId)
    expect(new Headers(init?.headers).get('x-deepseek-harness-employee-id')).toBe('employee')
    if (typeof init?.body !== 'string') throw new Error('JSON body missing')
    expect(JSON.parse(init.body)).toEqual({ title: 'Policy', content: '# Policy', expectedUpdatedAt: payload.expectedUpdatedAt })
    expect(transport.mock.calls[1]?.[1]?.body).toBe(init?.body)
  } finally { api.close() }
})

it('returns asynchronous deletion state instead of treating it as completion', async () => {
  const api = client(async () => Response.json({ success: true, data: { taskId: 'delete-1', status: 'DELETING' } }))
  try {
    await expect(invokeKnowledge(api, 'knowledge.documents.delete', { knowledgeBaseId: 'base', documentId: 'document', operationId }))
      .resolves.toEqual({ taskId: 'delete-1', status: 'DELETING' })
  } finally { api.close() }
})

it('only lets the main-owned picker supply an upload file', async () => {
  const api = client(async () => { throw new Error('Unexpected HTTP') })
  const upload = vi.fn(async () => ({ cancelled: true }))
  try {
    await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId }, upload))
      .resolves.toEqual({ cancelled: true })
    await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, path: '/private/file' }, upload))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledWith('base', operationId, 'STANDARD', undefined, api, undefined)
    await invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, pdfParseMode: 'TEXT' }, upload)
    expect(upload).toHaveBeenLastCalledWith('base', operationId, 'TEXT', undefined, api, undefined)
    for (const pdfParseMode of ['markitdown', '', null, { engine: 'markitdown' }]) {
      await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, pdfParseMode }, upload))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    }
    await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId,
      pdfParseMode: 'TEXT', engine: 'markitdown' }, upload)).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(upload).toHaveBeenCalledTimes(2)
    await invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, folderId: 'folder-1' }, upload)
    expect(upload).toHaveBeenLastCalledWith('base', operationId, 'STANDARD', 'folder-1', api, undefined)
    await invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, folderId: null }, upload)
    expect(upload).toHaveBeenLastCalledWith('base', operationId, 'STANDARD', null, api, undefined)
    await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, folderId: '../other' }, upload))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(upload).toHaveBeenCalledTimes(4)
  } finally { api.close() }
})

it.each([
  ['knowledge.documents.list', { knowledgeBaseId: '../private' }],
  ['knowledge.documents.list', { knowledgeBaseId: 'base', page: -1 }],
  ['knowledge.documents.list', { knowledgeBaseId: 'base', page: 0 }],
  ['knowledge.bases.create', { name: 'Private files' }],
  ['knowledge.bases.create', { name: '', operationId }],
  ['knowledge.bases.create', { name: 'Private files', description: 42, operationId }],
  ['knowledge.documents.save', { knowledgeBaseId: 'base', title: 'Policy', content: 'text' }],
  ['knowledge.documents.save', { knowledgeBaseId: 'base', title: 'Policy', content: 'text', operationId, folderId: 'folder' }],
  ['knowledge.documents.importUrl', { knowledgeBaseId: 'base', url: 'https://example.test', operationId, folderId: 'folder' }],
  ['knowledge.documents.importUrl', { knowledgeBaseId: 'base', url: 'https://employee:secret@example.test', operationId }],
] as const)('rejects invalid %s inputs before HTTP', async (method, input) => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: [] }))
  const api = client(transport)
  try {
    await expect(invokeKnowledge(api, method, input)).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(transport).not.toHaveBeenCalled()
  } finally { api.close() }
})

it('propagates cancellation through an in-flight document request', async () => {
  let remoteSignal: AbortSignal | null | undefined
  const api = client(async (_input, init) => {
    remoteSignal = init?.signal
    return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(cancelled(init.signal)) }, { once: true }) })
  })
  const controller = new AbortController()
  try {
    const request = invokeKnowledge(api, 'knowledge.documents.read', { knowledgeBaseId: 'base', documentId: 'document' }, undefined, controller.signal)
    const rejected = expect(request).rejects.toThrow('Closed detail')
    await vi.waitFor(() => { expect(remoteSignal).toBeDefined() })
    controller.abort(new Error('Closed detail'))
    await rejected
  } finally { api.close() }
})

it('cancels employee knowledge requests when the authenticated identity changes', async () => {
  let remoteSignal: AbortSignal | null | undefined
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.test', sessionToken: 'employee-a-token',
    initialSession: { authenticated: true, employeeId: 'employee-a' }, fetch: async (input, init) => {
      if (!requestUrl(input).endsWith('/documents/document')) return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
      remoteSignal = init?.signal
      return new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(cancelled(init.signal)) }, { once: true }) })
    } })
  try {
    const request = bridge.invoke('knowledge.documents.get', { knowledgeBaseId: 'base', documentId: 'document' })
    const rejected = expect(request).rejects.toThrow('Product employee identity changed')
    await vi.waitFor(() => { expect(remoteSignal).toBeDefined() })
    bridge.setSession({ authenticated: true, employeeId: 'employee-b' }, 'employee-b-token')
    await rejected
    expect(remoteSignal?.aborted).toBe(true)
  } finally { await bridge.dispose() }
})
