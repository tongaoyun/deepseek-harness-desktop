// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalFilePreviewPanel } from './LocalFilePreviewPanel'
import { artifactFailure, htmlArtifactPreviewUrl, loadLocalArtifactPreview, openLocalArtifact, type LocalArtifactTarget } from './localArtifactPreview'
import { authorizeLocalDirectory, authorizeLocalFiles } from './harness'

vi.mock('./localArtifactPreview', async (original) => ({ ...await original<object>(), loadLocalArtifactPreview: vi.fn(), revealLocalArtifact: vi.fn(), htmlArtifactPreviewUrl: vi.fn(), openLocalArtifact: vi.fn() }))
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
it('reads Markdown with headings and tables and switches back to source', async () => {
  vi.mocked(loadLocalArtifactPreview).mockResolvedValue({ name: 'notes.md', path: 'notes.md', kind: 'markdown', content: '# 交付清单\n\n| 文件 | 状态 |\n| --- | --- |\n| 报表 | 完成 |', sizeBytes: 100, truncated: false })
  await fixture(async (container, _open, render) => {
    await render({ ...target, path: 'notes.md', name: 'notes.md', review: undefined })
    expect(container.querySelector('h1')?.textContent).toBe('交付清单')
    expect(container.querySelector('table')?.textContent).toContain('报表')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看源码"]')!.click())
    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('code')?.textContent).toContain('# 交付清单')
  })
})
it('keeps readable content when opening the original application fails', async () => {
  vi.mocked(loadLocalArtifactPreview).mockResolvedValue({ name: 'report.txt', path: 'report.txt', kind: 'text', content: '可继续阅读', sizeBytes: 12, truncated: false })
  vi.mocked(openLocalArtifact).mockRejectedValue(new Error('未安装对应应用'))
  await fixture(async container => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="使用本机应用打开"]')!.click())
    expect(container.textContent).toContain('可继续阅读')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('未安装对应应用')
    expect(container.textContent).not.toContain('无法打开文件')
  })
})
it('opens HTML in an isolated frame and switches to source without losing the artifact', async () => {
  vi.mocked(loadLocalArtifactPreview).mockResolvedValue({ name: 'tool.html', path: 'tool.html', kind: 'code', language: 'html', content: '<button>计算</button>', sizeBytes: 24, truncated: false })
  vi.mocked(htmlArtifactPreviewUrl).mockResolvedValue('http://127.0.0.1:12345/token/root/tool.html')
  await fixture(async (container, _open, render) => {
    await render({ ...target, name: 'tool.html', path: 'tool.html', review: undefined })
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.src).toBe('http://127.0.0.1:12345/token/root/tool.html')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看源码"]')!.click())
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('code')!.textContent).toContain('<button>计算</button>')
  })
})
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
