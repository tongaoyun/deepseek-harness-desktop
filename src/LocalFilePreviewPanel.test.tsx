// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalFilePreviewPanel } from './LocalFilePreviewPanel'
import { artifactFailure, loadLocalArtifactPreview, type LocalArtifactTarget } from './localArtifactPreview'
import { authorizeLocalDirectory, authorizeLocalFiles } from './harness'

vi.mock('./localArtifactPreview', async (original) => ({ ...await original<object>(), loadLocalArtifactPreview: vi.fn(), revealLocalArtifact: vi.fn() }))
vi.mock('./harness', () => ({ authorizeLocalDirectory: vi.fn(), authorizeLocalFiles: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => vi.resetAllMocks())
const target: LocalArtifactTarget = { rootId: 'root', rootName: '原目录', name: 'report.txt', path: 'report.txt', review: { action: 'created' } }
const selected = { directories: [], attachments: [{ id: 'file', rootId: 'new', rootName: '新目录', rootPath: '/tmp/new', path: 'report.txt', name: 'report.txt', kind: 'file' as const }] }
async function fixture(run: (container: HTMLElement, open: ReturnType<typeof vi.fn>, render: (next: LocalArtifactTarget | null) => Promise<void>) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container); const open = vi.fn()
  const render = async (next: LocalArtifactTarget | null) => { await act(async () => root.render(next && <LocalFilePreviewPanel target={next} onClose={() => {}} onOpenSelected={open} />)) }
  try { await render(target); await run(container, open, render) } finally { await act(async () => root.unmount()); container.remove() }
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label)!
it('classifies actual causes without claiming an unknown failure means deleted', () => {
  expect(artifactFailure('[XY-FILE-AUTH] 授权已失效').kind).toBe('authorization')
  expect(artifactFailure('[XY-FILE-MISSING] 文件不存在或已被移动').kind).toBe('missing')
  expect(artifactFailure('Permission denied').kind).toBe('permission')
  expect(artifactFailure('I/O error').kind).toBe('other')
})
it('opens a selected file without carrying the old review or rewriting history', async () => {
  vi.mocked(loadLocalArtifactPreview).mockRejectedValue(new Error('[XY-FILE-MISSING] 文件不存在或已被移动'))
  vi.mocked(authorizeLocalFiles).mockResolvedValue(selected)
  await fixture(async (container, open) => {
    expect(container.textContent).toContain('原路径找不到文件')
    expect(container.textContent).toContain('不改写历史成果路径')
    await act(async () => button(container, '选择文件打开').click())
    expect(open).toHaveBeenCalledWith({ rootId: 'new', rootName: '新目录', path: 'report.txt', name: 'report.txt' })
  })
})
it('reauthorizes the original directory and reloads the file', async () => {
  vi.mocked(loadLocalArtifactPreview).mockRejectedValueOnce(new Error('[XY-FILE-AUTH] 授权已失效')).mockResolvedValue({ name: 'report.txt', path: 'report.txt', kind: 'text', content: '恢复成功', sizeBytes: 12, truncated: false })
  vi.mocked(authorizeLocalDirectory).mockResolvedValue({ id: 'root', name: '原目录', path: '/tmp/root' })
  await fixture(async (container) => {
    await act(async () => button(container, '重新授权目录').click())
    expect(loadLocalArtifactPreview).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('恢复成功')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
it('ignores a late file choice after closing the preview', async () => {
  vi.mocked(loadLocalArtifactPreview).mockRejectedValue(new Error('[XY-FILE-MISSING] missing'))
  let finish!: (value: typeof selected) => void
  vi.mocked(authorizeLocalFiles).mockReturnValue(new Promise((resolve) => { finish = resolve }))
  await fixture(async (container, open, render) => {
    await act(async () => button(container, '选择文件打开').click())
    await render(null)
    await act(async () => finish(selected))
    expect(open).not.toHaveBeenCalled()
  })
})
it('keeps the missing file visible after cancelling file selection', async () => {
  vi.mocked(loadLocalArtifactPreview).mockRejectedValue(new Error('[XY-FILE-MISSING] missing'))
  vi.mocked(authorizeLocalFiles).mockResolvedValue({ directories: [], attachments: [] })
  await fixture(async (container, open) => {
    await act(async () => button(container, '选择文件打开').click())
    expect(container.textContent).toContain('原路径找不到文件')
    expect(open).not.toHaveBeenCalled()
  })
})
it('does not treat another directory as the original authorization', async () => {
  vi.mocked(loadLocalArtifactPreview).mockRejectedValue(new Error('[XY-FILE-AUTH] expired'))
  vi.mocked(authorizeLocalDirectory).mockResolvedValue({ id: 'other', name: '别的目录', path: '/tmp/other' })
  await fixture(async (container, open) => {
    await act(async () => button(container, '重新授权目录').click())
    expect(container.textContent).toContain('请选择原目录')
    expect(loadLocalArtifactPreview).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
  })
})
