// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { KnowledgeWorkspace } from '../src/client/KnowledgeWorkspace.tsx'
import { items } from '../src/client/catalog-shared.tsx'
import { zh, type DeepSeekHarnessProductKey } from '../src/locales.ts'

const updatedAt = '2026-10-19T00:00:00Z'
const folders = Array.from({ length: 21 }, (_, index) => ({
  id: `folder-${index + 1}`, name: `项目 ${index + 1}`, parentId: null, updatedAt,
}))
const nested = { id: 'nested', name: '验收资料', parentId: 'folder-21', updatedAt }
const document = { id: 'document', knowledgeBaseId: 'personal', filename: '验收记录.md',
  folderId: nested.id, mediaType: 'text/markdown', sizeBytes: 20, status: 'READY', chunkCount: 1, updatedAt }
const props = { entries: items([{ id: 'personal', name: '项目知识库', scope: 'PERSONAL', canManage: true }]),
  loading: false, authRequired: false, authPending: false, authError: false, onRefresh: vi.fn(), onSignIn: vi.fn(),
  renderFactorySlot: () => null, t: (key: DeepSeekHarnessProductKey) => zh[key] }

function transport(paginated = false) {
  const invoke = vi.fn(async (_namespace: string, method: string, payload: Record<string, unknown>) => {
    if (method === 'knowledge.documents.upload.pending') return { ok: true, result: [] }
    if (method === 'knowledge.folders.get') return { ok: true, result: [...folders, nested].find(row => row.id === payload.folderId) }
    const values = method === 'knowledge.folders.list' ? payload.parentId === null ? paginated ? folders : folders.slice(0, 1) : payload.parentId === 'folder-21' ? [nested] : []
      : (payload.folderId === undefined || payload.folderId === nested.id) && !payload.query && !payload.format ? [document] : []
    const page = Number(payload.page ?? 1)
    return { ok: true, result: { items: values.slice((page - 1) * 20, page * 20), total: values.length, size: 20, page } }
  })
  vi.stubGlobal('dshDesktop', { extensions: { invoke, cancel: vi.fn() } })
  return invoke
}

function regions(container: HTMLElement) {
  return {
    navigation: within(container.querySelector<HTMLElement>('[data-knowledge-navigation]')!),
    content: within(container.querySelector<HTMLElement>('[data-knowledge-content]')!),
  }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('uses the library as home and places browsing modes outside the real folder tree', async () => {
  const invoke = transport()
  const { container } = render(<KnowledgeWorkspace {...props} />)
  const { navigation, content } = regions(container)
  await content.findByRole('button', { name: '项目 1' })
  expect(navigation.queryByRole('button', { name: zh.knowledgeRootFolder })).toBeNull()
  expect(navigation.queryByRole('tab', { name: zh.knowledgeAllMaterials })).toBeNull()
  expect(content.getByRole('tab', { name: zh.knowledgeFolderView }).getAttribute('aria-selected')).toBe('true')
  expect(within(content.getByRole('tablist', { name: zh.knowledgeBrowseMode })).getAllByRole('tab').map(button => button.textContent))
    .toMatchInlineSnapshot(`
      [
        "按文件夹",
        "全部文件",
      ]
    `)
  fireEvent.click(navigation.getByRole('button', { name: '项目 1' }))
  await waitFor(() => { expect(invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list').at(-1)?.[2].folderId).toBe('folder-1') })
  fireEvent.click(navigation.getByRole('button', { name: '项目知识库' }))
  await content.findByRole('button', { name: '项目 1' })
  expect(invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list').at(-1)?.[2].folderId).toBeNull()
  expect(invoke.mock.calls.some(call => call[1].startsWith('tasks.'))).toBe(false)
})

it('finds a file across folders and locates an unvisited nested destination by its stable ID', async () => {
  const invoke = transport(true)
  const { container } = render(<KnowledgeWorkspace {...props} />)
  const { navigation, content } = regions(container)
  fireEvent.click(content.getByRole('tab', { name: zh.knowledgeAllMaterials }))
  await content.findByRole('button', { name: document.filename })
  expect(invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list').at(-1)?.[2]).not.toHaveProperty('folderId')
  expect(content.getByRole('searchbox').getAttribute('placeholder')).toBe(zh.knowledgeSearchLibrary)
  expect(content.getByText(zh.knowledgeLibrarySaveLocation)).toBeDefined()
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeDocumentActions.replace('{name}', document.filename) }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.knowledgeShowInFolder }))
  const breadcrumb = within(content.getByRole('navigation', { name: zh.knowledgeLocation }))
  await breadcrumb.findByRole('button', { name: nested.name })
  expect(breadcrumb.getByRole('button', { name: '项目 21' })).toBeDefined()
  await waitFor(() => { expect(invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list').at(-1)?.[2].folderId).toBe(nested.id) })
  expect(content.getByRole('tab', { name: zh.knowledgeFolderView }).getAttribute('aria-selected')).toBe('true')
  expect(content.getByRole('searchbox').getAttribute('placeholder')).toBe(zh.knowledgeSearchFolder)
  fireEvent.click(navigation.getByRole('button', { name: zh.knowledgeCreateFolder }))
  const dialog = within(await screen.findByRole('dialog', { name: zh.knowledgeCreateFolder }))
  await dialog.findByRole('button', { name: zh.knowledgeRootFolder, current: 'page' })
  expect(dialog.queryByRole('button', { name: nested.name, current: 'page' })).toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: zh.cancel }))
  expect(invoke.mock.calls.some(call => call[1] === 'knowledge.folders.create')).toBe(false)
})

it('clears an empty search and format filter without changing the library-wide scope', async () => {
  const invoke = transport()
  const { container } = render(<KnowledgeWorkspace {...props} />)
  const { content } = regions(container)
  fireEvent.click(content.getByRole('tab', { name: zh.knowledgeAllMaterials }))
  await content.findByRole('button', { name: document.filename })
  fireEvent.change(content.getByRole('searchbox'), { target: { value: '未命中' } })
  fireEvent.click(content.getByRole('button', { name: zh.search }))
  await content.findByText(zh.noSearchResults)
  fireEvent.change(content.getByRole('combobox', { name: zh.knowledgeFormat }), { target: { value: 'pdf' } })
  await waitFor(() => { expect(invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list').at(-1)?.[2].format).toBe('pdf') })
  fireEvent.click(content.getByRole('button', { name: zh.knowledgeClearFilters }))
  await content.findByRole('button', { name: document.filename })
  expect(content.queryByRole('button', { name: zh.knowledgeClearFilters })).toBeNull()
  expect(content.getByRole<HTMLInputElement>('searchbox').value).toBe('')
  expect(invoke.mock.calls.filter(call => call[1] === 'knowledge.documents.list').at(-1)?.[2]).toEqual({ knowledgeBaseId: 'personal', page: 1, size: 20 })
})
