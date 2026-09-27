// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { KnowledgeBasePage } from './KnowledgeBasePage'
import { createKnowledgeBase, loadKnowledgeBases, loadKnowledgeDocuments, uploadKnowledgeDocument, searchKnowledge, deleteKnowledgeDocument, reindexKnowledgeDocument } from './api'
import type { KnowledgeBaseEntry, KnowledgeDocumentEntry } from './types'

vi.mock('./api', () => ({ loadKnowledgeBases: vi.fn(), loadKnowledgeDocuments: vi.fn(), uploadKnowledgeDocument: vi.fn(), searchKnowledge: vi.fn(), deleteKnowledgeDocument: vi.fn(), createKnowledgeBase: vi.fn(), deleteKnowledgeBase: vi.fn(), reindexKnowledgeDocument: vi.fn() }))
vi.mock('./DesktopDialog', () => ({ useDesktopDialog: () => ({ confirm: async () => true, dialog: null }) }))
vi.mock('./CapabilityHero', () => ({ CapabilityHero: () => null }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const base = (id: string) => ({ id, name: id, reference: `personal:${id}`, scope: 'PERSONAL' }) as KnowledgeBaseEntry
const doc = (id: string, baseId = 'one') => ({ id, knowledgeBaseId: baseId, filename: `${id}.md`, status: 'READY', chunkCount: 1, sizeBytes: 20 }) as KnowledgeDocumentEntry
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(loadKnowledgeBases).mockResolvedValue([base('one'), base('two')])
  vi.mocked(loadKnowledgeDocuments).mockResolvedValue([])
  vi.mocked(searchKnowledge).mockResolvedValue([])
})

it('opens creation in a dialog, preserves failed input, and only closes after a successful save', async () => {
  vi.mocked(createKnowledgeBase).mockRejectedValueOnce(new Error('创建失败')).mockResolvedValueOnce(base('new'))
  await fixture(async (container) => {
    expect(container.querySelector('[aria-label="知识库名称"]')).toBeNull()
    await click(container, '.knowledge-create-trigger')
    const input = container.querySelector<HTMLInputElement>('[aria-label="知识库名称"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '我的资料')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = async () => act(async () => container.querySelector('[role="dialog"] form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await save()
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('创建失败')
    expect(input.value).toBe('我的资料')
    await save()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(createKnowledgeBase).toHaveBeenLastCalledWith('/knowledge', 'test', '', '', expect.objectContaining({ name: '我的资料', scope: 'PERSONAL' }), expect.any(String))
  })
})
async function fixture(check: (container: HTMLDivElement) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try { await act(async () => root.render(<KnowledgeBasePage endpoint="/knowledge" employeeId="test" teamId="" sessionToken="" />)); await check(container) }
  finally { await act(async () => root.unmount()); container.remove() }
}
async function click(container: HTMLElement, selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()) }
async function upload(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}
async function search(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('.knowledge-search input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '库存')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => container.querySelector('.knowledge-search')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

it('keeps every successful file visible after a partial batch failure and continues later files', async () => {
  vi.mocked(uploadKnowledgeDocument).mockResolvedValueOnce(doc('first')).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(doc('third'))
  await fixture(async (container) => {
    await upload(container, ['first', 'bad', 'third'].map((id) => new File(['data'], `${id}.md`)))
    expect(container.querySelector('.knowledge-documents')!.textContent).toContain('first.md')
    expect(container.querySelector('.knowledge-documents')!.textContent).toContain('third.md')
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('bad.md')
    expect(uploadKnowledgeDocument).toHaveBeenCalledTimes(3)
  })
})

it('rejects oversized batches without silently discarding files', async () => {
  await fixture(async (container) => {
    await upload(container, Array.from({ length: 21 }, (_, i) => new File(['data'], `${i}.md`)))
    expect(uploadKnowledgeDocument).not.toHaveBeenCalled()
    expect(container.textContent).toContain('本次未上传任何文件')
  })
})

it('ignores old document requests after switching knowledge bases', async () => {
  let resolve!: (value: KnowledgeDocumentEntry[]) => void
  vi.mocked(loadKnowledgeDocuments).mockReturnValueOnce(new Promise((yes) => { resolve = yes })).mockResolvedValue([doc('new', 'two')])
  await fixture(async (container) => {
    await click(container, '.knowledge-base-list button:last-of-type')
    await act(async () => resolve([doc('old')]))
    expect(container.querySelector('.knowledge-documents')!.textContent).toContain('new.md')
    expect(container.querySelector('.knowledge-documents')!.textContent).not.toContain('old.md')
  })
})

it('shows genuine empty search results and removes deleted source snippets', async () => {
  vi.mocked(loadKnowledgeDocuments).mockResolvedValue([doc('source')])
  vi.mocked(searchKnowledge).mockResolvedValueOnce([{ knowledgeBaseId: 'one', knowledgeBaseName: 'one', documentId: 'source', filename: 'source.md', locator: '正文', content: '原文片段', score: 1 }]).mockResolvedValue([])
  await fixture(async (container) => {
    await search(container)
    expect(container.querySelector('.knowledge-hits')!.textContent).toContain('原文片段')
    await click(container, '[title="删除文档"]')
    expect(deleteKnowledgeDocument).toHaveBeenCalledOnce()
    expect(container.querySelector('.knowledge-hits')).toBeNull()
    await search(container)
    expect(container.textContent).toContain('未找到匹配原文')
  })
})

it('does not misrepresent a catalog failure as an empty knowledge base', async () => {
  vi.mocked(loadKnowledgeBases).mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue([])
  await fixture(async (container) => {
    expect(container.textContent).toContain('知识库暂不可用')
    expect(container.textContent).not.toContain('创建第一个知识库')
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('unavailable')
    await click(container, '.knowledge-welcome button')
    expect(loadKnowledgeBases).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('创建第一个知识库')
    expect(container.querySelector('.knowledge-welcome button')?.textContent).toContain('新建知识库')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})

it('shows an empty catalog without a redundant title or retry action', async () => {
  vi.mocked(loadKnowledgeBases).mockResolvedValue([])
  await fixture(async (container) => {
    expect(container.querySelector('.knowledge-page-heading')).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
    expect(container.textContent).toContain('可见知识库 · 0')
    expect(container.textContent).toContain('创建第一个知识库')
    expect(container.textContent).not.toContain('重新加载')
    expect(container.textContent).not.toContain('先创建一个知识库')
    await click(container, '.knowledge-welcome button')
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('新建知识库')
  })
})

it('retries only failed uploads without submitting successful files twice', async () => {
  vi.mocked(uploadKnowledgeDocument).mockResolvedValueOnce(doc('first')).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(doc('second'))
  await fixture(async (container) => {
    await upload(container, ['first', 'second'].map((id) => new File(['data'], `${id}.md`)))
    await click(container, '.knowledge-upload-retry button')
    expect(vi.mocked(uploadKnowledgeDocument).mock.calls.map((call) => call[5].name)).toEqual(['first.md', 'second.md', 'second.md'])
    expect(container.querySelector('.knowledge-upload-retry')).toBeNull()
    expect(container.querySelectorAll('.knowledge-documents article')).toHaveLength(2)
  })
})

it('does not replace a new knowledge base document with a late reindex response', async () => {
  let resolve!: (value: KnowledgeDocumentEntry) => void
  vi.mocked(reindexKnowledgeDocument).mockReturnValue(new Promise((yes) => { resolve = yes }))
  vi.mocked(loadKnowledgeDocuments).mockResolvedValueOnce([doc('shared')]).mockResolvedValue([doc('shared', 'two')])
  await fixture(async (container) => {
    await click(container, '[title="重建索引"]')
    await click(container, '.knowledge-base-list button:last-of-type')
    await act(async () => resolve({ ...doc('shared'), status: 'QUEUED' }))
    expect(container.querySelector('.knowledge-documents em')?.textContent).toBe('可检索')
  })
})

it('filters documents by filename and indexing status', async () => {
  vi.mocked(loadKnowledgeDocuments).mockResolvedValue([doc('ready'), { ...doc('failed'), status: 'FAILED', failureMessage: '文件损坏' }])
  await fixture(async (container) => {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('[aria-label="文档状态"]')!
      select.value = 'FAILED'; select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelectorAll('.knowledge-documents article')).toHaveLength(1)
    expect(container.querySelector('.knowledge-documents article')?.textContent).toContain('文件损坏')
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[aria-label="按文档名称筛选"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'missing')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('没有符合筛选条件的文档')
  })
})

it('discards a search response after the query has changed', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof searchKnowledge>>) => void
  vi.mocked(searchKnowledge).mockReturnValue(new Promise((yes) => { resolve = yes }))
  await fixture(async (container) => {
    await search(container)
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('.knowledge-search input')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '退款')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => resolve([{ knowledgeBaseId: 'one', knowledgeBaseName: 'one', documentId: 'old', filename: '库存.md', locator: '正文', content: '过期检索结果', score: 1 }]))
    expect(container.textContent).not.toContain('过期检索结果')
    expect(container.querySelector('.knowledge-hits')).toBeNull()
  })
})
