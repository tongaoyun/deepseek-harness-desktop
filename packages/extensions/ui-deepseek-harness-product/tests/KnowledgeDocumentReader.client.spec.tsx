// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeDocumentReader } from '../src/client/KnowledgeDocumentReader.tsx'
import { readKnowledgeFile } from '../src/client/knowledge-data.ts'
import { en, zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
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

it.each(['download', 'openExternal'] as const)('retains a failed %s action while retrying and locks both file actions before rendering', async (action) => {
  vi.stubGlobal('location', new URL('dsh-app://app/'))
  const response = Promise.withResolvers<unknown>()
  let writes = 0
  const method = `knowledge.documents.${action}`
  const api = transport(async (requested) => {
    if (requested !== method) return originalPreview('原文件正文')
    if (++writes === 1) throw new Error('Offline')
    return response.promise
  })
  const view = render(<KnowledgeDocumentReader {...props} inline={false} />)
  onTestFinished(() => { view.unmount(); response.resolve(undefined) })
  const button = await screen.findByRole<HTMLButtonElement>('button', { name: action === 'download' ? zh.knowledgeDownloadOriginal : zh.knowledgeOpenExternal })
  button.focus()
  fireEvent.click(button)
  const notice = await screen.findByRole('alert')
  const other = screen.getByRole<HTMLButtonElement>('button', { name: action === 'download' ? zh.knowledgeOpenExternal : zh.knowledgeDownloadOriginal })
  act(() => { button.click(); button.click(); other.click() })
  expect(writes).toBe(2)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.download' || call[1] === 'knowledge.documents.openExternal')).toHaveLength(2)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect(other.getAttribute('aria-busy')).toBe('false')
  expect(button.classList.contains('product-control-pending')).toBe(true)
  expect(button.disabled).toBe(false)
  expect(other.disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(other.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(button)
  expect({ error: notice.textContent, action: button.textContent, focused: document.activeElement?.textContent }).toMatchSnapshot()
  await act(async () => { response.resolve(undefined) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(button.disabled).toBe(false)
  expect(other.disabled).toBe(false)
  expect(document.activeElement).toBe(button)
})

it.each([true, false])('retains the original-file authorization retry and hands its focus to the reader when ready (inline: %s)', async (inline) => {
  const response = Promise.withResolvers<unknown>()
  const invoke = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockImplementation(async () => ({ ok: true, result: await response.promise }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const preview = vi.fn(() => null)
  const view = render(<KnowledgeDocumentReader {...props} inline={inline} renderFactorySlot={preview} />)
  onTestFinished(() => { view.unmount(); response.resolve(originalMetadata('policy', 'doc-1')) })
  const notice = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(preview).not.toHaveBeenCalled()
  fireEvent.click(retry)
  expect(invoke).toHaveBeenCalledTimes(2)
  await act(async () => { response.resolve(originalMetadata('policy', 'doc-1')) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(preview).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(screen.getByRole('region', { name: zh.knowledgeReadDocument }))
})

it.each([true, false])('retains a source read retry and hands its focus to the reader when confirmed (inline: %s)', async (inline) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const source = { knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1', filename: '原文.md', content: '恢复的引用正文', locator: '' }
  const api = transport(async () => { if (++reads === 1) throw new Error('Offline'); return response.promise })
  const view = render(<KnowledgeDocumentReader knowledgeBaseId="policy" sourceId="source-1" title="引用" inline={inline}
    renderFactorySlot={renderKnowledgePreview} onClose={vi.fn()} t={t} />)
  onTestFinished(() => { view.unmount(); response.resolve(source) })
  const notice = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeReadFullDocument })).toBeNull()
  fireEvent.click(retry)
  expect(api.invoke).toHaveBeenCalledTimes(2)
  expect({ message: notice.textContent, action: retry.textContent,
    loadingIndicator: screen.queryByRole('status', { name: zh.loading }) !== null }).toMatchSnapshot('Pending source retry')
  await act(async () => { response.resolve(source) })
  expect(await screen.findByText(source.content)).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('region', { name: zh.knowledgeReadDocument }))
  expect({ content: screen.getByText(source.content).textContent, focus: document.activeElement?.getAttribute('aria-label'),
    retryVisible: screen.queryByRole('button', { name: zh.retry }) !== null }).toMatchSnapshot('Confirmed source retry')
})

it.each([
  { mode: 'source', inline: true }, { mode: 'source', inline: false },
  { mode: 'original', inline: true }, { mode: 'original', inline: false },
])('keeps another control focused after a $mode retry succeeds (inline: $inline)', async ({ mode, inline }) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const invoke = vi.fn(async () => {
    if (++reads === 1) throw new Error('Offline')
    return { ok: true, result: await response.promise }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const source = { knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1', filename: '原文.md', content: '已确认的引用正文', locator: '' }
  const value = mode === 'source' ? source : originalMetadata('policy', 'doc-1')
  const view = render(<><KnowledgeDocumentReader knowledgeBaseId="policy" title="阅读" inline={inline}
    {...mode === 'source' ? { sourceId: 'source-1' } : { documentId: 'doc-1' }}
    renderFactorySlot={() => null} onClose={vi.fn()} t={t} /><button type="button">其他操作</button></>)
  onTestFinished(() => { view.unmount(); response.resolve(value) })
  const retry = await screen.findByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus(); fireEvent.click(retry)
  const other = inline ? screen.getByRole('button', { name: '其他操作' }) : screen.getAllByRole('button', { name: zh.close })[0]!
  other.focus()
  await act(async () => { response.resolve(value) })
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  expect(document.activeElement).toBe(other)
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('keeps original-file authorization alive across language changes', async () => {
  const read = Promise.withResolvers<unknown>()
  const invoke = vi.fn(async () => ({ ok: true, result: await read.promise }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  const preview = vi.fn(() => null)
  const view = render(<KnowledgeDocumentReader {...props} renderFactorySlot={preview} />)
  await waitFor(() => { expect(invoke).toHaveBeenCalledOnce() })
  view.rerender(<KnowledgeDocumentReader {...props} renderFactorySlot={preview} t={key => en[key]} />)
  await act(async () => { read.resolve(originalMetadata('policy', 'doc-1')); await read.promise })
  await waitFor(() => { expect(preview).toHaveBeenCalled() })
  expect(invoke).toHaveBeenCalledOnce()
  expect(cancel).not.toHaveBeenCalled()
})

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

it.each([true, false])('hands focus from a retrieval passage to its separately authorized original file (inline: %s)', async (inline) => {
  const api = transport(async method => method === 'knowledge.sources.read'
    ? { knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1', filename: '原文.md', content: '检索引用', locator: '第 2 页' }
    : originalPreview('原文件完整正文'))
  render(<KnowledgeDocumentReader knowledgeBaseId="policy" sourceId="source-1" title="业务规范.md" inline={inline}
    renderFactorySlot={renderKnowledgePreview} onClose={vi.fn()} t={t} />)
  await screen.findByText('检索引用')
  expect(screen.getByText(zh.knowledgeExtractedContent)).toBeDefined()
  const open = screen.getByRole('button', { name: zh.knowledgeReadFullDocument })
  open.focus(); fireEvent.click(open)
  const reader = screen.getByRole('region', { name: zh.knowledgeReadDocument })
  expect(document.activeElement).toBe(reader)
  await screen.findByText('原文件完整正文')
  expect(document.activeElement).toBe(reader)
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
    ? { knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1', filename: '原文.md', content: '   ', locator: '第 2 页' }
    : originalPreview('原文件完整正文'))
  render(<KnowledgeDocumentReader knowledgeBaseId="policy" sourceId="source-1" title="业务规范.md" inline
    renderFactorySlot={renderKnowledgePreview} onClose={vi.fn()} t={t} />)
  expect(await screen.findByText(zh.knowledgeNoContent)).toBeDefined()
  expect(screen.getByText('第 2 页')).toBeDefined()
  expect(screen.queryByText('   ')).toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.sources.read', { sourceId: 'source-1' }, expect.any(String))
})

it.each(['confirmed', 'failed', 'revoked'] as const)('retains a passage and its controls during a refresh until %s', async (outcome) => {
  const response = Promise.withResolvers<unknown>()
  let refreshing = false
  const source = { knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1',
    filename: '原文.md', content: '已确认的引用正文', locator: '第 2 页' }
  transport(async () => refreshing ? response.promise : source)
  const denied = vi.fn()
  const reader = { knowledgeBaseId: 'policy', sourceId: 'source-1', title: '引用', inline: true,
    renderFactorySlot: renderKnowledgePreview, onClose: vi.fn(), onAccessDenied: denied, t }
  const view = render(<KnowledgeDocumentReader {...reader} refreshRevision={0} />)
  const body = await screen.findByText(source.content)
  const read = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeReadFullDocument })
  read.focus()
  refreshing = true
  view.rerender(<KnowledgeDocumentReader {...reader} refreshRevision={1} />)
  expect(screen.getByText(source.content)).toBe(body)
  expect(screen.getByRole('button', { name: zh.knowledgeReadFullDocument })).toBe(read)
  expect(read.disabled).toBe(false)
  expect(read.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(read)
  expect(read.classList.contains('product-control-pending')).toBe(true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  fireEvent.click(read)
  await act(async () => {
    if (outcome === 'revoked') response.reject(new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Revoked', false))
    else if (outcome === 'failed') response.reject(new Error('Offline'))
    else response.resolve({ ...source, content: '更新后的引用正文' })
  })
  if (outcome === 'confirmed') {
    expect(await screen.findByText('更新后的引用正文')).not.toBeNull()
    expect(screen.getByRole('button', { name: zh.knowledgeReadFullDocument })).toBe(read)
    expect(read.disabled).toBe(false)
  } else {
    expect(screen.queryByText(source.content)).toBeNull()
    expect(screen.queryByRole('button', { name: zh.knowledgeReadFullDocument })).toBeNull()
    expect(screen.getByRole('alert')).not.toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: zh.knowledgeReadDocument }))
  }
  expect(denied).toHaveBeenCalledTimes(outcome === 'revoked' ? 1 : 0)
})

it.each([
  { inline: true, elsewhere: false }, { inline: false, elsewhere: false },
  { inline: true, elsewhere: true }, { inline: false, elsewhere: true },
])('recovers removed passage-link focus without taking focus elsewhere (inline: $inline, elsewhere: $elsewhere)', async ({ inline, elsewhere }) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const source = { knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1',
    filename: '原文.md', content: '[阅读链接](https://example.com/reference)', locator: '第 2 页' }
  transport(async () => ++reads === 1 ? source : response.promise)
  const reader = { knowledgeBaseId: 'policy', sourceId: 'source-1', title: '引用', inline,
    renderFactorySlot: renderKnowledgePreview, onClose: vi.fn(), t }
  const content = (revision: number) => <><KnowledgeDocumentReader {...reader} refreshRevision={revision} />
    <button type="button">其他操作</button></>
  const view = render(content(0))
  onTestFinished(() => { view.unmount(); response.resolve(source) })
  const link = await screen.findByRole('link', { name: '阅读链接' })
  link.focus()
  view.rerender(content(1))
  await waitFor(() => { expect(reads).toBe(2) })
  expect(screen.getByRole('link', { name: '阅读链接' })).toBe(link)
  const other = inline ? screen.getByRole('button', { name: '其他操作' }) : screen.getAllByRole('button', { name: zh.close })[0]!
  if (elsewhere) other.focus()
  await act(async () => { response.reject(new Error('Offline')) })
  expect(screen.queryByRole('link', { name: '阅读链接' })).toBeNull()
  expect(screen.getByRole('alert')).not.toBeNull()
  expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('region', { name: zh.knowledgeReadDocument }))
})

it.each([
  { inline: true, outcome: 'removed' }, { inline: false, outcome: 'removed' },
  { inline: true, outcome: 'retained' }, { inline: false, outcome: 'retained' },
  { inline: true, outcome: 'elsewhere' }, { inline: false, outcome: 'elsewhere' },
])('keeps source-link focus through a confirmed refresh (inline: $inline, outcome: $outcome)', async ({ inline, outcome }) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const source = { knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1',
    filename: '原文.md', content: '[阅读链接](https://example.com/reference)', locator: '第 2 页' }
  transport(async () => ++reads === 1 ? source : response.promise)
  const reader = { knowledgeBaseId: 'policy', sourceId: 'source-1', title: '引用', inline,
    renderFactorySlot: renderKnowledgePreview, onClose: vi.fn(), t }
  const content = (revision: number) => <><KnowledgeDocumentReader {...reader} refreshRevision={revision} />
    <button type="button">其他操作</button></>
  const view = render(content(0))
  onTestFinished(() => { view.unmount(); response.resolve(source) })
  const link = await screen.findByRole('link', { name: '阅读链接' })
  link.focus()
  view.rerender(content(1))
  await waitFor(() => { expect(reads).toBe(2) })
  const other = inline ? screen.getByRole('button', { name: '其他操作' }) : screen.getAllByRole('button', { name: zh.close })[0]!
  if (outcome === 'elsewhere') other.focus()
  await act(async () => { response.resolve({ ...source, content: outcome === 'retained' ? source.content + '\n\n更新后的正文' : '更新后的正文' }) })
  expect(screen.getByText('更新后的正文')).not.toBeNull()
  if (outcome === 'retained') expect(screen.getByRole('link', { name: '阅读链接' })).toBe(link)
  else expect(screen.queryByRole('link', { name: '阅读链接' })).toBeNull()
  expect(document.activeElement).toBe(outcome === 'elsewhere' ? other : outcome === 'retained' ? link
    : screen.getByRole('region', { name: zh.knowledgeReadDocument }))
  expect({ content: screen.getByText('更新后的正文').textContent, focused: document.activeElement?.getAttribute('aria-label')
    ?? document.activeElement?.textContent, linkRetained: link.isConnected }).toMatchSnapshot('Confirmed source-link focus')
})

it.each(['passage', 'original'] as const)('does not retain another source or its %s view while a new passage is pending', async (mode) => {
  const next = Promise.withResolvers<unknown>()
  const pending = Promise.withResolvers<unknown>()
  let switched = false
  transport(async method => method === 'knowledge.sources.read' ? switched ? pending.promise : next.promise
    : originalPreview('另一条引用的原文件'))
  const reader = { knowledgeBaseId: 'policy', sourceId: 'source-1', title: '引用', inline: true,
    renderFactorySlot: renderKnowledgePreview, onClose: vi.fn(), t }
  const view = render(<KnowledgeDocumentReader {...reader} />)
  await act(async () => { next.resolve({ knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1',
    filename: '原文.md', content: '另一条引用的正文', locator: '第 2 页' }) })
  await screen.findByText('另一条引用的正文')
  if (mode === 'original') {
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
    await screen.findByText('另一条引用的原文件')
  }
  switched = true
  view.rerender(<KnowledgeDocumentReader {...reader} sourceId="source-2" />)
  expect(screen.queryByText('另一条引用的正文')).toBeNull()
  expect(screen.queryByText('另一条引用的原文件')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeReadFullDocument })).toBeNull()
  await act(async () => { pending.resolve({ knowledgeBaseId: 'policy', sourceId: 'source-2', documentId: 'doc-2',
    filename: '新原文.md', content: '新引用的正文', locator: '第 3 页' }) })
  expect(await screen.findByText('新引用的正文')).not.toBeNull()
})

it.each(['filename', 'locator'] as const)('rejects a source with invalid %s before displaying its body', async (field) => {
  transport(async () => ({ knowledgeBaseId: 'policy', sourceId: 'source-1', documentId: 'doc-1',
    filename: '原文.md', locator: '第 2 页', content: 'Invalid source body', [field]: 42 }))
  render(<KnowledgeDocumentReader knowledgeBaseId="policy" sourceId="source-1" expectedDocumentId="doc-1"
    title="业务规范.md" inline renderFactorySlot={renderKnowledgePreview} onClose={vi.fn()} t={t} />)
  expect((await screen.findByRole('alert')).textContent).toBe(zh.knowledgeReadFailed)
  expect(screen.queryByText('Invalid source body')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeReadFullDocument })).toBeNull()
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

it('reports private preview cleanup failure with a restart instruction and no upstream details', async () => {
  const denied = vi.fn()
  transport(async () => { throw new ProductError('KNOWLEDGE_PREVIEW_CLEANUP_FAILED', '/private/source/file token=secret', false) }, '业务规范.docx')
  render(<KnowledgeDocumentReader {...props} title="业务规范.docx" onAccessDenied={denied} />)
  expect((await screen.findByRole('alert')).textContent)
    .toMatchInlineSnapshot('"临时预览文件清理失败，请重启桌面端后重试 (KNOWLEDGE_PREVIEW_CLEANUP_FAILED)"')
  expect(screen.queryByText('/private/source/file token=secret')).toBeNull()
  expect(denied).not.toHaveBeenCalled()
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

it.each([
  ['another-library', 'doc-1'],
  ['policy', 'another-document'],
])('rejects preview metadata for %s/%s and allows retrying the requested file', async (knowledgeBaseId, documentId) => {
  const denied = vi.fn()
  let mismatched = true
  const preview = createPreviewFixture()
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => ({ ok: true,
    result: method === 'knowledge.documents.previewMetadata'
      ? originalMetadata(mismatched ? knowledgeBaseId : 'policy', mismatched ? documentId : 'doc-1')
      : await preview(method, payload, async () => originalPreview('正确的原文件')),
  }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = render(<KnowledgeDocumentReader {...props} onAccessDenied={denied} />)
  expect((await screen.findByRole('alert')).textContent).toBe(zh.knowledgePreviewFailed)
  expect(view.container.querySelector('[data-original-preview]')).toBeNull()
  expect(invoke.mock.calls.map(row => row[1])).toEqual(['knowledge.documents.previewMetadata'])
  expect(denied).not.toHaveBeenCalled()
  mismatched = false
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByText('正确的原文件')
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
