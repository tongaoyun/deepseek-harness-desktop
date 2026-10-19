// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeDetail } from '../src/client/KnowledgeView.tsx'
import { detail } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'
import { createPreviewFixture, originalMetadata, originalPreview, renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const hit = { sourceId: 'chunk-1', documentId: 'doc-1', knowledgeBaseId: 'policy', filename: '业务规范.md', content: '检索摘要' }
const source = { ...hit, content: '完整来源' }
const library = detail({ id: 'policy', name: '业务规范', scope: 'PERSONAL', canManage: false }, {})!

function transport(handler: (method: string) => Promise<unknown>) {
  const preview = createPreviewFixture()
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown, _requestId?: string) => ({
    ok: true, result: await preview(method, payload, async () => {
      if (method === 'knowledge.documents.list') return { items: [], page: 1, size: 20, total: 0 }
      if (method === 'knowledge.folders.list') return { items: [], page: 1, size: 100, total: 0 }
      return handler(method)
    }),
  }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}

async function search() {
  fireEvent.click(screen.getByRole('tab', { name: zh.knowledgeRetrieval }))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '业务规范' } })
  fireEvent.click(screen.getByRole('button', { name: zh.search }))
  await screen.findByText(hit.content)
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([
  ['knowledge.sources.read', 'KNOWLEDGE_ACCESS_REVOKED', 'knowledgeAccessRevoked'],
  ['knowledge.documents.previewMetadata', 'KNOWLEDGE_ACCESS_DENIED', 'knowledgeAccessDenied'],
  ['knowledge.documents.preview.open', 'ORGANIZATION_EMPLOYEE_INACTIVE', 'organizationEmployeeInactive'],
  ['knowledge.documents.download', 'ORGANIZATION_EMPLOYEE_UNMAPPED', 'organizationEmployeeUnmapped'],
] as const)('clears search summaries and the reader after %s denies access', async (method, code, key) => {
  let denied = true
  const api = transport(async (name) => {
    if (name === method && denied) throw new ProductError(code, 'Private remote diagnostic')
    if (name === 'knowledge.search') return [hit]
    if (name === 'knowledge.sources.read') return source
    if (name === 'knowledge.documents.previewMetadata') return originalMetadata('policy', 'doc-1')
    if (name === 'knowledge.documents.preview.open') return originalPreview('原文正文')
    return { downloaded: true }
  })
  const view = render(<KnowledgeDetail product={library} renderFactorySlot={renderKnowledgePreview} t={t} />)
  await search()
  fireEvent.click(screen.getByRole('button', { name: hit.filename }))
  if (method !== 'knowledge.sources.read') {
    await screen.findByText(source.content)
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
  }
  if (method === 'knowledge.documents.download') {
    await screen.findByText('原文正文')
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDownloadOriginal }))
  }
  const message = `${zh[key]} (${code})`
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText(hit.content)).toBeNull()
  })
  expect(screen.getByRole('alert').textContent).toBe(message)
  expect(view.container.textContent).not.toContain('Private remote diagnostic')
  expect(screen.queryByText(zh.noSearchResults)).toBeNull()
  expect(screen.getByDisplayValue('业务规范')).toBeDefined()
  if (method === 'knowledge.sources.read') expect(screen.getByRole('tabpanel').textContent).toMatchSnapshot()
  denied = false
  fireEvent.click(screen.getByRole('button', { name: zh.search }))
  await screen.findByText(hit.content)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.search')).toHaveLength(2)
})

it.each(['knowledge.sources.read', 'knowledge.documents.preview.open', 'knowledge.documents.download'])(
  'keeps search results on organization outages from %s and retries the affected read', async (method) => {
    let unavailable = true
    transport(async (name) => {
      if (name === method && unavailable) throw new ProductError('ORGANIZATION_SERVICE_UNAVAILABLE', 'Private remote diagnostic', true)
      if (name === 'knowledge.search') return [hit]
      if (name === 'knowledge.sources.read') return source
      if (name === 'knowledge.documents.previewMetadata') return originalMetadata('policy', 'doc-1')
      if (name === 'knowledge.documents.preview.open') return originalPreview('原文正文')
      return { downloaded: true }
    })
    render(<KnowledgeDetail product={library} renderFactorySlot={renderKnowledgePreview} t={t} />)
    await search()
    fireEvent.click(screen.getByRole('button', { name: hit.filename }))
    if (method !== 'knowledge.sources.read') {
      await screen.findByText(source.content)
      fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
    }
    if (method === 'knowledge.documents.download') {
      await screen.findByText('原文正文')
      fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDownloadOriginal }))
    }
    await screen.findByText(`${zh.organizationServiceUnavailable} (ORGANIZATION_SERVICE_UNAVAILABLE)`)
    expect(screen.getByText(hit.content)).toBeDefined()
    const reader = screen.getByRole('dialog', { name: hit.filename })
    unavailable = false
    fireEvent.click(within(reader).getByRole('button', { name: method === 'knowledge.documents.download' ? zh.knowledgeDownloadOriginal : zh.retry }))
    if (method !== 'knowledge.documents.download') await screen.findByText(method === 'knowledge.sources.read' ? source.content : '原文正文')
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  },
)

it('cancels an in-flight original preview when download revokes access and ignores its late result', async () => {
  let resolvePreview!: (value: unknown) => void
  const api = transport(async (method) => {
    if (method === 'knowledge.search') return [hit]
    if (method === 'knowledge.sources.read') return source
    if (method === 'knowledge.documents.previewMetadata') return originalMetadata('policy', 'doc-1')
    if (method === 'knowledge.documents.preview.open') return new Promise((resolve) => { resolvePreview = resolve })
    if (method === 'knowledge.documents.download') throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Access revoked')
    return {}
  })
  render(<KnowledgeDetail product={library} renderFactorySlot={renderKnowledgePreview} t={t} />)
  await search()
  fireEvent.click(screen.getByRole('button', { name: hit.filename }))
  await screen.findByText(source.content)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
  await waitFor(() => { expect(resolvePreview).toBeDefined() })
  const pending = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')!
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDownloadOriginal }))
  try { await waitFor(() => { expect(api.cancel).toHaveBeenCalledWith('product', pending[3]) }) }
  finally { await act(async () => { resolvePreview(originalPreview('不应回填的正文')) }) }
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText(hit.content)).toBeNull()
  expect(screen.queryByText('不应回填的正文')).toBeNull()
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.close')).toBe(true) })
})

it('ignores an old reader denial after another search has replaced it', async () => {
  let rejectSource!: (error: Error) => void
  let searches = 0
  const replacement = { ...hit, sourceId: 'chunk-2', content: '新检索摘要' }
  const api = transport(async (method) => {
    if (method === 'knowledge.search') return [searches++ === 0 ? hit : replacement]
    if (method === 'knowledge.sources.read') return new Promise((_resolve, reject) => { rejectSource = reject })
    return {}
  })
  render(<KnowledgeDetail product={library} renderFactorySlot={renderKnowledgePreview} t={t} />)
  await search()
  fireEvent.click(screen.getByRole('button', { name: hit.filename }))
  await waitFor(() => { expect(rejectSource).toBeDefined() })
  const pending = api.invoke.mock.calls.find(row => row[1] === 'knowledge.sources.read')!
  try {
    fireEvent.submit(screen.getByRole('searchbox').closest('form')!)
    await screen.findByText(replacement.content)
    expect(api.cancel).toHaveBeenCalledWith('product', pending[3])
  } finally { await act(async () => { rejectSource(new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Old request revoked')) }) }
  expect(screen.getByText(replacement.content)).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})
