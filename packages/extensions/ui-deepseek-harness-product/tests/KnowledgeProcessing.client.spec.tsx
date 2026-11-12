// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeProcessingDetails } from '../src/client/KnowledgeProcessingDetails.tsx'
import { KnowledgeDocuments } from '../src/client/KnowledgeDocuments.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { en, zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const document = { id: 'doc', knowledgeBaseId: 'base', filename: '资料.md', mediaType: 'text/markdown', sizeBytes: 10,
  status: 'READY', chunkCount: 1, updatedAt: '2026-11-05T00:00:00Z' }
const details = () => ({ documentId: 'doc', knowledgeBaseId: 'base', status: 'READY', attempt: 1, stalled: false,
  summaryStatus: 'COMPLETED', summary: '这是一份业务摘要。', summaryEnabled: true,
  stages: ['DOCUMENT', 'CHUNKING', 'EMBEDDING', 'MULTIMODAL', 'ENRICHMENT']
    .map(name => ({ name, status: 'COMPLETED', durationMillis: 1250 })),
})
function transport(handler: (method: string, payload: unknown) => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: unknown) => (
    { ok: true, result: await handler(method, payload) }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}
function mount(canManage = false, onAccessDenied = vi.fn()) {
  return render(<KnowledgeProcessingDetails knowledgeBaseId="base" documentId="doc" canManage={canManage}
    refreshRevision={0} onAccessDenied={onAccessDenied} t={t} />)
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('retains a processing read error while refreshing without inserting a loading row', async () => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const api = transport(async () => { if (++reads === 1) throw new Error('Offline'); return response.promise })
  const view = mount()
  onTestFinished(() => { view.unmount(); response.resolve(details()) })
  const notice = await screen.findByRole('alert')
  const refresh = screen.getByRole<HTMLButtonElement>('button', { name: zh.refresh })
  const glyph = refresh.querySelector('svg')
  refresh.focus()
  act(() => { refresh.click(); refresh.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(refresh.querySelector('svg')).toBe(glyph)
  expect(refresh.disabled).toBe(false)
  expect(refresh.getAttribute('aria-disabled')).toBe('true')
  expect(globalThis.document.activeElement).toBe(refresh)
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  fireEvent.click(refresh)
  expect(api.invoke).toHaveBeenCalledTimes(2)
  expect({ message: notice.textContent, action: refresh.textContent,
    loadingIndicator: screen.queryByRole('status', { name: zh.loading }) !== null }).toMatchSnapshot('Pending processing retry')
  await act(async () => { response.resolve(details()) })
  expect(await screen.findByText(details().summary)).toBeDefined()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(refresh.disabled).toBe(false)
  expect(refresh.getAttribute('aria-disabled')).toBe('false')
  expect(globalThis.document.activeElement).toBe(refresh)
})

it.each(['removed', 'retained', 'failed', 'elsewhere', 'summary-disabled'] as const)(
  'keeps processing controls focused after a confirmed refresh until %s', async (outcome) => {
    const response = Promise.withResolvers<unknown>()
    const initial = { ...details(), summary: '[阅读链接](https://example.com/reference)' }
    let reads = 0
    transport(async () => ++reads === 1 ? initial : response.promise)
    const view = mount(true)
    onTestFinished(() => { view.unmount(); response.resolve(initial) })
    const link = await screen.findByRole('link', { name: '阅读链接' })
    const refresh = screen.getByRole('button', { name: zh.refresh })
    fireEvent.click(refresh)
    await waitFor(() => { expect(reads).toBe(2) })
    const origin = outcome === 'summary-disabled' ? screen.getByRole('button', { name: zh.knowledgeSummaryRegenerate }) : link
    origin.focus()
    if (outcome === 'elsewhere') refresh.focus()
    await act(async () => {
      if (outcome === 'failed') response.reject(new Error('Offline'))
      else response.resolve({ ...initial, summary: outcome === 'retained' ? initial.summary + '\n\n更新摘要' : '更新摘要',
        summaryEnabled: outcome !== 'summary-disabled' })
    })
    if (outcome === 'retained') expect(screen.getByRole('link', { name: '阅读链接' })).toBe(link)
    else expect(screen.queryByRole('link', { name: '阅读链接' })).toBeNull()
    expect(globalThis.document.activeElement).toBe(outcome === 'elsewhere' ? refresh : outcome === 'retained' ? link
      : screen.getByRole('region', { name: zh.knowledgeProcessingDetails }))
    const focused = globalThis.document.activeElement
    expect({ focused: focused?.getAttribute('aria-label') ?? focused?.textContent,
      linkVisible: screen.queryByRole('link', { name: '阅读链接' }) !== null,
      failure: screen.queryByRole('alert')?.textContent ?? null }).toMatchSnapshot('Confirmed processing focus')
  },
)

it('keeps a processing read alive across language changes and translates errors at render time', async () => {
  const read = Promise.withResolvers<unknown>()
  const api = transport(async () => read.promise)
  const props = { knowledgeBaseId: 'base', documentId: 'doc', canManage: false, refreshRevision: 0, onAccessDenied: vi.fn() }
  const view = render(<KnowledgeProcessingDetails {...props} t={t} />)
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledOnce() })
  view.rerender(<KnowledgeProcessingDetails {...props} t={key => en[key]} />)
  await act(async () => { read.reject(new Error('Offline')); await read.promise.catch(() => undefined) })
  expect((await screen.findByRole('alert')).textContent).toBe(en.knowledgeProcessingReadFailed)
  view.rerender(<KnowledgeProcessingDetails {...props} t={t} />)
  expect(screen.getByRole('alert').textContent).toBe(zh.knowledgeProcessingReadFailed)
  expect(api.invoke).toHaveBeenCalledOnce()
  expect(api.cancel).not.toHaveBeenCalled()
})

it('preserves a pending summary write while changing language and reports its result in the current language', async () => {
  const write = Promise.withResolvers<unknown>()
  const api = transport(async method => method === 'knowledge.documents.processing' ? details() : write.promise)
  const props = { knowledgeBaseId: 'base', documentId: 'doc', canManage: true, refreshRevision: 0, onAccessDenied: vi.fn() }
  const view = render(<KnowledgeProcessingDetails {...props} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeSummaryRegenerate }))
  await waitFor(() => { expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.summary.refresh')).toBe(true) })
  view.rerender(<KnowledgeProcessingDetails {...props} t={key => en[key]} />)
  await act(async () => { write.reject(new Error('Offline')); await write.promise.catch(() => undefined) })
  expect((await screen.findByRole('alert')).textContent).toBe(en.knowledgeChangeFailed)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.summary.refresh')).toHaveLength(1)
  expect(api.cancel).not.toHaveBeenCalled()
})

it('reads processing details on demand through the materials menu and renders sanitized user output', async () => {
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.processing') return { ...details(), error_message: '/private/parser/secret' }
    return { items: method === 'knowledge.documents.list' ? [document] : [], page: 1, size: 20, total: method === 'knowledge.documents.list' ? 1 : 0 }
  })
  const library = localDetail(items([{ id: 'base', name: '业务资料', scope: 'PERSONAL' }])[0]!)
  const { container } = render(<KnowledgeDocuments product={library} renderFactorySlot={() => null} t={t} />)
  await screen.findByRole('button', { name: '资料.md' })
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.processing')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeProcessingDetails }))
  await screen.findByText('这是一份业务摘要。')
  expect(screen.getByRole('table').textContent).toContain(zh.knowledgeStageDocument)
  expect(screen.queryByRole('button', { name: zh.knowledgeSummaryRegenerate })).toBeNull()
  expect(container.textContent).not.toContain('/private/parser/secret')
  expect(screen.getByRole('region', { name: zh.knowledgeProcessingDetails }).textContent).toMatchSnapshot()
})

it('retains a summary write identity across lost responses and confirms the requested document', async () => {
  let failed = true
  const response = Promise.withResolvers<unknown>()
  const api = transport(async (method) => {
    if (method === 'knowledge.documents.processing') return details()
    if (failed) throw new Error('Connection lost')
    return response.promise
  })
  const view = mount(true)
  onTestFinished(() => { view.unmount(); response.resolve(document) })
  fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeSummaryRegenerate }))
  const notice = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSummaryRegenerate })
  failed = false
  retry.focus()
  act(() => { retry.click(); retry.click() })
  expect(screen.getByRole('alert')).toBe(notice)
  expect(screen.getByRole('button', { name: zh.knowledgeSummarySubmitting })).toBe(retry)
  expect(retry.getAttribute('aria-busy')).toBe('true')
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(globalThis.document.activeElement).toBe(retry)
  expect(retry.classList.contains('product-control-pending')).toBe(true)
  expect({ message: notice.textContent, action: retry.textContent,
    focused: globalThis.document.activeElement === retry }).toMatchSnapshot('Pending summary retry')
  await act(async () => { response.resolve(document) })
  await screen.findByText(zh.knowledgeSummaryAccepted)
  expect(screen.queryByRole('alert')).toBeNull()
  const writes = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.summary.refresh')
  expect(writes).toHaveLength(2)
  expect(writes[0]?.[2]).toEqual(writes[1]?.[2])
})

it('never reports a summary request as accepted for a different document', async () => {
  transport(async method => method === 'knowledge.documents.processing' ? details() : { ...document, id: 'foreign' })
  mount(true)
  fireEvent.click(await screen.findByRole('button', { name: zh.knowledgeSummaryRegenerate }))
  expect((await screen.findByRole('alert')).textContent).toContain(zh.knowledgeChangeUnconfirmed)
  expect(screen.queryByText(zh.knowledgeSummaryAccepted)).toBeNull()
})

it('hides disabled summary writes and blocks them while native processing is active', async () => {
  let value = { ...details(), summaryEnabled: false }
  const api = transport(async () => value)
  mount(true)
  await screen.findByText(zh.knowledgeSummaryDisabled)
  expect(screen.queryByRole('button', { name: zh.knowledgeSummaryRegenerate })).toBeNull()
  value = { ...value, summaryEnabled: true, summaryStatus: 'PROCESSING' }
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  const action = await screen.findByRole('button', { name: zh.knowledgeSummaryRegenerate })
  await waitFor(() => { expect(action.getAttribute('aria-disabled')).toBe('true') })
  fireEvent.click(action)
  await act(async () => {})
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.documents.summary.refresh')).toBe(false)
})

it('rejects mismatched or malformed progress and recovers by reading again', async () => {
  let value: unknown = { ...details(), documentId: 'foreign' }
  transport(async () => value)
  mount()
  await screen.findByRole('alert')
  expect(screen.queryByText('这是一份业务摘要。')).toBeNull()
  value = { ...details(), stages: [{ name: 'DOCUMENT', status: 'COMPLETED', durationMillis: -1 }] }
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByRole('alert')
  value = { ...details(), attempt: 0, stages: [] }
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await screen.findByText(zh.knowledgeProcessingNoStages)
  expect(screen.queryByRole('table')).toBeNull()
})

it('refreshes active summary work until settled and stops polling after a read failure', async () => {
  vi.useFakeTimers()
  let value = { ...details(), summaryStatus: 'PROCESSING' }
  let fail = false
  const api = transport(async () => {
    if (fail) throw new Error('Connection lost')
    return value
  })
  mount()
  await act(async () => {})
  expect(api.invoke).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  expect(api.invoke).toHaveBeenCalledTimes(2)
  value = { ...value, summaryStatus: 'COMPLETED' }
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  expect(api.invoke).toHaveBeenCalledTimes(3)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(api.invoke).toHaveBeenCalledTimes(3)
  fail = true
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await act(async () => {})
  expect(screen.getByRole('alert').textContent).toBe(zh.knowledgeProcessingReadFailed)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(api.invoke).toHaveBeenCalledTimes(4)
})

it('discards revoked reads and cancels an outstanding read when the view closes', async () => {
  const denied = vi.fn()
  transport(async () => { throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Revoked', false) })
  const first = mount(false, denied)
  await screen.findByRole('alert')
  expect(denied).toHaveBeenCalledOnce()
  first.unmount()
  const deferred = Promise.withResolvers<unknown>()
  const api = transport(async () => deferred.promise)
  const second = mount()
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledOnce() })
  second.unmount()
  expect(api.cancel).toHaveBeenCalledOnce()
  await act(async () => { deferred.resolve(details()); await deferred.promise })
  expect(screen.queryByText('这是一份业务摘要。')).toBeNull()
})
