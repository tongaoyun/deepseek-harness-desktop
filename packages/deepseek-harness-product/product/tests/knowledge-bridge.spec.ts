import { expect, it, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'
import { invokeKnowledge } from '../src/knowledge-bridge.ts'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { isProductRuntimeMethod } from '../src/protocol.ts'

const operationId = 'knowledge-operation-0001'

it('cancels document processing through an authenticated write without exposing it to the model', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { id: 'doc', status: 'CANCELLED' } }))
  const api = client(transport)
  const controller = new AbortController()
  try {
    const input = { knowledgeBaseId: 'base', documentId: 'doc', operationId }
    await expect(invokeKnowledge(api, 'knowledge.documents.cancel', input, undefined, controller.signal)).resolves.toMatchObject({ status: 'CANCELLED' })
    const call = transport.mock.calls[0]!
    expect(requestUrl(call[0])).toBe('https://product.test/api/v1/knowledge-bases/base/documents/doc/index-jobs')
    expect(call[1]?.method).toBe('DELETE')
    expect(new Headers(call[1]?.headers).get('idempotency-key')).toBe(operationId)
    expect(new Headers(call[1]?.headers).get('x-deepseek-harness-employee-id')).toBe('employee')
    expect(call[1]?.signal).toBeDefined()
    expect(isProductRuntimeMethod('knowledge.documents.cancel')).toBe(false)
    await expect(invokeKnowledge(api, 'knowledge.documents.cancel', { ...input, employeeId: 'other' })).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    await expect(invokeKnowledge(api, 'knowledge.documents.cancel', { ...input, operationId: '' })).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(transport).toHaveBeenCalledOnce()
  } finally { api.close() }
})

it('reads one folder by identity with cancellation and rejects forged ownership or paths', async () => {
  const signal = new AbortController().signal
  const transport = vi.fn<typeof fetch>(async (input) => {
    expect(requestUrl(input)).toBe('https://product.test/api/v1/knowledge-bases/base/folders/folder')
    return Response.json({ success: true, data: { id: 'folder', name: '目录', parentId: null } })
  })
  const api = client(transport)
  try {
    await expect(invokeKnowledge(api, 'knowledge.folders.get', { knowledgeBaseId: 'base', folderId: 'folder' }, undefined, signal))
      .resolves.toMatchObject({ id: 'folder' })
    expect(transport.mock.calls[0]?.[1]?.signal).toBeDefined()
    for (const input of [{ knowledgeBaseId: 'base', folderId: '../other' },
      { knowledgeBaseId: 'base', folderId: 'folder', employeeId: 'other' }]) {
      await expect(invokeKnowledge(api, 'knowledge.folders.get', input)).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    }
    expect(transport).toHaveBeenCalledOnce()
  } finally { api.close() }
})
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

it('creates nested folders with a stable retry key and an explicit parent without changing paths on rename', async () => {
  const parentId = '00000000-0000-0000-0000-000000000001'
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { id: 'folder', name: '资料', parentId } }))
  const api = client(transport)
  try {
    const input = { knowledgeBaseId: 'base', name: ' 资料 ', parentId, operationId }
    await invokeKnowledge(api, 'knowledge.folders.create', input)
    await invokeKnowledge(api, 'knowledge.folders.create', input)
    const init = transport.mock.calls[0]?.[1]
    expect(init?.body).toBe(JSON.stringify({ name: '资料', parentId }))
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(operationId)
    expect(transport.mock.calls[1]?.[1]?.body).toBe(init?.body)
    await invokeKnowledge(api, 'knowledge.folders.rename', { ...input, folderId: 'folder', name: '名称' })
    expect(transport.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ name: '名称' }))
    await expect(invokeKnowledge(api, 'knowledge.folders.create', { ...input, parentId: '../other' })).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    await expect(invokeKnowledge(api, 'knowledge.folders.create', { ...input, name: 'x'.repeat(81) })).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(transport).toHaveBeenCalledTimes(3)
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

it('queries only the explicit folder parent page without fetching the complete directory', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: [], pageIndex: 2,
    pageSize: 20, totalCount: 25, totalPages: 2 }))
  const api = client(transport)
  try {
    await invokeKnowledge(api, 'knowledge.folders.list', { knowledgeBaseId: 'base', parentId: 'parent', page: 2, size: 20 })
    const url = new URL(requestUrl(transport.mock.calls[0]![0]))
    expect(Object.fromEntries(url.searchParams)).toEqual({ parentId: 'parent', page: '2', size: '20' })
    expect(transport).toHaveBeenCalledOnce()
    await expect(invokeKnowledge(api, 'knowledge.folders.list', { knowledgeBaseId: 'base', parentId: '../other' }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(transport).toHaveBeenCalledOnce()
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

it.each(['knowledge.documents.save', 'knowledge.documents.importUrl'] as const)('forwards the selected creation folder for %s with stable retries', async (method) => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: { id: 'document', folderId: 'folder' } }))
  const api = client(transport)
  try {
    const input = method === 'knowledge.documents.save'
      ? { knowledgeBaseId: 'base', title: 'Policy', content: '# Notes', operationId, folderId: 'folder' }
      : { knowledgeBaseId: 'base', url: 'https://example.test', title: 'Policy', operationId, folderId: 'folder' }
    await invokeKnowledge(api, method, input)
    await invokeKnowledge(api, method, input)
    const init = transport.mock.calls[0]?.[1]
    if (typeof init?.body !== 'string') throw new Error('Creation request body is missing')
    expect(init.body).toContain('"folderId":"folder"')
    expect(init.body).toContain('"title":"Policy"')
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(operationId)
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
  const send = vi.fn(async () => ({ cancelled: true }))
  const upload = { send, discard: vi.fn() }
  try {
    await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId }, upload))
      .resolves.toEqual({ cancelled: true })
    await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, path: '/private/file' }, upload))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('base', operationId, 'STANDARD', undefined, api, undefined)
    await invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, pdfParseMode: 'TEXT' }, upload)
    expect(send).toHaveBeenLastCalledWith('base', operationId, 'TEXT', undefined, api, undefined)
    for (const pdfParseMode of ['markitdown', '', null, { engine: 'markitdown' }]) {
      await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, pdfParseMode }, upload))
        .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    }
    await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId,
      pdfParseMode: 'TEXT', engine: 'markitdown' }, upload)).rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(send).toHaveBeenCalledTimes(2)
    await invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, folderId: 'folder-1' }, upload)
    expect(send).toHaveBeenLastCalledWith('base', operationId, 'STANDARD', 'folder-1', api, undefined)
    await invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, folderId: null }, upload)
    expect(send).toHaveBeenLastCalledWith('base', operationId, 'STANDARD', null, api, undefined)
    await expect(invokeKnowledge(api, 'knowledge.documents.upload', { knowledgeBaseId: 'base', operationId, folderId: '../other' }, upload))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
    expect(send).toHaveBeenCalledTimes(4)
    await invokeKnowledge(api, 'knowledge.documents.upload.discard', { knowledgeBaseId: 'base', operationId }, upload)
    expect(upload.discard).toHaveBeenCalledExactlyOnceWith('base', operationId)
    await expect(invokeKnowledge(api, 'knowledge.documents.upload.discard', { knowledgeBaseId: 'base', operationId, path: '/private/file' }, upload))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_REQUEST_INVALID' })
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
  ['knowledge.documents.save', { knowledgeBaseId: 'base', title: 'Policy', content: 'text', operationId, folderId: '../other' }],
  ['knowledge.documents.save', { knowledgeBaseId: 'base', documentId: 'document', title: 'Policy', content: 'text', operationId, folderId: 'folder' }],
  ['knowledge.documents.importUrl', { knowledgeBaseId: 'base', url: 'https://example.test', operationId, folderId: '../other' }],
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
