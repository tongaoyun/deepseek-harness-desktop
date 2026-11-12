// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import { KnowledgeContentSearch } from '../src/client/KnowledgeContentSearch.tsx'
import { KnowledgeParsedContent } from '../src/client/KnowledgeParsedContent.tsx'
import { KnowledgeBaseEditor } from '../src/client/KnowledgeBaseEditor.tsx'
import { en, zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

const t = (key: DeepSeekHarnessProductKey) => zh[key]
const english = (key: DeepSeekHarnessProductKey) => en[key]
const baseline = { id: 'base', name: '业务资料', description: '原简介', canManage: true, updatedAt: '2026-11-05T00:00:00Z' }
const hit = { sourceId: 'source', knowledgeBaseId: 'base', documentId: 'doc', filename: '中文资料.md', locator: '第 2 页', content: '校验订单金额。' }
function transport(handler: (method: string, payload: Record<string, unknown>) => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: Record<string, unknown>) => (
    { ok: true, result: await handler(method, payload) }))
  const cancel = vi.fn()
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return { invoke, cancel }
}
function mountSearch(onAccessDenied = vi.fn()) {
  return render(<KnowledgeContentSearch knowledgeBaseId="base" refreshRevision={0} renderFactorySlot={() => null}
    onBack={vi.fn()} onAccessDenied={onAccessDenied} t={t} />)
}
function submit(query = '订单') {
  fireEvent.change(screen.getByRole('searchbox', { name: zh.knowledgeContentSearch }), { target: { value: query } })
  fireEvent.click(screen.getByRole('button', { name: zh.search }))
}
function mountParsed(ready = true, denied = vi.fn()) {
  return render(<KnowledgeParsedContent knowledgeBaseId="base" documentId="doc" ready={ready} refreshRevision={0} onAccessDenied={denied} t={t} />)
}
afterEach(() => { cleanup(); sessionStorage.clear(); vi.unstubAllGlobals() })

it.each(['search', 'passages', 'library'] as const)('retains the %s read error and retry while waiting for a confirmed result', async (kind) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const api = transport(async () => { if (++reads === 1) throw new Error('Offline'); return response.promise })
  const value = kind === 'search' ? [hit] : kind === 'library' ? baseline
    : { items: [{ id: 'fragment', documentId: 'doc', content: '恢复的解析正文', locator: '' }], page: 1, size: 20, total: 1 }
  const view = kind === 'search' ? mountSearch() : kind === 'passages' ? mountParsed()
    : render(<KnowledgeBaseEditor knowledgeBaseId="base" onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  onTestFinished(() => { view.unmount(); response.resolve(value) })
  if (kind === 'search') submit()
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
  fireEvent.click(retry)
  expect(api.invoke).toHaveBeenCalledTimes(2)
  expect({ message: notice.textContent, action: retry.textContent,
    loadingIndicator: screen.queryByRole('status', { name: zh.loading }) !== null }).toMatchSnapshot('Pending read retry')
  await act(async () => { response.resolve(value) })
  expect(screen.queryByRole('alert')).toBeNull()
  if (kind === 'search') {
    expect(await screen.findByRole('button', { name: /中文资料.md/ })).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    expect(document.activeElement).toMatchSnapshot('Recovered read focus')
  } else if (kind === 'passages') {
    expect(await screen.findByText('恢复的解析正文')).toBeDefined()
    expect(document.activeElement).toBe(screen.getByRole('region', { name: zh.knowledgeParsedContent }))
    expect(document.activeElement).toMatchSnapshot('Recovered read focus')
  } else expect(await screen.findByRole('textbox', { name: zh.knowledgeBaseName })).toHaveProperty('value', baseline.name)
})

it.each(['search', 'passages'] as const)('keeps focus outside the %s retry when its result arrives', async (kind) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  transport(async () => { if (++reads === 1) throw new Error('Offline'); return response.promise })
  const value = kind === 'search' ? [hit]
    : { items: [{ id: 'fragment', documentId: 'doc', content: '恢复的解析正文', locator: '' }], page: 1, size: 20, total: 1 }
  const view = kind === 'search' ? mountSearch() : mountParsed()
  onTestFinished(() => { view.unmount(); response.resolve(value) })
  if (kind === 'search') submit()
  const retry = await screen.findByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus(); fireEvent.click(retry)
  render(<button type="button">其他操作</button>)
  const other = screen.getByRole('button', { name: '其他操作' })
  other.focus()
  await act(async () => { response.resolve(value) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(other)
})

it.each(['confirmed', 'revoked'] as const)('retains indexed passages during a same-page refresh until %s', async (outcome) => {
  const response = Promise.withResolvers<unknown>()
  let refreshing = false
  const passage = { id: 'fragment', documentId: 'doc', content: '保留资料正文', locator: '第 1 页' }
  transport(async () => refreshing ? response.promise : { items: [passage], page: 1, size: 20, total: 1 })
  const denied = vi.fn()
  const props = { knowledgeBaseId: 'base', documentId: 'doc', ready: true, onAccessDenied: denied, t }
  const view = render(<KnowledgeParsedContent {...props} refreshRevision={0} />)
  const body = await screen.findByText(passage.content)
  const article = body.closest('article')
  refreshing = true
  view.rerender(<KnowledgeParsedContent {...props} refreshRevision={1} />)
  expect(screen.getByText(passage.content)).toBe(body)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  if (outcome === 'confirmed') {
    await act(async () => { response.resolve({ items: [{ ...passage, content: '更新资料正文' }], page: 1, size: 20, total: 1 }) })
    expect((await screen.findByText('更新资料正文')).closest('article')).toBe(article)
    expect(denied).not.toHaveBeenCalled()
  } else {
    await act(async () => { response.reject(new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Revoked', false)) })
    expect(screen.queryByText(passage.content)).toBeNull()
    expect(denied).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert')).toBeDefined()
  }
})

it.each(['removed', 'retained', 'empty', 'failed', 'elsewhere'] as const)(
  'keeps indexed-passage focus through a same-page refresh until %s', async (outcome) => {
    const response = Promise.withResolvers<unknown>()
    let reads = 0
    const passage = { id: 'fragment', documentId: 'doc', content: '[阅读链接](https://example.com/reference)', locator: '第 1 页' }
    const otherPassage = { ...passage, id: 'another-fragment', content: '其他片段' }
    const page = { items: [passage, otherPassage], page: 1, size: 20, total: 2 }
    transport(async () => ++reads === 1 ? page : response.promise)
    const props = { knowledgeBaseId: 'base', documentId: 'doc', ready: true, onAccessDenied: vi.fn(), t }
    const content = (revision: number) => <><KnowledgeParsedContent {...props} refreshRevision={revision} />
      <button type="button">其他操作</button></>
    const view = render(content(0))
    onTestFinished(() => { view.unmount(); response.resolve(page) })
    const link = await screen.findByRole('link', { name: '阅读链接' })
    link.focus()
    view.rerender(content(1))
    await waitFor(() => { expect(reads).toBe(2) })
    expect(screen.getByRole('link', { name: '阅读链接' })).toBe(link)
    const other = screen.getByRole('button', { name: '其他操作' })
    if (outcome === 'elsewhere') other.focus()
    await act(async () => {
      if (outcome === 'failed') response.reject(new Error('Offline'))
      else response.resolve({ ...page, items: outcome === 'retained' ? [otherPassage, passage]
        : outcome === 'empty' ? [] : [{ ...otherPassage, content: '更新后的正文' }], total: outcome === 'empty' ? 0 : 2 })
    })
    if (outcome === 'retained') expect(screen.getByRole('link', { name: '阅读链接' })).toBe(link)
    else expect(screen.queryByRole('link', { name: '阅读链接' })).toBeNull()
    expect(document.activeElement).toBe(outcome === 'elsewhere' ? other : outcome === 'retained' ? link
      : screen.getByRole('region', { name: zh.knowledgeParsedContent }))
    expect({ focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent,
      linkRetained: link.isConnected, error: screen.queryByRole('alert')?.textContent }).toMatchSnapshot('Confirmed passage focus')
  },
)

it.each([false, true])('recovers focus when a smaller indexed total removes pagination (focus elsewhere: %s)', async (elsewhere) => {
  const response = Promise.withResolvers<unknown>()
  const requests: unknown[] = []
  transport(async (_method, payload) => {
    requests.push(payload.page)
    if (requests.length === 1) return { items: [{ id: 'fragment', documentId: 'doc', content: '原正文', locator: '' }], page: 1, size: 20, total: 21 }
    return payload.page === 2 ? response.promise
      : { items: [{ id: 'fragment', documentId: 'doc', content: '缩减后的正文', locator: '' }], page: 1, size: 20, total: 1 }
  })
  const view = mountParsed()
  onTestFinished(() => { view.unmount(); response.resolve({ items: [], page: 2, size: 20, total: 1 }) })
  render(<button type="button">其他操作</button>)
  const next = await screen.findByRole('button', { name: zh.nextPage })
  next.focus(); fireEvent.click(next)
  await waitFor(() => { expect(requests).toEqual([1, 2]) })
  const other = screen.getByRole('button', { name: '其他操作' })
  if (elsewhere) other.focus()
  await act(async () => { response.resolve({ items: [], page: 2, size: 20, total: 1 }) })
  await screen.findByText('缩减后的正文')
  expect(screen.queryByRole('button', { name: zh.nextPage })).toBeNull()
  expect(requests).toEqual([1, 2, 1])
  expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('region', { name: zh.knowledgeParsedContent }))
  expect({ focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent,
    paginationVisible: screen.queryByRole('button', { name: zh.nextPage }) !== null }).toMatchSnapshot('Reduced total focus')
})

it('preserves library edits and a pending save across language changes', async () => {
  const write = Promise.withResolvers<unknown>()
  const api = transport(async method => method === 'knowledge.bases.get' ? baseline : write.promise)
  const props = { knowledgeBaseId: 'base', onClose: vi.fn(), onSaved: vi.fn() }
  const view = render(<KnowledgeBaseEditor {...props} t={t} />)
  const name = await screen.findByRole<HTMLInputElement>('textbox', { name: zh.knowledgeBaseName })
  fireEvent.change(name, { target: { value: '待保存名称' } })
  view.rerender(<KnowledgeBaseEditor {...props} t={english} />)
  expect((await screen.findByRole<HTMLInputElement>('textbox', { name: en.knowledgeBaseName }))).toBe(name)
  expect(name.value).toBe('待保存名称')
  fireEvent.click(screen.getByRole('button', { name: en.knowledgeSave }))
  await waitFor(() => { expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.bases.update')).toHaveLength(1) })
  view.rerender(<KnowledgeBaseEditor {...props} t={t} />)
  expect(screen.getByRole('textbox', { name: zh.knowledgeBaseName })).toBe(name)
  expect(name.disabled).toBe(true)
  await act(async () => { write.resolve({ ...baseline, name: '待保存名称', updatedAt: '2026-11-05T00:01:00Z' }); await write.promise })
  await waitFor(() => { expect(props.onSaved).toHaveBeenCalledWith('base') })
  expect(api.cancel).not.toHaveBeenCalled()
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.bases.get')).toHaveLength(1)
})

it('keeps a library baseline read alive and localizes its failure in the current language', async () => {
  const read = Promise.withResolvers<unknown>()
  const api = transport(async () => read.promise)
  const props = { knowledgeBaseId: 'base', onClose: vi.fn(), onSaved: vi.fn() }
  const view = render(<KnowledgeBaseEditor {...props} t={t} />)
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledOnce() })
  view.rerender(<KnowledgeBaseEditor {...props} t={english} />)
  await act(async () => { read.reject(new Error('Offline')); await read.promise.catch(() => undefined) })
  expect((await screen.findByRole('alert')).textContent).toBe(en.knowledgeBaseReadFailed)
  expect(api.invoke).toHaveBeenCalledOnce()
  expect(api.cancel).not.toHaveBeenCalled()
})

it.each(['METHOD_NOT_ALLOWED', 'NOT_FOUND'])('explains an unavailable library endpoint and permits retry after a server update (%s)', async (code) => {
  let available = false
  const api = transport(async () => {
    if (!available) throw new ProductError(code, 'Private server route diagnostic')
    return baseline
  })
  render(<KnowledgeBaseEditor knowledgeBaseId="base" onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  expect((await screen.findByRole('alert')).textContent).toBe(`${zh.serverFeatureUnavailable} (${code})`)
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByText('Private server route diagnostic')).toBeNull()
  expect(screen.getByRole('dialog')).toMatchSnapshot()
  available = true
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus(); fireEvent.click(retry)
  expect((await screen.findByRole<HTMLInputElement>('textbox', { name: zh.knowledgeBaseName })).value).toBe(baseline.name)
  expect(document.activeElement).toBe(screen.getByRole('form', { name: zh.knowledgeEditBase }))
  expect(api.invoke).toHaveBeenCalledTimes(2)
  expect(api.invoke.mock.calls.every(call => call[1] === 'knowledge.bases.get')).toBe(true)
})

it('keeps an indexed-content read alive and relocalizes its error without repeating the request', async () => {
  const read = Promise.withResolvers<unknown>()
  const api = transport(async () => read.promise)
  const props = { knowledgeBaseId: 'base', documentId: 'doc', ready: true, refreshRevision: 0, onAccessDenied: vi.fn() }
  const view = render(<KnowledgeParsedContent {...props} t={t} />)
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledOnce() })
  view.rerender(<KnowledgeParsedContent {...props} t={english} />)
  await act(async () => { read.reject(new Error('Offline')); await read.promise.catch(() => undefined) })
  expect((await screen.findByRole('alert')).textContent).toContain(en.knowledgeReadFailed)
  view.rerender(<KnowledgeParsedContent {...props} t={t} />)
  expect(screen.getByRole('alert').textContent).toContain(zh.knowledgeReadFailed)
  expect(api.invoke).toHaveBeenCalledOnce()
  expect(api.cancel).not.toHaveBeenCalled()
})

it('keeps a body search alive and reports its failure in the selected language', async () => {
  const read = Promise.withResolvers<unknown>()
  const api = transport(async () => read.promise)
  const props = { knowledgeBaseId: 'base', refreshRevision: 0, renderFactorySlot: () => null,
    onBack: vi.fn(), onAccessDenied: vi.fn() }
  const view = render(<KnowledgeContentSearch {...props} t={t} />)
  submit()
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledOnce() })
  view.rerender(<KnowledgeContentSearch {...props} t={english} />)
  await act(async () => { read.reject(new Error('Offline')); await read.promise.catch(() => undefined) })
  expect((await screen.findByRole('alert')).textContent).toContain(en.knowledgeSearchFailed)
  view.rerender(<KnowledgeContentSearch {...props} t={t} />)
  expect(screen.getByRole('alert').textContent).toContain(zh.knowledgeSearchFailed)
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('订单')
  expect(api.invoke).toHaveBeenCalledOnce()
  expect(api.cancel).not.toHaveBeenCalled()
})

it('shares an active body search across repeated form submissions and permits a later search', async () => {
  const read = Promise.withResolvers<unknown>()
  const api = transport(async () => read.promise)
  mountSearch()
  const search = screen.getByRole<HTMLButtonElement>('button', { name: zh.search })
  expect(search.disabled).toBe(true)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '订单' } })
  search.focus()
  act(() => { search.click(); search.click() })
  expect(document.activeElement).toBe(search)
  expect(search.disabled).toBe(false)
  expect(search.getAttribute('aria-disabled')).toBe('true')
  expect(search.getAttribute('aria-busy')).toBe('true')
  const input = screen.getByRole('searchbox')
  const form = input.closest('form')!
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledOnce() })
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(api.invoke).toHaveBeenCalledOnce()
  expect(api.cancel).not.toHaveBeenCalled()
  await act(async () => { read.resolve([hit]) })
  await screen.findByRole('button', { name: /中文资料.md/ })
  fireEvent.submit(form)
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledTimes(2) })
  expect(api.cancel).not.toHaveBeenCalled()
})

it.each(['confirmed', 'reordered', 'replaced', 'empty', 'failed', 'revoked'] as const)('retains results and focus while repeating the same body search until %s', async (outcome) => {
  const response = Promise.withResolvers<unknown>()
  let refreshing = false
  const other = { ...hit, sourceId: 'other-source', filename: '另一份资料.md' }
  transport(async () => refreshing ? response.promise : outcome === 'reordered' ? [hit, other] : [hit])
  const denied = vi.fn()
  mountSearch(denied); submit()
  const result = await screen.findByRole('button', { name: /中文资料.md/ })
  result.focus()
  refreshing = true
  fireEvent.submit(screen.getByRole('searchbox').closest('form')!)
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(result)
  expect(document.activeElement).toBe(result)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  const search = screen.getByRole<HTMLButtonElement>('button', { name: zh.search })
  expect(search.disabled).toBe(false)
  expect(search.getAttribute('aria-disabled')).toBe('true')
  expect(search.classList.contains('product-control-pending')).toBe(true)
  await act(async () => {
    if (outcome === 'revoked') response.reject(new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Revoked', false))
    else if (outcome === 'failed') response.reject(new Error('Offline'))
    else if (outcome === 'reordered') response.resolve([other, { ...hit, content: '更新后的检索片段' }])
    else response.resolve(outcome === 'empty' ? [] : [{ ...hit, content: '更新后的检索片段',
      ...outcome === 'replaced' ? { sourceId: 'new-source', filename: '替换资料.md' } : {} }])
  })
  if (outcome === 'confirmed' || outcome === 'reordered') {
    expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(result)
    expect(screen.getByText('更新后的检索片段')).not.toBeNull()
    expect(document.activeElement).toBe(result)
  } else {
    expect(screen.queryByRole('button', { name: /中文资料.md/ })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('searchbox'))
    if (outcome === 'replaced') expect(screen.getByRole('button', { name: /替换资料.md/ })).toBeDefined()
    else if (outcome === 'empty') expect(screen.getByText(zh.knowledgeContentSearchEmpty)).not.toBeNull()
    else expect(screen.getByRole('alert')).not.toBeNull()
  }
  expect(denied).toHaveBeenCalledTimes(outcome === 'revoked' ? 1 : 0)
})

it('retains an empty-result message while repeating a body search', async () => {
  const response = Promise.withResolvers<unknown>()
  let refreshing = false
  transport(async () => refreshing ? response.promise : [])
  mountSearch(); submit()
  const empty = await screen.findByText(zh.knowledgeContentSearchEmpty)
  refreshing = true
  fireEvent.submit(screen.getByRole('searchbox').closest('form')!)
  expect(screen.getByText(zh.knowledgeContentSearchEmpty)).toBe(empty)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  await act(async () => { response.resolve([]) })
  expect(screen.getByText(zh.knowledgeContentSearchEmpty)).toBe(empty)
})

it('keeps a newer body search pending when a cancelled request settles late', async () => {
  const first = Promise.withResolvers<unknown>()
  const next = Promise.withResolvers<unknown>()
  let reads = 0
  const api = transport(async () => ++reads === 1 ? first.promise : next.promise)
  mountSearch(); submit()
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledOnce() })
  submit('新查询')
  await waitFor(() => { expect(api.invoke).toHaveBeenCalledTimes(2) })
  await act(async () => { first.resolve([hit]) })
  fireEvent.submit(screen.getByRole('searchbox').closest('form')!)
  expect(api.invoke).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('button', { name: zh.search }).getAttribute('aria-disabled')).toBe('true')
  await act(async () => { next.resolve([{ ...hit, sourceId: 'new-source', filename: '新查询资料.md' }]) })
  expect(await screen.findByRole('button', { name: /新查询资料.md/ })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /中文资料.md/ })).toBeNull()
})

it('edits authorized library details against the latest baseline and retains the original write after a lost reply', async () => {
  let lost = true
  const saved = vi.fn()
  const api = transport(async (method, payload) => {
    if (method === 'knowledge.bases.get') return baseline
    if (lost) throw new Error('Response lost')
    return { ...baseline, name: payload.name, description: payload.description, updatedAt: '2026-11-05T00:01:00Z' }
  })
  render(<KnowledgeBaseEditor knowledgeBaseId="base" onClose={vi.fn()} onSaved={saved} t={t} />)
  const name = await screen.findByRole<HTMLInputElement>('textbox', { name: zh.knowledgeBaseName })
  const description = screen.getByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeBaseDescription })
  expect(name.value).toBe(baseline.name); expect(description.value).toBe(baseline.description)
  fireEvent.change(name, { target: { value: '新名称' } }); fireEvent.change(description, { target: { value: '新简介' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await screen.findByRole('alert')
  expect(name.disabled).toBe(true); expect(description.disabled).toBe(true)
  lost = false
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeRetrySave }))
  await waitFor(() => { expect(saved).toHaveBeenCalledWith('base') })
  const writes = api.invoke.mock.calls.filter(call => call[1] === 'knowledge.bases.update')
  expect(writes).toHaveLength(2)
  expect(writes[0]?.[2]).toEqual(writes[1]?.[2])
  expect(writes[0]?.[2]).toMatchObject({ knowledgeBaseId: 'base', name: '新名称', description: '新简介', expectedUpdatedAt: baseline.updatedAt })
})

it.each([{ ...baseline, id: 'other' }, { ...baseline, canManage: false }, { ...baseline, updatedAt: '' }])('does not expose editing for an invalid or unauthorized baseline %j', async (value) => {
  transport(async () => value)
  render(<KnowledgeBaseEditor knowledgeBaseId="base" onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  await screen.findByRole('alert')
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('searches only the selected library and reauthorizes a result before reading its passage', async () => {
  const api = transport(async method => method === 'knowledge.search' ? [hit] : hit)
  mountSearch(); submit()
  const input = screen.getByRole<HTMLInputElement>('searchbox')
  const result = await screen.findByRole('button', { name: /中文资料.md/ })
  result.focus()
  fireEvent.click(result)
  await screen.findByRole('button', { name: zh.knowledgeReadFullDocument })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.knowledgeBackToSearch }))
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /中文资料.md/ })).toBeNull()
  expect(api.invoke.mock.calls.find(call => call[1] === 'knowledge.search')?.[2]).toEqual({
    query: '订单', knowledgeBaseIds: ['base'], knowledgeBaseRefs: [], restrictToKnowledgeBaseRefs: true, limit: 12,
  })
  expect(api.invoke.mock.calls.find(call => call[1] === 'knowledge.sources.read')?.[2]).toEqual({ sourceId: 'source' })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeBackToSearch }))
  expect(screen.getByRole('searchbox')).toBe(input)
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('订单')
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(result)
  expect(document.activeElement).toBe(result)
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.search')).toHaveLength(1)
  expect({ query: input.value, focusedResult: document.activeElement?.textContent,
    searchPreserved: screen.getByRole('searchbox') === input, resultPreserved: screen.getByRole('button', { name: /中文资料.md/ }) === result,
  }).toMatchSnapshot('Returned content search')
})

it.each([false, true])('keeps the selected source through directory refresh without moving focus (elsewhere=%s)', async (elsewhere) => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const api = transport(async method => method === 'knowledge.search' ? [hit] : ++reads === 1 ? hit : response.promise)
  const props = { knowledgeBaseId: 'base', renderFactorySlot: () => null, onBack: vi.fn(), onAccessDenied: vi.fn(), t }
  const content = (revision: number) => <><KnowledgeContentSearch {...props} refreshRevision={revision} />
    <button type="button">其他操作</button></>
  const view = render(content(0))
  onTestFinished(() => { view.unmount(); response.resolve(hit) })
  submit()
  const result = await screen.findByRole<HTMLButtonElement>('button', { name: /中文资料.md/ })
  result.focus(); fireEvent.click(result)
  const original = await screen.findByRole('button', { name: zh.knowledgeReadFullDocument })
  const back = screen.getByRole('button', { name: zh.knowledgeBackToSearch })
  const other = screen.getByRole('button', { name: '其他操作' })
  if (elsewhere) other.focus()
  view.rerender(content(1))
  await waitFor(() => { expect(reads).toBe(2) })
  expect(screen.getByRole('button', { name: zh.knowledgeReadFullDocument })).toBe(original)
  expect(screen.queryByRole('searchbox')).toBeNull()
  expect(document.activeElement).toBe(elsewhere ? other : back)
  await act(async () => { response.resolve({ ...hit, content: '复核后的正文' }) })
  expect(await screen.findByText('复核后的正文')).toBeDefined()
  expect(document.activeElement).toBe(elsewhere ? other : back)
  fireEvent.click(back)
  expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(result)
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('订单')
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.search')).toHaveLength(2)
  expect({ query: screen.getByRole<HTMLInputElement>('searchbox').value, sourceReads: reads,
    retainedResult: screen.getByRole('button', { name: /中文资料.md/ }) === result }).toMatchSnapshot('Refreshed content reader')
})

it.each(['same', 'replaced', 'empty', 'failed', 'revoked'] as const)(
  'revalidates submitted content results in place after directory refresh until %s', async (outcome) => {
    const response = Promise.withResolvers<unknown>()
    let reads = 0
    const api = transport(async () => ++reads === 1 ? [hit] : response.promise)
    const denied = vi.fn()
    const props = { knowledgeBaseId: 'base', renderFactorySlot: () => null, onBack: vi.fn(), onAccessDenied: denied, t }
    const view = render(<KnowledgeContentSearch {...props} refreshRevision={0} />)
    onTestFinished(() => { view.unmount(); response.resolve([]) })
    submit()
    const result = await screen.findByRole<HTMLButtonElement>('button', { name: /中文资料.md/ })
    const input = screen.getByRole('searchbox')
    result.focus()
    view.rerender(<KnowledgeContentSearch {...props} refreshRevision={1} />)
    await waitFor(() => { expect(reads).toBe(2) })
    expect(screen.getByRole('button', { name: /中文资料.md/ })).toBe(result)
    expect(screen.getByRole('searchbox')).toBe(input)
    expect(document.activeElement).toBe(result)
    expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.search }))
    expect(reads).toBe(2)
    await act(async () => {
      if (outcome === 'failed') response.reject(new Error('Search temporarily unavailable'))
      else if (outcome === 'revoked') response.reject(new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Revoked', false))
      else response.resolve(outcome === 'same' ? [{ ...hit, content: '复核后的检索片段' }]
        : outcome === 'empty' ? [] : [{ ...hit, sourceId: 'new-source', filename: '新资料.md' }])
    })
    expect(document.activeElement).toBe(outcome === 'same' ? result : input)
    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('订单')
    expect(denied).toHaveBeenCalledTimes(outcome === 'revoked' ? 1 : 0)
    expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.search')).toHaveLength(2)
    expect({ results: screen.queryAllByRole('button', { name: /资料.md/ }).map(button => button.textContent),
      error: screen.queryByRole('alert')?.textContent, retainedFocus: document.activeElement === result })
      .toMatchSnapshot('Revalidated search results')
  },
)

it('does not submit an edited query on directory refresh', async () => {
  const api = transport(async () => [hit])
  const props = { knowledgeBaseId: 'base', renderFactorySlot: () => null, onBack: vi.fn(), onAccessDenied: vi.fn(), t }
  const view = render(<KnowledgeContentSearch {...props} refreshRevision={0} />)
  submit()
  await screen.findByRole('button', { name: /中文资料.md/ })
  const input = screen.getByRole<HTMLInputElement>('searchbox')
  input.focus()
  fireEvent.change(input, { target: { value: '未提交的新问题' } })
  view.rerender(<KnowledgeContentSearch {...props} refreshRevision={1} />)
  expect(input.value).toBe('未提交的新问题')
  expect(document.activeElement).toBe(input)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  expect(api.invoke).toHaveBeenCalledOnce()
})

it('cancels a background content refresh when the user submits another query', async () => {
  const response = Promise.withResolvers<unknown>()
  let reads = 0
  const api = transport(async () => ++reads === 2 ? response.promise : reads === 1 ? [hit] : [])
  const props = { knowledgeBaseId: 'base', renderFactorySlot: () => null, onBack: vi.fn(), onAccessDenied: vi.fn(), t }
  const view = render(<KnowledgeContentSearch {...props} refreshRevision={0} />)
  onTestFinished(() => { view.unmount(); response.resolve([hit]) })
  submit()
  await screen.findByRole('button', { name: /中文资料.md/ })
  view.rerender(<KnowledgeContentSearch {...props} refreshRevision={1} />)
  await waitFor(() => { expect(reads).toBe(2) })
  submit('新问题')
  await screen.findByText(zh.knowledgeContentSearchEmpty)
  await act(async () => { response.resolve([hit]) })
  expect(screen.queryByRole('button', { name: /中文资料.md/ })).toBeNull()
  expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('新问题')
  expect(api.cancel).toHaveBeenCalledOnce()
  expect(api.invoke.mock.calls.filter(call => call[1] === 'knowledge.search').map(call => call[2].query)).toEqual(['订单', '订单', '新问题'])
})

it('rejects an entire search result containing a passage from another library', async () => {
  transport(async () => [hit, { ...hit, sourceId: 'foreign', knowledgeBaseId: 'other' }])
  mountSearch(); submit()
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: /中文资料.md/ })).toBeNull()
})

it('cancels a superseded query and ignores its late response', async () => {
  let finish!: (value: unknown) => void
  const api = transport(async () => new Promise((resolve) => { finish = resolve }))
  mountSearch(); submit()
  await waitFor(() => { expect(api.invoke).toHaveBeenCalled() })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '新查询' } })
  finish([hit])
  await waitFor(() => { expect(api.cancel).toHaveBeenCalled() })
  expect(screen.queryByRole('button', { name: /中文资料.md/ })).toBeNull()
})

it('removes search content after authoritative access revocation', async () => {
  const denied = vi.fn()
  transport(async () => { throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Revoked') })
  mountSearch(denied); submit()
  await screen.findByRole('alert')
  expect(denied).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: /中文资料.md/ })).toBeNull()
})

it('reads indexed passages page by page without fetching original files', async () => {
  const api = transport(async (_method, payload) => ({ items: [{ id: `part-${String(payload.page)}`, documentId: 'doc',
    content: `中文片段 ${String(payload.page)}`, locator: '位置' }], page: payload.page, size: 20, total: 21 }))
  mountParsed()
  await screen.findByText('中文片段 1')
  fireEvent.click(screen.getByRole('button', { name: zh.nextPage }))
  await screen.findByText('中文片段 2')
  expect(screen.queryByText('中文片段 1')).toBeNull()
  expect(api.invoke.mock.calls.map(call => call[1])).toEqual(['knowledge.documents.read', 'knowledge.documents.read'])
  expect(api.invoke.mock.calls[1]?.[2]).toEqual({ knowledgeBaseId: 'base', documentId: 'doc', page: 2, size: 20 })
})

it('does not request indexed passages before processing is complete', async () => {
  const api = transport(async () => ({}))
  mountParsed(false)
  expect(screen.getByText(zh.knowledgeContentNotReady)).toBeTruthy()
  expect(api.invoke).not.toHaveBeenCalled()
})

it.each([{ id: 'part', documentId: 'foreign', content: '外部内容', locator: '' }, { id: '', documentId: 'doc', content: '损坏内容', locator: '' }])('rejects mismatched indexed passages %j', async (value) => {
  transport(async () => ({ items: [value], page: 1, size: 20, total: 1 }))
  mountParsed(); await screen.findByRole('alert')
  expect(screen.queryByText(value.content)).toBeNull()
})

it('blocks a suspended library update whose stored resource differs from the editor', async () => {
  sessionStorage.setItem('product.knowledge.suspended.v1.employee.library-update:base', JSON.stringify({
    title: 'Wrong library', content: '', url: '', parentId: null,
    save: { method: 'knowledge.bases.update', payload: { knowledgeBaseId: 'other', name: 'Wrong library', description: '',
      expectedUpdatedAt: baseline.updatedAt, operationId: 'stored-operation-123' } },
  }))
  const api = transport(async method => method === 'auth.getSession' ? { authenticated: true, employeeId: 'employee' } : baseline)
  render(<KnowledgeBaseEditor knowledgeBaseId="base" onClose={vi.fn()} onSaved={vi.fn()} t={t} />)
  await screen.findByRole('alert')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(api.invoke.mock.calls.some(call => call[1] === 'knowledge.bases.update')).toBe(false)
})

it('never confirms an update whose receipt has different details', async () => {
  const saved = vi.fn()
  transport(async method => method === 'knowledge.bases.get' ? baseline : { ...baseline, name: 'Unexpected name' })
  render(<KnowledgeBaseEditor knowledgeBaseId="base" onClose={vi.fn()} onSaved={saved} t={t} />)
  const name = await screen.findByRole<HTMLInputElement>('textbox', { name: zh.knowledgeBaseName })
  fireEvent.change(name, { target: { value: 'Submitted name' } })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await screen.findByRole('alert')
  expect(name.disabled).toBe(true)
  expect(saved).not.toHaveBeenCalled()
})
