// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeDocumentReader } from '../src/client/KnowledgeDocumentReader.tsx'
import { readKnowledgeFile } from '../src/client/knowledge-data.ts'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
import { createPreviewFixture, originalMetadata, originalPreview, renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const props = { knowledgeBaseId: 'policy', documentId: 'doc-1', title: '业务规范.md', inline: true,
  renderFactorySlot: renderKnowledgePreview, onClose: vi.fn(), t }

function transport(handler: (method: string, payload: unknown) => Promise<unknown>, filename = '业务规范.md', sourceType = 'file') {
  const preview = createPreviewFixture()
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown, _requestId?: string) =>
    ({ ok: true, result: method === 'knowledge.documents.previewMetadata' ? originalMetadata('policy', 'doc-1', filename, sourceType)
      : await preview(method, payload, handler) }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('sends original bytes to the official preview factory without reading indexed passages', async () => {
  const api = transport(async () => originalPreview('# 原文件\n\n不依赖索引的正文'))
  const view = render(<KnowledgeDocumentReader {...props} />)
  await screen.findByRole('heading', { name: '原文件' })
  expect(view.container.querySelector('[data-original-preview="业务规范.md"]')).not.toBeNull()
  expect(view.container.querySelector('[data-knowledge-inline-reader]')).not.toBeNull()
  expect(screen.queryByText(zh.knowledgeExtractedContent)).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.close })).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: 'policy', documentId: 'doc-1',
  }, expect.any(String), 300_000)
})

it('passes Office conversion to the native factory without downloading raw Office bytes first', async () => {
  const api = transport(async () => originalPreview('官方转换的 PDF', 'application/pdf'), '业务规范.docx')
  render(<KnowledgeDocumentReader {...props} title="业务规范.docx" />)
  await screen.findByText('官方转换的 PDF')
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: 'policy', documentId: 'doc-1', rendered: true,
  }, expect.any(String), 300_000)
})

it('reads a retrieval passage and opens its original file through a separate permission check', async () => {
  const api = transport(async method => method === 'knowledge.sources.read'
    ? { documentId: 'doc-1', filename: '原文.md', content: '检索引用', locator: '第 2 页' }
    : originalPreview('原文件完整正文'))
  render(<KnowledgeDocumentReader knowledgeBaseId="policy" sourceId="source-1" title="业务规范.md" inline
    renderFactorySlot={renderKnowledgePreview} onClose={vi.fn()} t={t} />)
  await screen.findByText('检索引用')
  expect(screen.getByText(zh.knowledgeExtractedContent)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
  await screen.findByText('原文件完整正文')
  expect(screen.queryByText('检索引用')).toBeNull()
  expect(screen.queryByText(zh.knowledgeExtractedContent)).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.sources.read', { sourceId: 'source-1' }, expect.any(String))
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: 'policy', documentId: 'doc-1',
  }, expect.any(String), 300_000)
  expect(screen.queryByRole('button', { name: zh.knowledgeReadFullDocument })).toBeNull()
})

it('explains when an authorized source has no readable content', async () => {
  const api = transport(async method => method === 'knowledge.sources.read'
    ? { documentId: 'doc-1', filename: '原文.md', content: '   ', locator: '第 2 页' }
    : originalPreview('原文件完整正文'))
  render(<KnowledgeDocumentReader knowledgeBaseId="policy" sourceId="source-1" title="业务规范.md" inline
    renderFactorySlot={renderKnowledgePreview} onClose={vi.fn()} t={t} />)
  expect(await screen.findByText(zh.knowledgeNoContent)).toBeDefined()
  expect(screen.getByText('第 2 页')).toBeDefined()
  expect(screen.queryByText('   ')).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.sources.read', { sourceId: 'source-1' }, expect.any(String))
})

it('cancels the original-file request when its workspace closes the reader', async () => {
  let resolve!: (value: unknown) => void
  const api = transport(async () => new Promise((done) => { resolve = done }))
  const view = render(<KnowledgeDocumentReader {...props} />)
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledTimes(2) })
  const requestId = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')?.[3]
  view.unmount()
  expect(api.cancel).toHaveBeenCalledWith('product', requestId)
  await act(async () => { resolve(originalPreview('已取消的正文')) })
  expect(screen.queryByText('已取消的正文')).toBeNull()
})

it.each(['KNOWLEDGE_ACCESS_REVOKED', 'KNOWLEDGE_ACCESS_DENIED', 'ORGANIZATION_EMPLOYEE_INACTIVE', 'ORGANIZATION_EMPLOYEE_UNMAPPED'])(
  'clears the original preview after explicit %s and localizes its diagnostic', async (code) => {
    let reads = 0
    const denied = vi.fn()
    const api = transport(async () => {
      reads += 1
      if (reads > 1) throw new ProductError(code, 'Private upstream details', false)
      return originalPreview('原文件正文')
    })
    const view = render(<KnowledgeDocumentReader {...props} onAccessDenied={denied} refreshRevision={0} />)
    await screen.findByText('原文件正文')
    view.rerender(<KnowledgeDocumentReader {...props} onAccessDenied={denied} refreshRevision={1} />)
    expect((await screen.findByRole('alert')).textContent).toContain(code)
    expect(screen.queryByText('原文件正文')).toBeNull()
    expect(screen.queryByText('Private upstream details')).toBeNull()
    expect(denied).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code }))
    expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.documents.read')).toHaveLength(0)
  })

it('rechecks original-file access on refresh and retries a network failure without treating it as revocation', async () => {
  let reads = 0
  const denied = vi.fn()
  transport(async () => {
    reads += 1
    if (reads === 2) throw new Error('Network offline')
    return originalPreview(reads === 1 ? '原文件正文' : '重试成功')
  })
  const view = render(<KnowledgeDocumentReader {...props} onAccessDenied={denied} refreshRevision={0} />)
  await screen.findByText('原文件正文')
  view.rerender(<KnowledgeDocumentReader {...props} onAccessDenied={denied} refreshRevision={1} />)
  expect((await screen.findByRole('alert')).textContent).toBe(zh.knowledgePreviewFailed)
  expect(screen.queryByText('原文件正文')).toBeNull()
  expect(denied).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByText('重试成功')
})

it.each(['KNOWLEDGE_PREVIEW_UNAVAILABLE', 'KNOWLEDGE_PREVIEW_TOO_LARGE', 'KNOWLEDGE_SERVICE_UNAVAILABLE'])(
  'reports original preview failure %s without falling back to WeKnora chunks', async (code) => {
    const api = transport(async () => { throw new ProductError(code, 'Private source URL', false) })
    render(<KnowledgeDocumentReader {...props} />)
    expect((await screen.findByRole('alert')).textContent).toContain(code)
    expect(screen.queryByText('Private source URL')).toBeNull()
    expect(api.invoke.mock.calls.map(row => row[1])).toEqual(['knowledge.documents.previewMetadata', 'knowledge.documents.preview.open'])
  })

it.each([
  ['KNOWLEDGE_TRANSFER_BUSY', zh.knowledgePreviewBusy],
  ['KNOWLEDGE_DOCUMENT_CHANGED', zh.knowledgePreviewSourceChanged],
])('shows an actionable original-file diagnostic for %s and retries without clearing library access', async (code, message) => {
  let reads = 0
  const denied = vi.fn()
  const api = transport(async () => {
    reads += 1
    if (reads === 1) throw new ProductError(code, 'Private source URL', code === 'KNOWLEDGE_TRANSFER_BUSY')
    return originalPreview('重试成功')
  })
  render(<KnowledgeDocumentReader {...props} onAccessDenied={denied} />)
  expect((await screen.findByRole('alert')).textContent).toBe(`${message} (${code})`)
  expect(screen.queryByText('Private source URL')).toBeNull()
  expect(denied).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByText('重试成功')
  expect(denied).not.toHaveBeenCalled()
  expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.read')).toBe(false)
})

it('uses original Markdown for an online document whose display name has an Office suffix', async () => {
  const api = transport(async () => originalPreview('# 手写正文'), '部门预算.docx', 'manual')
  const { container } = render(<KnowledgeDocumentReader {...props} title="部门预算.docx" />)
  await screen.findByRole('heading', { name: '手写正文' })
  expect(container.querySelector('[data-original-preview="部门预算.docx.md"]')).not.toBeNull()
  expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.renderOffice')).toBe(false)
})

it('cancels a pending metadata check before fetching any original bytes', async () => {
  let complete!: (value: unknown) => void
  const invoke = vi.fn(async (_namespace: string, _method: string, _payload: unknown, _requestId?: string) =>
    ({ ok: true, result: await new Promise((resolve) => { complete = resolve }) }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const view = render(<KnowledgeDocumentReader {...props} />)
  await waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })
  expect(invoke.mock.calls[0]?.[1]).toBe('knowledge.documents.previewMetadata')
  view.unmount()
  expect(cancel).toHaveBeenCalledWith('product', invoke.mock.calls[0]?.[3])
  await act(async () => { complete(originalMetadata('policy', 'doc-1')) })
  expect(invoke).toHaveBeenCalledOnce()
})

it('denies a revoked metadata check before mounting a renderer or requesting file bytes', async () => {
  const denied = vi.fn()
  const invoke = vi.fn(async () => { throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Private metadata details', false) })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = render(<KnowledgeDocumentReader {...props} onAccessDenied={denied} />)
  expect((await screen.findByRole('alert')).textContent).toContain('KNOWLEDGE_ACCESS_REVOKED')
  expect(screen.queryByText('Private metadata details')).toBeNull()
  expect(view.container.querySelector('[data-original-preview]')).toBeNull()
  expect(invoke).toHaveBeenCalledOnce()
  expect(denied).toHaveBeenCalledOnce()
})

it('preserves binary byte values across chunks and closes the transfer after completion', async () => {
  const request = vi.fn(async (method: string, payload: unknown) => {
    if (method.endsWith('.open')) return { transferId: 'binary', mediaType: 'application/pdf', byteLength: 3, maxBytes: 50, chunkSize: 2 }
    if (method.endsWith('.read')) return typeof payload === 'object' && payload !== null && 'offset' in payload && payload.offset === 0
      ? { data: new Uint8Array([0, 255]), offset: 0, eof: false } : { data: new Uint8Array([65]), offset: 2, eof: true }
    return { closed: true }
  })
  const file = await readKnowledgeFile(request, { knowledgeBaseId: 'policy', documentId: 'doc-1' }, new AbortController().signal)
  expect([...file.data]).toEqual([0, 255, 65])
  expect(request.mock.calls.map(row => row[0])).toEqual(['knowledge.documents.preview.open', 'knowledge.documents.preview.read',
    'knowledge.documents.preview.read', 'knowledge.documents.preview.close'])
})

it('releases an oversized file before requesting or allocating its bytes', async () => {
  const request = vi.fn(async () => ({ transferId: 'oversized', mediaType: 'application/pdf', byteLength: 51, maxBytes: 50, chunkSize: 2 }))
  await expect(readKnowledgeFile(request, { knowledgeBaseId: 'policy', documentId: 'doc-1' }, new AbortController().signal)).rejects.toThrow()
  expect(request.mock.calls).toHaveLength(2)
  expect(request).toHaveBeenLastCalledWith('knowledge.documents.preview.close', { transferId: 'oversized' })
})

it('closes a transfer when cancellation arrives with a completed open request', async () => {
  const controller = new AbortController()
  const request = vi.fn(async (method: string) => {
    if (method.endsWith('.open')) controller.abort()
    return { transferId: 'cancelled', mediaType: 'application/pdf', byteLength: 3, maxBytes: 50, chunkSize: 2 }
  })
  await expect(readKnowledgeFile(request, { knowledgeBaseId: 'policy', documentId: 'doc-1' }, controller.signal)).rejects.toThrow()
  expect(request.mock.calls.map(row => row[0])).toEqual(['knowledge.documents.preview.open', 'knowledge.documents.preview.close'])
})

it.each([
  { data: new Uint8Array([1]), offset: 2, eof: false },
  { data: new Uint8Array([]), offset: 0, eof: false },
  { data: new Uint8Array([1, 2]), offset: 0, eof: false },
])('rejects malformed chunk progress and closes the transfer', async (chunk) => {
  const request = vi.fn(async (method: string) => method.endsWith('.open')
    ? { transferId: 'malformed', mediaType: 'application/pdf', byteLength: 2, maxBytes: 50, chunkSize: 2 } : chunk)
  await expect(readKnowledgeFile(request, { knowledgeBaseId: 'policy', documentId: 'doc-1' }, new AbortController().signal)).rejects.toThrow()
  expect(request).toHaveBeenLastCalledWith('knowledge.documents.preview.close', { transferId: 'malformed' })
})

it('preserves access revocation when closing the failed preview also fails', async () => {
  const readError = new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Permission changed', false)
  const closeError = new Error('close transport disconnected')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const request = vi.fn(async (method: string) => {
    if (method.endsWith('.open')) return { transferId: 'revoked', mediaType: 'text/plain', byteLength: 1, maxBytes: 50, chunkSize: 2 }
    if (method.endsWith('.read')) throw readError
    throw closeError
  })
  try {
    await expect(readKnowledgeFile(request, { knowledgeBaseId: 'policy', documentId: 'doc-1' }, new AbortController().signal))
      .rejects.toBe(readError)
    await waitFor(() => { expect(warning).toHaveBeenCalledWith('Knowledge preview cleanup failed', closeError) })
    expect(request).toHaveBeenLastCalledWith('knowledge.documents.preview.close', { transferId: 'revoked' })
  } finally { warning.mockRestore() }
})

it('does not delay reader cancellation behind a stalled close request', async () => {
  const closing = Promise.withResolvers<unknown>()
  const controller = new AbortController()
  const reason = new Error('Reader closed')
  const request = vi.fn(async (method: string) => {
    if (method.endsWith('.open')) {
      controller.abort(reason)
      return { transferId: 'cancelled', mediaType: 'text/plain', byteLength: 1, maxBytes: 50, chunkSize: 2 }
    }
    return closing.promise
  })
  let error: unknown
  const result = readKnowledgeFile(request, { knowledgeBaseId: 'policy', documentId: 'doc-1' }, controller.signal)
    .catch((failure: unknown) => { error = failure })
  try {
    await waitFor(() => { expect(error).toBe(reason) }, { timeout: 200 })
    expect(request.mock.calls.map(row => row[0])).toEqual(['knowledge.documents.preview.open', 'knowledge.documents.preview.close'])
  } finally {
    closing.resolve({ closed: true })
    await result
  }
})

it('does not report preview success when normal transfer cleanup fails', async () => {
  const error = new Error('cleanup failed')
  const request = vi.fn(async (method: string) => {
    if (method.endsWith('.open')) return { transferId: 'empty', mediaType: 'text/plain', byteLength: 0, maxBytes: 50, chunkSize: 2 }
    throw error
  })
  await expect(readKnowledgeFile(request, { knowledgeBaseId: 'policy', documentId: 'doc-1' }, new AbortController().signal))
    .rejects.toBe(error)
})

it('reports revoked access to the owning view even if failed-preview cleanup disconnects', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const denied = vi.fn()
  const readError = new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Private permission details', false)
  const closeError = new Error('cleanup disconnected')
  let revoked = false
  const bytes = Uint8Array.from(new TextEncoder().encode('原来的预览内容'))
  const invoke = vi.fn(async (_namespace: string, method: string) => {
    if (method.endsWith('.previewMetadata')) return { ok: true, result: originalMetadata('policy', 'doc-1') }
    if (method.endsWith('.open')) return { ok: true, result: {
      transferId: 'reader-transfer', mediaType: 'text/plain', byteLength: bytes.byteLength, maxBytes: 100, chunkSize: 100,
    } }
    if (method.endsWith('.read')) {
      if (revoked) throw readError
      return { ok: true, result: { data: bytes, offset: 0, eof: true } }
    }
    if (revoked) throw closeError
    return { ok: true, result: { closed: true } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  try {
    const view = render(<KnowledgeDocumentReader {...props} onAccessDenied={denied} refreshRevision={0} />)
    await screen.findByText('原来的预览内容')
    revoked = true
    view.rerender(<KnowledgeDocumentReader {...props} onAccessDenied={denied} refreshRevision={1} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('KNOWLEDGE_ACCESS_REVOKED')
    expect(alert.textContent).toMatchInlineSnapshot('"所选知识库已失去访问权限，请刷新并重新选择。 (KNOWLEDGE_ACCESS_REVOKED)"')
    expect(denied).toHaveBeenCalledExactlyOnceWith(readError)
    expect(screen.queryByText('原来的预览内容')).toBeNull()
    expect(screen.queryByText('Private permission details')).toBeNull()
    expect(warning).toHaveBeenCalledWith('Knowledge preview cleanup failed', closeError)
  } finally { warning.mockRestore() }
})

it('does not deliver completed bytes after cancellation during the close acknowledgement', async () => {
  const closing = Promise.withResolvers<unknown>()
  const controller = new AbortController()
  const reason = new Error('Reader changed')
  const request = vi.fn(async (method: string) => {
    if (method.endsWith('.open')) return { transferId: 'empty', mediaType: 'text/plain', byteLength: 0, maxBytes: 50, chunkSize: 2 }
    return closing.promise
  })
  const result = readKnowledgeFile(request, { knowledgeBaseId: 'policy', documentId: 'doc-1' }, controller.signal)
    .catch((failure: unknown) => failure)
  await waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
  controller.abort(reason)
  closing.resolve({ closed: true })
  expect(await result).toBe(reason)
})
