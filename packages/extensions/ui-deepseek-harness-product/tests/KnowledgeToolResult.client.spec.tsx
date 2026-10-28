// @vitest-environment jsdom
import { useState } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeToolResult, registerKnowledgeToolResults } from '../src/client/KnowledgeToolResult.tsx'
import { en, zh, NS } from '../src/locales.ts'
import { createPreviewFixture, originalMetadata, originalPreview, renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

const localeContext = new Context()
const locale = new LocaleRuntime(localeContext)
locale.register(NS, { en, zh })
locale.setLocale('zh')
const t = locale.bind(NS)
const source = { sourceId: 'source-2', knowledgeBaseId: 'department-policy', knowledgeBaseName: '产品部',
  documentId: 'document-2', filename: '交付政策.md', locator: '第 2 页' }
const meta = { kind: 'product-knowledge-sources-v1', sources: [source] }
const block = (overrides: Partial<ToolResultNode> = {}): ToolResultNode => ({
  kind: 'tool-result', seq: 3, time: 3_000, callId: 'knowledge-call', name: 'knowledge_search',
  args: PartialArguments.fromText('{"query":"delivery"}'), call: { name: 'knowledge_search', argsRaw: '{"query":"delivery"}' },
  callTime: 2_000, content: [{ type: 'text', text: 'Recorded knowledge result' }], isError: false, subCalls: [], meta, ...overrides,
})
function useDisclosure() {
  const [expanded, setExpanded] = useState(false)
  return { expanded, setExpanded, toggle: () => { setExpanded(value => !value) } }
}
const props = {
  phase: 'result' as const, sessionId: 'recorded-task' as SessionId, callId: 'knowledge-call', toolName: 'knowledge_search',
  openFile: vi.fn(), loadImage: vi.fn(), useDisclosure, renderFactorySlot: renderKnowledgePreview, t,
}

function transport(handler: (method: string, payload: unknown) => Promise<unknown>) {
  const preview = createPreviewFixture()
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown, _requestId?: string) => ({ ok: true,
    result: await preview(method, payload, handler) }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); locale.setLocale('zh') })
afterAll(async () => { await localeContext.fiber.dispose() })

it.each(['knowledge_search', 'knowledge_read'])('opens a recorded %s source through authorized passage and official original preview', async (toolName) => {
  const api = transport(async method => method === 'knowledge.sources.read' ? { ...source, content: '期限为 17 天。' }
    : method === 'knowledge.documents.previewMetadata' ? originalMetadata(source.knowledgeBaseId, source.documentId, source.filename)
      : originalPreview('# 原文件\n\n期限为 17 天。'))
  render(<KnowledgeToolResult {...props} toolName={toolName} block={block()} />)
  expect(api.invoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText(t(toolName === 'knowledge_read' ? 'knowledgeToolRead' : 'knowledgeToolSearch')))
  fireEvent.click(screen.getByRole('button', { name: source.filename }))
  await screen.findByText('期限为 17 天。')
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.sources.read', { sourceId: source.sourceId }, expect.any(String))
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
  await screen.findByRole('heading', { name: '原文件' })
  expect(screen.getAllByText(source.locator).length).toBeGreaterThan(0)
  expect(document.body.querySelector(`[data-original-preview="${source.filename}"]`)).not.toBeNull()
  expect(api.invoke).toHaveBeenCalledWith('product', 'knowledge.documents.preview.open', {
    knowledgeBaseId: source.knowledgeBaseId, documentId: source.documentId,
  }, expect.any(String), 300_000)
  expect(props.openFile).not.toHaveBeenCalled()
})

it.each([undefined, { kind: 'other', sources: [source] }, { ...meta, sources: [{ ...source, documentId: 1 }] }])(
  'retains the recorded output without inventing links from unsupported metadata', async (resultMeta) => {
    const api = transport(async () => undefined)
    render(<KnowledgeToolResult {...props} block={block({ meta: resultMeta })} />)
    fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
    expect(screen.getByText('Recorded knowledge result')).not.toBeNull()
    expect(screen.queryByRole('button', { name: source.filename })).toBeNull()
    expect(api.invoke).not.toHaveBeenCalled()
  })

it('shows failed tool output without offering stale source actions', () => {
  render(<KnowledgeToolResult {...props} block={block({ isError: true, content: [{ type: 'text', text: 'Access revoked' }] })} />)
  fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
  expect(screen.getByText('Access revoked')).not.toBeNull()
  expect(screen.queryByRole('button', { name: source.filename })).toBeNull()
})

it('rechecks source permission on click and stops before fetching the original on explicit denial', async () => {
  const api = transport(async () => { throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Private diagnostic', false) })
  render(<KnowledgeToolResult {...props} block={block()} />)
  fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
  fireEvent.click(screen.getByRole('button', { name: source.filename }))
  expect((await screen.findByRole('alert')).textContent).toContain('KNOWLEDGE_ACCESS_REVOKED')
  expect(screen.queryByText('Private diagnostic')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeReadFullDocument })).toBeNull()
  expect(api.invoke.mock.calls.map(row => row[1])).toEqual(['knowledge.sources.read'])
})

it.each([{ knowledgeBaseId: 'other-base' }, { documentId: 'other-document' }, { sourceId: 'other-source' }])(
  'rejects a reread with changed source identity before offering its original', async (changed) => {
    transport(async () => ({ ...source, ...changed, content: 'Wrong source content' }))
    render(<KnowledgeToolResult {...props} block={block()} />)
    fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
    fireEvent.click(screen.getByRole('button', { name: source.filename }))
    await screen.findByRole('alert')
    expect(screen.queryByText('Wrong source content')).toBeNull()
    expect(screen.queryByRole('button', { name: zh.knowledgeReadFullDocument })).toBeNull()
  })

it('cancels a pending citation read when its conversation row unmounts', async () => {
  let finish!: (value: unknown) => void
  const api = transport(async () => new Promise((resolve) => { finish = resolve }))
  const view = render(<KnowledgeToolResult {...props} block={block()} />)
  fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
  fireEvent.click(screen.getByRole('button', { name: source.filename }))
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledOnce() })
  view.unmount()
  expect(api.cancel).toHaveBeenCalledOnce()
  await act(async () => { finish({ ...source, content: 'Late result' }) })
  expect(screen.queryByText('Late result')).toBeNull()
})

it('registers and releases both source rows through the public keyed toolview registry', async () => {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  slots.register({ name: 'root', children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } } } as never, () => null)
  const fiber = ctx.plugin({ inject: ['slots'], apply: registerKnowledgeToolResults })
  await fiber.await()
  expect(slots.entries('tool.call.toolview').map(entry => ({ key: entry.options.key, locale: entry.locale, component: entry.component })))
    .toEqual(['knowledge_search', 'knowledge_read'].map(key => ({ key, locale: NS, component: KnowledgeToolResult })))
  await fiber.dispose()
  expect(slots.entries('tool.call.toolview')).toEqual([])
  await ctx.fiber.dispose()
})

it.each([
  ['knowledge.sources.read', 'KNOWLEDGE_ACCESS_REVOKED', 'knowledgeAccessRevoked'],
  ['knowledge.documents.previewMetadata', 'KNOWLEDGE_ACCESS_DENIED', 'knowledgeAccessDenied'],
  ['knowledge.documents.preview.open', 'ORGANIZATION_EMPLOYEE_INACTIVE', 'organizationEmployeeInactive'],
  ['knowledge.documents.download', 'ORGANIZATION_EMPLOYEE_UNMAPPED', 'organizationEmployeeUnmapped'],
] as const)('closes the citation reader after %s denies access', async (method, code, key) => {
  let denied = true
  const api = transport(async (name) => {
    if (name === method && denied) throw new ProductError(code, 'Private remote diagnostic')
    if (name === 'knowledge.sources.read') return { ...source, content: '完整来源' }
    if (name === 'knowledge.documents.previewMetadata') return originalMetadata(source.knowledgeBaseId, source.documentId, source.filename)
    if (name === 'knowledge.documents.preview.open') return originalPreview('原文正文')
    return { downloaded: true }
  })
  const view = render(<KnowledgeToolResult {...props} block={block()} />)
  fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
  fireEvent.click(screen.getByRole('button', { name: source.filename }))
  if (method !== 'knowledge.sources.read') {
    await screen.findByText('完整来源')
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
  }
  if (method === 'knowledge.documents.download') {
    await screen.findByText('原文正文')
    fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDownloadOriginal }))
  }
  const message = `${zh[key]} (${code})`
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  expect(screen.getByRole('alert').textContent).toBe(message)
  expect(view.container.textContent).not.toContain('Private remote diagnostic')
  expect(screen.queryByText(zh.noSearchResults)).toBeNull()
  denied = false
  fireEvent.click(screen.getByRole('button', { name: source.filename }))
  await screen.findByText('完整来源')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.invoke.mock.calls.filter(row => row[1] === 'knowledge.sources.read')).toHaveLength(2)
})

it.each(['knowledge.sources.read', 'knowledge.documents.preview.open', 'knowledge.documents.download'])(
  'keeps the citation reader on organization outages from %s and retries the affected read', async (method) => {
    let unavailable = true
    transport(async (name) => {
      if (name === method && unavailable) throw new ProductError('ORGANIZATION_SERVICE_UNAVAILABLE', 'Private remote diagnostic', true)
      if (name === 'knowledge.sources.read') return { ...source, content: '完整来源' }
      if (name === 'knowledge.documents.previewMetadata') return originalMetadata(source.knowledgeBaseId, source.documentId, source.filename)
      if (name === 'knowledge.documents.preview.open') return originalPreview('原文正文')
      return { downloaded: true }
    })
    render(<KnowledgeToolResult {...props} block={block()} />)
    fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
    fireEvent.click(screen.getByRole('button', { name: source.filename }))
    if (method !== 'knowledge.sources.read') {
      await screen.findByText('完整来源')
      fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
    }
    if (method === 'knowledge.documents.download') {
      await screen.findByText('原文正文')
      fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDownloadOriginal }))
    }
    await screen.findByText(`${zh.organizationServiceUnavailable} (ORGANIZATION_SERVICE_UNAVAILABLE)`)
    expect(screen.getByRole('button', { name: source.filename })).toBeDefined()
    const reader = screen.getByRole('dialog', { name: source.filename })
    unavailable = false
    fireEvent.click(within(reader).getByRole('button', { name: method === 'knowledge.documents.download' ? zh.knowledgeDownloadOriginal : zh.retry }))
    if (method !== 'knowledge.documents.download') await screen.findByText(method === 'knowledge.sources.read' ? '完整来源' : '原文正文')
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  },
)

it('cancels an in-flight original preview when download revokes access and ignores its late result', async () => {
  let resolvePreview!: (value: unknown) => void
  const api = transport(async (method) => {
    if (method === 'knowledge.sources.read') return { ...source, content: '完整来源' }
    if (method === 'knowledge.documents.previewMetadata') return originalMetadata(source.knowledgeBaseId, source.documentId, source.filename)
    if (method === 'knowledge.documents.preview.open') return new Promise((resolve) => { resolvePreview = resolve })
    if (method === 'knowledge.documents.download') throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Access revoked')
    return {}
  })
  render(<KnowledgeToolResult {...props} block={block()} />)
  fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
  fireEvent.click(screen.getByRole('button', { name: source.filename }))
  await screen.findByText('完整来源')
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeReadFullDocument }))
  await waitFor(() => { expect(resolvePreview).toBeDefined() })
  const pending = api.invoke.mock.calls.find(row => row[1] === 'knowledge.documents.preview.open')!
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDownloadOriginal }))
  try { await waitFor(() => { expect(api.cancel).toHaveBeenCalledWith('product', pending[3]) }) }
  finally { await act(async () => { resolvePreview(originalPreview('不应回填的正文')) }) }
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText('不应回填的正文')).toBeNull()
  await waitFor(() => { expect(api.invoke.mock.calls.some(row => row[1] === 'knowledge.documents.preview.close')).toBe(true) })
})

it('ignores a cancelled citation denial after opening another source', async () => {
  let rejectSource!: (error: Error) => void
  const replacement = { ...source, sourceId: 'replacement', documentId: 'replacement-document', filename: '新资料.md' }
  const api = transport(async (_method, payload) => {
    if (typeof payload === 'object' && payload !== null && 'sourceId' in payload && payload.sourceId === source.sourceId) {
      return new Promise((_resolve, reject) => { rejectSource = reject })
    }
    return { ...replacement, content: '新来源正文' }
  })
  render(<KnowledgeToolResult {...props} block={block({ meta: { ...meta, sources: [source, replacement] } })} />)
  fireEvent.click(screen.getByText(zh.knowledgeToolSearch))
  fireEvent.click(screen.getByRole('button', { name: source.filename }))
  await waitFor(() => { expect(rejectSource).toBeDefined() })
  const pending = api.invoke.mock.calls.find(row => row[1] === 'knowledge.sources.read')!
  try {
    fireEvent.click(screen.getByRole('button', { name: replacement.filename }))
    await screen.findByText('新来源正文')
    expect(api.cancel).toHaveBeenCalledWith('product', pending[3])
  } finally { await act(async () => { rejectSource(new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Old request revoked')) }) }
  expect(screen.getByText('新来源正文')).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('dialog', { name: replacement.filename })).toBeDefined()
})

it.each(['en', 'zh'])('reports denied citation access in %s after closing live content', async (language) => {
  locale.setLocale(language)
  transport(async () => { throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Private diagnostic') })
  const view = render(<KnowledgeToolResult {...props} block={block()} />)
  fireEvent.click(screen.getByText(t('knowledgeToolSearch')))
  fireEvent.click(screen.getByRole('button', { name: source.filename }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(view.container.textContent).toMatchSnapshot()
})
