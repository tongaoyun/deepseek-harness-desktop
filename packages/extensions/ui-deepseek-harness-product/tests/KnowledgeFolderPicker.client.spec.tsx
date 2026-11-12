// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { ProductError } from '@deepseek-harness/product/errors'
import css from '../src/DeepSeekHarnessProduct.module.css'
import { KnowledgeEditor } from '../src/client/KnowledgeEditor.tsx'
import { KnowledgeFolderPicker } from '../src/client/KnowledgeFolderPicker.tsx'
import { zh } from '../src/locales.ts'

const folder = { id: 'destination', parentId: null, name: '项目资料', updatedAt: '2026-11-08T00:00:00Z' }
const t = (key: keyof typeof zh) => zh[key]
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function Destination({ value = null }: { value?: string | null }) {
  const [ready, setReady] = useState(false)
  return <>
    <KnowledgeFolderPicker knowledgeBaseId="personal" label={zh.knowledgeSaveDestination} value={value}
      disabled={false} pending={false} onChange={vi.fn()} onReady={setReady} t={t} />
    <button type="button" disabled={!ready}>保存到此位置</button>
  </>
}

function NavigableDestination({ initial, onNavigate }: { initial: string | null; onNavigate: (id: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const [ready, setReady] = useState(false)
  return <>
    <input aria-label="草稿名称" defaultValue="保留的资料" />
    <KnowledgeFolderPicker knowledgeBaseId="personal" label={zh.knowledgeSaveDestination} value={value}
      disabled={false} pending={false} onChange={(id) => { onNavigate(id); setValue(id) }} onReady={setReady} t={t} />
    <button type="button" disabled={!ready}>保存到此位置</button>
  </>
}

it.each((['child', 'ancestor', 'root'] as const).flatMap(navigation => [false, true].map(elsewhere => ({ navigation, elsewhere }))))(
  'keeps destination navigation focus while reading $navigation (elsewhere: $elsewhere)', async ({ navigation, elsewhere }) => {
    const nested = { ...folder, id: 'quarter', parentId: folder.id, name: '季度资料' }
    const response = Promise.withResolvers<unknown>()
    const target = navigation === 'root' ? null : folder.id
    const items = target === null ? [folder] : [nested]
    const page = { items, total: items.length, page: 1, size: 20 }
    let navigating = false
    const invoke = vi.fn(async (_namespace: string, method: string, payload: { folderId?: string }) => ({ ok: true,
      result: method === 'knowledge.folders.get' ? payload.folderId === folder.id ? folder : nested
        : navigating ? await response.promise
          : { items: navigation === 'child' ? [folder] : [], total: navigation === 'child' ? 1 : 0, page: 1, size: 20 },
    }))
    vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
    const onNavigate = vi.fn(() => { navigating = true })
    const view = render(<NavigableDestination initial={navigation === 'child' ? null : nested.id} onNavigate={onNavigate} />)
    onTestFinished(() => { view.unmount(); response.resolve(page) })
    await waitFor(() => { expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', false) })
    const picker = screen.getByRole('group', { name: zh.knowledgeSaveDestination })
    const opener = screen.getByRole('button', { name: navigation === 'root' ? zh.knowledgeRootFolder : folder.name })
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '草稿名称' })
    if (elsewhere) { input.focus(); input.setSelectionRange(1, 3) } else opener.focus()
    fireEvent.click(opener)
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(target)
    expect(document.activeElement).toBe(elsewhere ? input : picker)
    expect(picker.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', true)
    await act(async () => { response.resolve(page) })
    expect(picker.getAttribute('aria-busy')).toBe('false')
    expect(document.activeElement).toBe(elsewhere ? input : picker)
    expect(input.value).toBe('保留的资料')
    if (elsewhere) expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3])
    expect(invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list')).toHaveLength(2)
    expect({ focused: document.activeElement?.getAttribute('aria-label'), destination: target,
      canSave: !screen.getByRole<HTMLButtonElement>('button', { name: '保存到此位置' }).disabled }).toMatchSnapshot('Navigated destination focus')
  },
)

it.each(['knowledge.folders.get', 'knowledge.folders.list'] as const)('retains the destination error while retrying %s and blocks an unconfirmed save', async (method) => {
  const response = Promise.withResolvers<unknown>()
  const page = { items: [], total: 0, page: 1, size: 20 }
  const result = method === 'knowledge.folders.get' ? folder : page
  let reads = 0
  const invoke = vi.fn(async (_namespace: string, requested: string) => {
    if (requested !== method) return { ok: true, result: page }
    if (++reads === 1) throw new Error('Offline')
    return { ok: true, result: await response.promise }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = render(<Destination value={method === 'knowledge.folders.get' ? folder.id : null} />)
  onTestFinished(() => { view.unmount(); response.resolve(result) })
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
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  fireEvent.click(retry)
  expect(invoke.mock.calls.filter(call => call[1] === method)).toHaveLength(2)
  expect({ message: notice.textContent, action: retry.textContent,
    canSave: !screen.getByRole<HTMLButtonElement>('button', { name: '保存到此位置' }).disabled }).toMatchSnapshot('Pending destination retry')
  await act(async () => { response.resolve(result) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', false)
  expect(document.activeElement).toBe(screen.getByRole('group', { name: zh.knowledgeSaveDestination }))
})

it('waits for path confirmation after the destination list retry succeeds', async () => {
  const path = Promise.withResolvers<unknown>()
  let paths = 0
  let lists = 0
  const invoke = vi.fn(async (_namespace: string, method: string) => {
    if (method === 'knowledge.folders.get') return { ok: true, result: ++paths === 1 ? folder : await path.promise }
    if (++lists === 1) throw new Error('Offline')
    return { ok: true, result: { items: [], page: 1, size: 20, total: 0 } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = render(<Destination value={folder.id} />)
  onTestFinished(() => { view.unmount(); path.resolve(folder) })
  const notice = await screen.findByRole('alert')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: zh.retry })
  retry.focus()
  await act(async () => { retry.click(); retry.click() })
  expect(paths).toBe(2)
  expect(lists).toBe(2)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(retry.disabled).toBe(false)
  expect(retry.getAttribute('aria-disabled')).toBe('true')
  expect(document.activeElement).toBe(retry)
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('status', { name: zh.loading })).toBeNull()
  await act(async () => { path.resolve(folder) })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', false)
  expect(document.activeElement).toBe(screen.getByRole('group', { name: zh.knowledgeSaveDestination }))
})

it.each([
  { last: 'path', elsewhere: false }, { last: 'list', elsewhere: false },
  { last: 'path', elsewhere: true }, { last: 'list', elsewhere: true },
])('recovers the destination retry focus after both reads settle (last: $last, elsewhere: $elsewhere)', async ({ last, elsewhere }) => {
  const path = Promise.withResolvers<unknown>()
  const list = Promise.withResolvers<unknown>()
  const page = { items: [], page: 1, size: 20, total: 0 }
  let paths = 0, lists = 0
  const invoke = vi.fn(async (_namespace: string, method: string) => {
    if (method === 'knowledge.folders.get') return { ok: true, result: ++paths === 1 ? folder : await path.promise }
    if (++lists === 1) throw new Error('Offline')
    return { ok: true, result: await list.promise }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = render(<><Destination value={folder.id} /><button type="button">其他操作</button></>)
  onTestFinished(() => { view.unmount(); path.resolve(folder); list.resolve(page) })
  const retry = await screen.findByRole('button', { name: zh.retry })
  retry.focus(); fireEvent.click(retry)
  await waitFor(() => { expect([paths, lists]).toEqual([2, 2]) })
  const other = screen.getByRole('button', { name: '其他操作' })
  if (elsewhere) other.focus()
  await act(async () => { if (last === 'path') list.resolve(page); else path.resolve(folder) })
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', true)
  expect(document.activeElement).toBe(elsewhere ? other : retry)
  await act(async () => { if (last === 'path') path.resolve(folder); else list.resolve(page) })
  expect(screen.queryByRole('button', { name: zh.retry })).toBeNull()
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', false)
  expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('group', { name: zh.knowledgeSaveDestination }))
  expect({ focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent,
    canSave: !screen.getByRole<HTMLButtonElement>('button', { name: '保存到此位置' }).disabled,
    retryVisible: screen.queryByRole('button', { name: zh.retry }) !== null }).toMatchSnapshot('Confirmed destination focus')
})

it.each([false, true])('recovers removed destination pagination focus after a smaller total (elsewhere: %s)', async (elsewhere) => {
  const response = Promise.withResolvers<unknown>()
  const requests: number[] = []
  const invoke = vi.fn(async (_namespace: string, _method: string, payload: { page: number }) => {
    requests.push(payload.page)
    return { ok: true, result: requests.length === 1 ? { items: [folder], page: 1, size: 20, total: 21 }
      : payload.page === 2 ? await response.promise : { items: [folder], page: 1, size: 20, total: 1 } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const view = render(<><Destination /><button type="button">其他操作</button></>)
  onTestFinished(() => { view.unmount(); response.resolve({ items: [], page: 2, size: 20, total: 1 }) })
  const next = await screen.findByRole('button', { name: zh.nextPage })
  next.focus(); fireEvent.click(next)
  await waitFor(() => { expect(requests).toEqual([1, 2]) })
  const other = screen.getByRole('button', { name: '其他操作' })
  if (elsewhere) other.focus()
  await act(async () => { response.resolve({ items: [], page: 2, size: 20, total: 1 }) })
  await screen.findByRole('button', { name: folder.name })
  expect(requests).toEqual([1, 2, 1])
  expect(screen.queryByRole('button', { name: zh.nextPage })).toBeNull()
  expect(document.activeElement).toBe(elsewhere ? other : screen.getByRole('group', { name: zh.knowledgeSaveDestination }))
  expect({ focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent,
    nextPageVisible: screen.queryByRole('button', { name: zh.nextPage }) !== null }).toMatchSnapshot('Reduced destination focus')
})

it.each(['page', 'size', 'duplicate'] as const)('blocks an unverified destination after an invalid %s response and allows retry', async (invalid) => {
  let retrying = false
  const valid = { items: [folder], total: 1, page: 1, size: 20 }
  const response = invalid === 'page' ? { ...valid, page: 2 }
    : invalid === 'size' ? { ...valid, size: 10 }
      : { ...valid, items: [folder, folder], total: 2 }
  vi.stubGlobal('dshDesktop', { extensions: { invoke: vi.fn(async () => ({ ok: true, result: retrying ? valid : response })), cancel: vi.fn() } })
  render(<Destination />)
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('button', { name: folder.name })).toBeNull()
  retrying = true
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByRole('button', { name: folder.name })
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', false)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('reads the requested destination page and keeps it after retrying a mismatched page', async () => {
  let retrying = false
  const invoke = vi.fn(async (_namespace: string, _method: string, payload: { page: number }) => ({ ok: true, result: {
    items: [{ ...folder, id: `destination-${payload.page}`, name: `项目资料 ${payload.page}` }], total: 21,
    page: payload.page === 2 && !retrying ? 1 : payload.page, size: 20,
  } }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  render(<Destination />)
  await screen.findByRole('button', { name: '项目资料 1' })
  fireEvent.click(screen.getByRole('button', { name: zh.nextPage }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', true)
  retrying = true
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByRole('button', { name: '项目资料 2' })
  expect(invoke.mock.calls.at(-1)?.[2].page).toBe(2)
  expect(screen.getByRole('button', { name: '保存到此位置' })).toHaveProperty('disabled', false)
})

it.each(['rejected', 'unconfirmed'] as const)('preserves destination controls during saving and respects a %s result', async (outcome) => {
  const first = Promise.withResolvers<unknown>()
  const retry = Promise.withResolvers<unknown>()
  let writes = 0
  const invoke = vi.fn(async (_namespace: string, method: string, _payload: unknown) => ({ ok: true,
    result: method === 'knowledge.folders.create' ? await (++writes === 1 ? first.promise : retry.promise)
      : { items: [folder], page: 1, size: 20, total: 21 },
  }))
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  const saved = vi.fn()
  const view = render(<KnowledgeEditor knowledgeBaseId="personal" target={{ kind: 'folder' }} onClose={vi.fn()} onSaved={saved} t={t} />)
  onTestFinished(() => { view.unmount(); first.resolve(folder); retry.resolve(folder) })
  const next = await screen.findByRole<HTMLButtonElement>('button', { name: zh.nextPage })
  const previous = screen.getByRole<HTMLButtonElement>('button', { name: zh.previousPage })
  const fields = next.closest('fieldset')!
  const name = screen.getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeFolderName })
  fireEvent.change(name, { target: { value: '保留的新目录' } })
  const save = screen.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSave })
  fireEvent.click(save)
  expect(writes).toBe(1)
  expect(fields.getAttribute('aria-busy')).toBe('true')
  expect(fields.classList.contains(css.knowledgeFolderPickerPending!)).toBe(true)
  expect(next.matches(':disabled')).toBe(true)
  expect(next.hasAttribute('disabled')).toBe(false)
  expect(previous.hasAttribute('disabled')).toBe(false)
  expect(previous.getAttribute('aria-disabled')).toBe('true')
  next.click()
  expect(invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.list')).toHaveLength(1)
  expect(screen.getByRole('button', { name: zh.nextPage })).toBe(next)
  await act(async () => { first.reject(outcome === 'unconfirmed'
    ? new ProductError('IDEMPOTENCY_OPERATION_UNKNOWN', 'Unknown save result', true)
    : new ProductError('KNOWLEDGE_SERVICE_UNAVAILABLE', 'Unavailable')) })
  const notice = screen.getByRole('alert')
  expect(name.value).toBe('保留的新目录')
  expect(fields.getAttribute('aria-busy')).toBe('false')
  expect(fields.classList.contains(css.knowledgeFolderPickerPending!)).toBe(false)
  expect(next.matches(':disabled')).toBe(outcome === 'unconfirmed')
  expect({ error: notice.textContent, destinationLocked: next.matches(':disabled'), name: name.value }).toMatchSnapshot()
  fireEvent.click(save)
  expect(screen.getByRole('alert')).toBe(notice)
  expect(fields.classList.contains(css.knowledgeFolderPickerPending!)).toBe(outcome !== 'unconfirmed')
  const calls = invoke.mock.calls.filter(call => call[1] === 'knowledge.folders.create')
  expect(calls).toHaveLength(2)
  expect(calls[1]?.[2]).toEqual(calls[0]?.[2])
  await act(async () => { retry.resolve({ ...folder, id: 'created', name: '保留的新目录' }) })
  expect(saved).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
})
