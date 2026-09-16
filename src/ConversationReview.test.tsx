// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { FileChangesCard } from './FileChangesCard'
import { LocalFilePreviewPanel } from './LocalFilePreviewPanel'
import { RichMessage } from './RichMessage'
import { codeDiffRows } from './codeDiff'
import { loadLocalArtifactPreview, undoLocalFileChange } from './localArtifactPreview'
import type { TaskFileChange } from './types'

vi.mock('./localArtifactPreview', async (original) => ({ ...await original<typeof import('./localArtifactPreview')>(), loadLocalArtifactPreview: vi.fn(), undoLocalFileChange: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
const change: TaskFileChange = { id: 'one', rootId: 'root', rootName: 'repo', path: 'one.ts', name: 'one.ts', action: 'updated', sourceTool: 'local_files_write_text', backupPath: '.xiaoyin-backups/first/one.ts', afterHash: 'after', beforeHash: 'before', changedAt: '' }
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!
function mount() { const element = document.body.appendChild(document.createElement('div')); const root = createRoot(element); return { element, root, cleanup: async () => { await act(async () => root.unmount()); element.remove() } } }
it('reviews the entire turn, makes paths clickable and never presents partial totals as complete', async () => {
  const app = mount(); const review = vi.fn(); const open = vi.fn()
  const changes = Array.from({ length: 5 }, (_, index) => ({ ...change, id: String(index), path: `${index}.ts`, name: `${index}.ts` }))
  try {
    await act(async () => app.root.render(<FileChangesCard changes={changes} onReview={review} onOpen={open} />))
    expect(app.element.querySelectorAll('.file-change-row')).toHaveLength(3)
    expect(app.element.textContent).toContain('审核中查看完整差异')
    await act(async () => button('审核').click())
    expect(review.mock.calls[0][0]).toHaveLength(5)
    await act(async () => button('0.ts').click())
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: '0.ts' }))
    await act(async () => button('再显示 2 个文件').click())
    expect(app.element.querySelectorAll('.file-change-row')).toHaveLength(5)
  } finally { await app.cleanup() }
})

it('confirms undo, persists only successful files and surfaces conflicts', async () => {
  const app = mount(); const done = vi.fn()
  vi.mocked(undoLocalFileChange).mockResolvedValueOnce({ id: 'one', undoneAt: 'now', recoveryPath: '.xiaoyin-backups/undo/one.ts' }).mockRejectedValueOnce(new Error('文件已被修改'))
  try {
    await act(async () => app.root.render(<FileChangesCard changes={[change, { ...change, id: 'two', path: 'two.ts' }]} onUndone={done} />))
    await act(async () => button('撤销').click())
    expect(undoLocalFileChange).not.toHaveBeenCalled()
    await act(async () => button('确认撤销 2 个文件').click())
    expect(done).toHaveBeenCalledWith([{ id: 'one', undoneAt: 'now', recoveryPath: '.xiaoyin-backups/undo/one.ts' }])
    expect(app.element.querySelector('[role="alert"]')?.textContent).toContain('two.ts：文件已被修改')
    expect(app.element.textContent).toContain('已撤销 1 个文件')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally { await app.cleanup() }
})

it('does not let Escape consumed by another interaction close the file preview', async () => {
  const app = mount(); const close = vi.fn()
  vi.mocked(loadLocalArtifactPreview).mockResolvedValue({ name: 'one.ts', path: 'one.ts', kind: 'code', content: 'ok', sizeBytes: 2, truncated: false })
  try {
    await act(async () => app.root.render(<LocalFilePreviewPanel onClose={close} target={change} />))
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    consumed.preventDefault()
    await act(async () => window.dispatchEvent(consumed))
    expect(close).not.toHaveBeenCalled()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })))
    expect(close).toHaveBeenCalledOnce()
  } finally { await app.cleanup() }
})

it('reloads changed review baselines, computes current counts and refreshes the file', async () => {
  const app = mount()
  vi.mocked(loadLocalArtifactPreview).mockImplementation(async (target) => ({ name: target.name, path: target.path, kind: 'code', sizeBytes: 12, truncated: false, content: target.path.startsWith('.xiaoyin') ? 'before\n' : 'after\n' }))
  const target = { rootId: 'root', rootName: 'repo', name: 'one.ts', path: 'one.ts', initialView: 'review' as const, review: { action: 'updated' as const, backupPath: '.xiaoyin-backups/first/one.ts', addedLines: 900 } }
  try {
    await act(async () => app.root.render(<LocalFilePreviewPanel onClose={() => {}} target={target} />))
    expect(app.element.querySelector('.local-review-counts')?.textContent).toBe('+1-1')
    await act(async () => app.root.render(<LocalFilePreviewPanel onClose={() => {}} target={{ ...target, review: { ...target.review, backupPath: '.xiaoyin-backups/second/one.ts' } }} />))
    expect(loadLocalArtifactPreview).toHaveBeenCalledWith(expect.objectContaining({ path: '.xiaoyin-backups/second/one.ts' }))
    const calls = vi.mocked(loadLocalArtifactPreview).mock.calls.length
    await act(async () => app.element.querySelector<HTMLButtonElement>('[aria-label="刷新文件"]')!.click())
    expect(vi.mocked(loadLocalArtifactPreview).mock.calls.length).toBe(calls + 2)
  } finally { await app.cleanup() }
})

it('copies fenced code separately and keeps actions for completed answers starting with 正在', async () => {
  const app = mount(); const copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  try {
    await act(async () => app.root.render(<RichMessage assistant text={'正在使用的示例：\n\n```ts\nconst ok = true\n```'} />))
    expect(app.element.querySelector('[aria-label="复制回答"]')).not.toBeNull()
    await act(async () => app.element.querySelector<HTMLButtonElement>('[aria-label="复制代码"]')!.click())
    expect(copy).toHaveBeenCalledWith('const ok = true')
    copy.mockRejectedValueOnce(new Error('denied'))
    await act(async () => app.element.querySelector<HTMLButtonElement>('[aria-label="复制回答"]')!.click())
    expect(app.element.textContent).toContain('复制失败，请重试')
  } finally { await app.cleanup() }
})

it('expands unchanged diff context without losing line numbers', () => {
  const content = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
  const folded = codeDiffRows(content, content + '\nnew')
  const fold = folded.find((row) => row.kind === 'fold')!
  const expanded = codeDiffRows(content, content + '\nnew', new Set([fold.id]))
  expect(expanded.some((row) => row.kind === 'fold')).toBe(false)
  expect(expanded.find((row) => row.text === 'line 15')).toMatchObject({ oldLine: 16, newLine: 16 })
})
