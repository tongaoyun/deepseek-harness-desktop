// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { KnowledgeBasePage } from './KnowledgeBasePage'
import { createKnowledgeBase, loadKnowledgeBases, loadKnowledgeDocuments, uploadKnowledgeDocument, searchKnowledge, deleteKnowledgeDocument } from './api'
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
    expect(createKnowledgeBase).toHaveBeenLastCalledWith('/knowledge', 'test', '', '', expect.objectContaining({ name: '我的资料', scope: 'PERSONAL' }))
  })
})
async function fixture(check: (container: HTMLDivElement) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try { await act(async () => root.render(<KnowledgeBasePage endpoint="/knowledge" employeeId="test" teamId="" accessToken="" />)); await check(container) }
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
  vi.mocked(loadKnowledgeBases).mockRejectedValue(new Error('unavailable'))
  await fixture(async (container) => {
    expect(container.textContent).toContain('知识库暂不可用')
    expect(container.textContent).not.toContain('创建第一个知识库')
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('unavailable')
  })
})
