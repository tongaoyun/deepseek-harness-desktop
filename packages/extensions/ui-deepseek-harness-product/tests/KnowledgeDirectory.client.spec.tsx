// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { KnowledgeWorkspace } from '../src/client/KnowledgeWorkspace.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

const props = { entries: items([{ id: 'personal', name: '个人库', scope: 'PERSONAL', canManage: true }]),
  loading: false, authRequired: false, authPending: false, authError: false, onRefresh: vi.fn(), onSignIn: vi.fn(),
  renderFactorySlot: () => null, t: (key: DeepSeekHarnessProductKey) => zh[key] }
const roots = Array.from({ length: 21 }, (_, index) => ({ id: `folder-${index + 1}`, name: `目录${index + 1}`, parentId: null, updatedAt: '2026-10-17T00:00:00Z' }))
const child = { id: 'child', name: '子目录', parentId: 'folder-21', updatedAt: '2026-10-17T00:00:00Z' }
const document = { id: 'document', knowledgeBaseId: 'personal', filename: '旧标题.md', mediaType: 'text/markdown',
  sizeBytes: 20, status: 'READY', chunkCount: 1, sourceType: 'manual', canManage: true,
  updatedAt: '2026-10-13T00:00:00Z', folderId: null }
function transport(getFailure = false, getFolder?: (folderId: string) => Promise<unknown>, cancel = vi.fn(),
  move?: () => Promise<unknown>) {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: Record<string, unknown>, _requestId?: string) => {
    if (method === 'knowledge.documents.upload.pending') return { ok: true, result: [] }
    if (method === 'knowledge.documents.move' && move) return move()
    if (method === 'knowledge.folders.get') {
      if (getFolder) return { ok: true, result: await getFolder(String(payload.folderId)) }
      const folder = [...roots, child].find(row => row.id === payload.folderId)
      return getFailure || !folder ? { ok: false, failure: { code: 'KNOWLEDGE_NOT_FOUND', message: 'Missing folder', retryable: false } }
        : { ok: true, result: folder }
    }
    if (method === 'knowledge.folders.list') {
      const all = payload.parentId === null ? roots : payload.parentId === 'folder-21' ? [child] : []
      return { ok: true, result: { items: all.slice((Number(payload.page) - 1) * 20, Number(payload.page) * 20),
        page: payload.page, size: 20, total: all.length } }
    }
    if (method === 'knowledge.documents.get') return { ok: true, result: {
      ...document, filename: '他人新标题.md', manualContent: '# 新正文', updatedAt: '2026-10-14T00:00:00Z',
    } }
    if (method === 'knowledge.documents.save') return { ok: true, result: document }
    if (method === 'knowledge.folders.create') return { ok: true, result: { id: 'created', name: payload.name, parentId: payload.parentId, updatedAt: '2026-10-17T00:00:00Z' } }
    return { ok: true, result: { items: [document], page: 1, size: 20, total: 1 } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel } })
  return invoke
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('cancels a previous location read and ignores its late response after selecting another folder', async () => {
  let resolve!: (value: unknown) => void
  const delayed = new Promise<unknown>((complete) => { resolve = complete })
  const cancel = vi.fn()
  const invoke = transport(false, async id => id === 'folder-1' ? delayed : roots.find(folder => folder.id === id), cancel)
  const view = render(<KnowledgeWorkspace {...props} />)
  const navigation = within(view.container.querySelector<HTMLElement>('[data-knowledge-navigation]')!)
  fireEvent.click(await navigation.findByRole('button', { name: '目录1' }))
  await waitFor(() => { expect(invoke.mock.calls.some(call => call[1] === 'knowledge.folders.get' && call[2].folderId === 'folder-1')).toBe(true) })
  const requestId = invoke.mock.calls.find(call => call[1] === 'knowledge.folders.get' && call[2].folderId === 'folder-1')![3]
  fireEvent.click(navigation.getByRole('button', { name: '目录2' }))
  const breadcrumb = within(view.container.querySelector<HTMLElement>('nav[aria-label="当前位置"]')!)
  await breadcrumb.findByRole('button', { name: '目录2' })
  expect(cancel).toHaveBeenCalledWith('product', requestId)
  await act(async () => { resolve(roots[0]); await delayed })
  expect(breadcrumb.queryByRole('button', { name: '目录1' })).toBeNull()
  expect(breadcrumb.getByRole('button', { name: '目录2' })).toBeTruthy()
})

it('moves to another page and an unexpanded nested destination without preloading the sidebar', async () => {
  const invoke = transport()
  const view = render(<KnowledgeWorkspace {...props} />)
  const navigation = within(view.container.querySelector<HTMLElement>('[data-knowledge-navigation]')!)
  await navigation.findByRole('button', { name: '目录1' })
  fireEvent.click(screen.getByRole('tab', { name: zh.knowledgeAllMaterials }))
  await screen.findByRole('button', { name: document.filename })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeMoveDocument }))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.click(await dialog.findByRole('button', { name: zh.nextPage }))
  fireEvent.click(await dialog.findByRole('button', { name: '目录21' }))
  fireEvent.click(await dialog.findByRole('button', { name: '子目录' }))
  await dialog.findByRole('button', { name: '子目录', current: 'page' })
  await waitFor(() => { expect(dialog.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeMove }).disabled).toBe(false) })
  expect(dialog.getByRole('navigation').textContent).toMatchInlineSnapshot('"知识库首页目录21子目录"')
  expect(navigation.queryByRole('button', { name: '目录21' })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeMove }))
  await waitFor(() => { expect(invoke.mock.calls.some(call => call[1] === 'knowledge.documents.move' && call[2].folderId === 'child')).toBe(true) })
  expect(invoke.mock.calls.find(call => call[1] === 'knowledge.documents.move')?.[2]).toMatchObject({
    expectedFolderId: null, expectedUpdatedAt: document.updatedAt,
  })
  expect(typeof invoke.mock.calls.find(call => call[1] === 'knowledge.documents.move')?.[2].operationId).toBe('string')
})

it('retries a lost move receipt with the original destination and operation identity', async () => {
  const move = vi.fn().mockRejectedValueOnce(new TypeError('response lost')).mockResolvedValue({ ok: true, result: { moved: true } })
  const invoke = transport(false, undefined, vi.fn(), move)
  render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(screen.getByRole('tab', { name: zh.knowledgeAllMaterials }))
  await screen.findByRole('button', { name: document.filename })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeMoveDocument }))
  const dialog = within(screen.getByRole('dialog'))
  fireEvent.click(await dialog.findByRole('button', { name: '目录1' }))
  await waitFor(() => { expect(dialog.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeMove }).disabled).toBe(false) })
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeMove }))
  await dialog.findByRole('alert')
  expect(dialog.getByRole('button', { name: zh.knowledgeRootFolder }).matches(':disabled')).toBe(true)
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeMove }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  const calls = invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.move')
  expect(calls).toHaveLength(2)
  expect(calls[0]?.[2]).toEqual(calls[1]?.[2])
  expect(calls[0]?.[2]).toMatchObject({ folderId: 'folder-1', expectedFolderId: null,
    expectedUpdatedAt: document.updatedAt })
  expect(typeof calls[0]?.[2].operationId).toBe('string')
})

it('retains the selected path and create location after the sidebar changes pages', async () => {
  const invoke = transport()
  const view = render(<KnowledgeWorkspace {...props} />)
  const navigation = within(view.container.querySelector<HTMLElement>('[data-knowledge-navigation]')!)
  fireEvent.click(await navigation.findByRole('button', { name: '目录1' }))
  const breadcrumb = within(view.container.querySelector<HTMLElement>('nav[aria-label="当前位置"]')!)
  await breadcrumb.findByRole('button', { name: '目录1' })
  fireEvent.click(navigation.getByRole('button', { name: zh.nextPage }))
  await navigation.findByRole('button', { name: '目录21' })
  expect(breadcrumb.getByRole('button', { name: '目录1' })).toBeTruthy()
  const content = within(view.container.querySelector<HTMLElement>('[data-knowledge-content]')!)
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeAddMaterial }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeCreateFolder }))
  const dialog = within(screen.getByRole('dialog'))
  await dialog.findByRole('button', { name: '目录1', current: 'page' })
  fireEvent.change(dialog.getByRole('textbox', { name: zh.knowledgeFolderName }), { target: { value: '新子目录' } })
  await waitFor(() => { expect(dialog.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSave }).disabled).toBe(false) })
  fireEvent.click(dialog.getByRole('button', { name: zh.knowledgeSave }))
  await waitFor(() => { expect(invoke.mock.calls.some(call => call[1] === 'knowledge.folders.create' && call[2].parentId === 'folder-1')).toBe(true) })
})

it('loads title and content from the same document revision before saving', async () => {
  const invoke = transport()
  render(<KnowledgeWorkspace {...props} />)
  fireEvent.click(screen.getByRole('tab', { name: zh.knowledgeAllMaterials }))
  await screen.findByRole('button', { name: document.filename })
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.modifyResource }))
  const content = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: zh.knowledgeMarkdownContent })
  await waitFor(() => { expect(content.value).toBe('# 新正文') })
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeDocumentTitle }).value).toBe('他人新标题')
  fireEvent.click(screen.getByRole('button', { name: zh.knowledgeSave }))
  await waitFor(() => { expect(invoke.mock.calls.some(call => call[1] === 'knowledge.documents.save'
    && call[2].title === '他人新标题' && call[2].expectedUpdatedAt === '2026-10-14T00:00:00Z')).toBe(true) })
})

it('paginates folders and documents together without following navigation pagination', async () => {
  const invoke = transport()
  const view = render(<KnowledgeWorkspace {...props} />)
  const navigation = within(view.container.querySelector<HTMLElement>('[data-knowledge-navigation]')!)
  const content = within(view.container.querySelector<HTMLElement>('[data-knowledge-content]')!)
  await content.findByRole('button', { name: '目录1' })
  expect(content.queryByRole('button', { name: document.filename })).toBeNull()
  expect(content.getByText(zh.itemCount.replace('{count}', '22'))).toBeTruthy()
  fireEvent.click(navigation.getByRole('button', { name: zh.nextPage }))
  await navigation.findByRole('button', { name: '目录21' })
  expect(content.getByRole('button', { name: '目录1' })).toBeTruthy()
  expect(content.queryByRole('button', { name: '目录21' })).toBeNull()
  fireEvent.click(content.getByRole('button', { name: zh.nextPage }))
  await content.findByRole('button', { name: document.filename })
  expect(content.getByRole('button', { name: '目录21' })).toBeTruthy()
  expect(content.queryByRole('button', { name: '目录1' })).toBeNull()
  expect(invoke.mock.calls.some(call => call[1] === 'knowledge.documents.list')).toBe(true)
})

it('blocks creation in a missing folder and preserves the entered name without submitting to root', async () => {
  const invoke = transport(true)
  const view = render(<KnowledgeWorkspace {...props} />)
  const navigation = within(view.container.querySelector<HTMLElement>('[data-knowledge-navigation]')!)
  await navigation.findByRole('button', { name: '目录1' })
  fireEvent.click(navigation.getByRole('button', { name: zh.knowledgeFolderActions.replace('{name}', '目录1') }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeCreateSubfolder }))
  const dialog = within(screen.getByRole('dialog'))
  const name = dialog.getByRole<HTMLInputElement>('textbox', { name: zh.knowledgeFolderName })
  fireEvent.change(name, { target: { value: '保留名称' } })
  await dialog.findByRole('alert')
  expect(name.value).toBe('保留名称')
  expect(dialog.getByRole<HTMLButtonElement>('button', { name: zh.knowledgeSave }).disabled).toBe(true)
  expect(invoke.mock.calls.some(call => call[1] === 'knowledge.folders.create')).toBe(false)
})
