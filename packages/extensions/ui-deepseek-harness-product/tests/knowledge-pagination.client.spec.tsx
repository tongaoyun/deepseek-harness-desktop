// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { KnowledgeDocuments } from '../src/client/KnowledgeDocuments.tsx'
import { KnowledgeParsedContent } from '../src/client/KnowledgeParsedContent.tsx'
import { KnowledgeFolderPicker } from '../src/client/KnowledgeFolderPicker.tsx'
import { items, localDetail } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

type Browser = 'materials' | 'passages' | 'destination'
const t = (key: DeepSeekHarnessProductKey) => zh[key]
const updatedAt = '2026-11-09T00:00:00Z'
const resource = { id: 'document', knowledgeBaseId: 'base', filename: '资料 1.md', mediaType: 'text/markdown',
  sizeBytes: 100, status: 'READY', chunkCount: 1, updatedAt, sourceType: 'manual' }
const library = localDetail(items([{ id: 'base', name: '项目资料', scope: 'PERSONAL', canManage: false }])[0]!)

function Destination() {
  const [value, setValue] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  return <>
    <KnowledgeFolderPicker knowledgeBaseId="base" label={zh.knowledgeSaveDestination} value={value}
      onChange={setValue} onReady={setReady} disabled={false} pending={false} t={t} />
    <button type="button" disabled={!ready}>保存到此位置</button>
  </>
}

function response(browser: Browser, page: number, total = 61) {
  const values = browser === 'materials' ? [{ ...resource, filename: `资料 ${page}.md` }]
    : browser === 'passages' ? [{ id: `part-${page}`, documentId: resource.id, content: `正文 ${page}`, locator: '' }]
      : [{ id: `folder-${page}`, name: `目录 ${page}`, parentId: null, updatedAt }]
  return { items: values, page, size: 20, total }
}

function setup(browser: Browser, read: (page: number, payload: Record<string, unknown>) => Promise<unknown>) {
  const method = browser === 'materials' ? 'knowledge.documents.list'
    : browser === 'passages' ? 'knowledge.documents.read' : 'knowledge.folders.list'
  const invoke = vi.fn(async (_namespace: string, requested: string, payload: Record<string, unknown>) => ({
    ok: true,
    result: requested === method ? await read(Number(payload.page), payload)
      : requested === 'knowledge.folders.get' ? { id: payload.folderId, name: '子目录', parentId: null, updatedAt }
        : { items: [], page: payload.page ?? 1, size: 20, total: 0 },
  }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = browser === 'materials' ? render(<KnowledgeDocuments product={library} renderFactorySlot={() => null} t={t} />)
    : browser === 'passages' ? render(<KnowledgeParsedContent knowledgeBaseId="base" documentId={resource.id}
      ready refreshRevision={0} onAccessDenied={vi.fn()} t={t} />) : render(<Destination />)
  return { view, reads: () => invoke.mock.calls.filter(call => call[1] === method).map(call => call[2].page) }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['materials', 'passages', 'destination'] as const)('retains %s pagination and its confirmed total through a slow page and retry', async (browser) => {
  const pending = Promise.withResolvers<unknown>()
  let retrying = false
  const api = setup(browser, async page => page === 1 ? response(browser, page)
    : retrying ? response(browser, page, 41) : pending.promise)
  onTestFinished(() => { api.view.unmount(); pending.resolve(response(browser, 2)) })
  const next = await screen.findByRole<HTMLButtonElement>('button', { name: zh.nextPage })
  await waitFor(() => { expect(next.disabled).toBe(false) })
  const previous = screen.getByRole<HTMLButtonElement>('button', { name: zh.previousPage })
  const pagination = browser === 'destination' ? next.parentElement! : next.parentElement!.parentElement!
  next.focus()
  fireEvent.click(next)
  await waitFor(() => { expect(api.reads()).toEqual([1, 2]) })
  expect(screen.getByRole('button', { name: zh.nextPage })).toBe(next)
  expect(screen.getByRole('button', { name: zh.previousPage })).toBe(previous)
  expect(next.disabled).toBe(false)
  expect(previous.disabled).toBe(false)
  expect(next.getAttribute('aria-disabled')).toBe('true')
  expect(previous.getAttribute('aria-disabled')).toBe('true')
  expect(next.classList.contains('product-control-pending')).toBe(true)
  expect(pagination.textContent).toContain(browser === 'destination' ? '2 / 4' : zh.knowledgePageCount.replace('{page}', '2').replace('{pages}', '4'))
  expect(document.activeElement).toBe(next)
  expect({ pagination: pagination.textContent, nextUnavailable: next.getAttribute('aria-disabled'), previousUnavailable: previous.getAttribute('aria-disabled'),
    preservesAppearance: next.classList.contains('product-control-pending') }).toMatchSnapshot('Pending pagination')
  if (browser === 'destination') expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', true)
  await act(async () => { pending.reject(new Error('Offline')) })
  const notice = await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: zh.nextPage })).toBe(next)
  expect(pagination.textContent).toContain(browser === 'destination' ? '2 / 4' : zh.knowledgePageCount.replace('{page}', '2').replace('{pages}', '4'))
  expect(screen.queryByText('正文 1')).toBeNull()
  const retry = screen.getByRole('button', { name: zh.retry })
  retrying = true
  fireEvent.click(retry)
  await waitFor(() => { expect(api.reads()).toEqual([1, 2, 2]) })
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(notice.isConnected).toBe(false)
  expect(screen.getByRole('button', { name: zh.nextPage })).toBe(next)
  expect(pagination.textContent).toContain(browser === 'destination' ? '2 / 3' : zh.knowledgePageCount.replace('{page}', '2').replace('{pages}', '3'))
  expect(next.getAttribute('aria-disabled')).toBe('false')
})

it.each([false, true])('recovers removed material pagination focus when the library becomes empty (elsewhere: %s)', async (elsewhere) => {
  const pending = Promise.withResolvers<unknown>()
  let reads = 0
  const api = setup('materials', async page => ++reads === 1 ? response('materials', 1, 21)
    : page === 2 ? pending.promise : { items: [], page: 1, size: 20, total: 0 })
  onTestFinished(() => { api.view.unmount(); pending.resolve({ items: [], page: 2, size: 20, total: 0 }) })
  render(<button type="button">其他操作</button>)
  const next = await screen.findByRole('button', { name: zh.nextPage })
  next.focus(); fireEvent.click(next)
  await waitFor(() => { expect(api.reads()).toEqual([1, 2]) })
  const other = screen.getByRole('button', { name: '其他操作' })
  if (elsewhere) other.focus()
  await act(async () => { pending.resolve({ items: [], page: 2, size: 20, total: 0 }) })
  await screen.findByText(zh.knowledgeNoMaterials)
  expect(api.reads()).toEqual([1, 2, 1])
  expect(screen.queryByRole('button', { name: zh.nextPage })).toBeNull()
  expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('heading', { name: '项目资料', level: 1 }))
  expect({ focused: document.activeElement?.textContent, message: screen.getByText(zh.knowledgeNoMaterials).textContent,
    nextPageVisible: screen.queryByRole('button', { name: zh.nextPage }) !== null }).toMatchSnapshot('Empty library focus')
})

it.each(['materials', 'passages', 'destination'] as const)('clears %s pagination when its document, folder or filters change', async (browser) => {
  const pending = Promise.withResolvers<unknown>()
  let switched = false
  const api = setup(browser, async page => switched ? pending.promise : response(browser, page))
  onTestFinished(() => { api.view.unmount(); pending.resolve({ items: [], page: 1, size: 20, total: 0 }) })
  const next = await screen.findByRole<HTMLButtonElement>('button', { name: zh.nextPage })
  await waitFor(() => { expect(next.disabled).toBe(false) })
  switched = true
  if (browser === 'materials') {
    fireEvent.change(screen.getByRole('searchbox', { name: zh.knowledgeFindFiles }), { target: { value: '新范围' } })
    fireEvent.click(screen.getByRole('button', { name: zh.search }))
  } else if (browser === 'passages') {
    api.view.rerender(<KnowledgeParsedContent knowledgeBaseId="base" documentId="another-document"
      ready refreshRevision={0} onAccessDenied={vi.fn()} t={t} />)
  } else fireEvent.click(screen.getByRole('button', { name: '目录 1' }))
  await waitFor(() => { expect(api.reads()).toEqual([1, 1]) })
  expect(screen.queryByRole('button', { name: zh.nextPage })).toBeNull()
  expect(screen.queryByText(zh.itemCount.replace('{count}', '61'))).toBeNull()
})

it.each([
  ['materials', 'next'], ['materials', 'previous'], ['passages', 'next'], ['passages', 'previous'],
  ['destination', 'next'], ['destination', 'previous'],
] as const)('moves %s by one page when %s is clicked twice before rendering', async (browser, direction) => {
  const pending = Promise.withResolvers<unknown>()
  let waiting = false
  const api = setup(browser, async page => waiting ? pending.promise : response(browser, page))
  onTestFinished(() => { api.view.unmount(); pending.resolve(response(browser, direction === 'next' ? 2 : 1)) })
  const next = await screen.findByRole<HTMLButtonElement>('button', { name: zh.nextPage })
  await waitFor(() => { expect(next.disabled).toBe(false) })
  if (direction === 'previous') {
    fireEvent.click(next)
    await waitFor(() => { expect(screen.getByRole('button', { name: zh.previousPage }).getAttribute('aria-disabled')).toBe('false') })
  }
  waiting = true
  const button = screen.getByRole('button', { name: direction === 'next' ? zh.nextPage : zh.previousPage })
  act(() => { fireEvent.click(button); fireEvent.click(button) })
  await waitFor(() => { expect(api.reads()).toEqual(direction === 'next' ? [1, 2] : [1, 2, 1]) })
})

it.each(['materials', 'passages', 'destination'] as const)('retains %s focus at the first and last page and rejects boundary activation', async (browser) => {
  const pending = Promise.withResolvers<unknown>()
  let waiting = false
  const api = setup(browser, async page => waiting ? pending.promise : response(browser, page, 21))
  onTestFinished(() => { api.view.unmount(); pending.resolve(response(browser, 2, 21)) })
  const next = await screen.findByRole('button', { name: zh.nextPage })
  await waitFor(() => { expect(next.getAttribute('aria-disabled')).toBe('false') })
  const previous = screen.getByRole('button', { name: zh.previousPage })
  fireEvent.click(previous)
  expect(api.reads()).toEqual([1])
  waiting = true
  next.focus(); fireEvent.click(next)
  await waitFor(() => { expect(api.reads()).toEqual([1, 2]) })
  expect(next.classList.contains('product-control-pending')).toBe(true)
  expect(previous.classList.contains('product-control-pending')).toBe(false)
  act(() => { fireEvent.click(previous); fireEvent.click(next) })
  expect(api.reads()).toEqual([1, 2])
  await act(async () => { pending.resolve(response(browser, 2, 21)); await pending.promise })
  expect(document.activeElement).toBe(next)
  expect(next.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(next)
  expect(api.reads()).toEqual([1, 2])
  waiting = false
  previous.focus(); fireEvent.click(previous)
  await waitFor(() => { expect(api.reads()).toEqual([1, 2, 1]) })
  await waitFor(() => { expect(previous.getAttribute('aria-disabled')).toBe('true') })
  expect(document.activeElement).toBe(previous)
  expect(screen.getByRole('button', { name: zh.previousPage })).toBe(previous)
  fireEvent.click(previous)
  expect(api.reads()).toEqual([1, 2, 1])
})

it.each(['materials', 'passages', 'destination'] as const)('keeps one %s page change when opposite controls are activated before rendering', async (browser) => {
  const pending = Promise.withResolvers<unknown>()
  let waiting = false
  const api = setup(browser, async page => waiting ? pending.promise : response(browser, page))
  onTestFinished(() => { api.view.unmount(); pending.resolve(response(browser, 3)) })
  const next = await screen.findByRole('button', { name: zh.nextPage })
  fireEvent.click(next)
  const previous = screen.getByRole('button', { name: zh.previousPage })
  await waitFor(() => { expect(previous.getAttribute('aria-disabled')).toBe('false') })
  waiting = true
  act(() => { fireEvent.click(next); fireEvent.click(previous) })
  await waitFor(() => { expect(api.reads()).toEqual([1, 2, 3]) })
})
