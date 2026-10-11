// @vitest-environment jsdom
import { useState } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => ({ ok: true,
    result: method === 'knowledge.documents.previewMetadata'
      ? originalMetadata(source.knowledgeBaseId, source.documentId, source.filename)
      : await preview(method, payload, handler) }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })
afterAll(async () => { await localeContext.fiber.dispose() })

it.each(['knowledge_search', 'knowledge_read'])('opens a recorded %s source through authorized passage and official original preview', async (toolName) => {
  const api = transport(async method => method === 'knowledge.sources.read' ? { ...source, content: '期限为 17 天。' }
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
  finish({ ...source, content: 'Late result' })
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
