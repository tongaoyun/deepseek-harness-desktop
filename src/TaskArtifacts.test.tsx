// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskArtifacts } from './TaskArtifacts'
import { loadLocalArtifactPreview, revealLocalArtifact } from './localArtifactPreview'

vi.mock('./localArtifactPreview', async (original) => ({ ...await original<object>(), revealLocalArtifact: vi.fn(), loadLocalArtifactPreview: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('previews image files from completed and restored tasks, enlarges them, and retains file actions', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  URL.createObjectURL = vi.fn(() => 'blob:local-image')
  URL.revokeObjectURL = vi.fn()
  vi.mocked(loadLocalArtifactPreview).mockReset().mockResolvedValue({ kind: 'image', name: '海报.PNG', path: 'out/海报.PNG', sizeBytes: 50, truncated: false, dataUrl: 'data:image/png;base64,aW1hZ2U=' })
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const onOpen = vi.fn()
  try {
    await act(async () => root.render(<TaskArtifacts conversation onOpen={onOpen} artifacts={[{
      id: 'poster', name: '海报.PNG', path: 'out/海报.PNG', rootId: 'workspace', rootName: '工作目录',
      kind: 'file', action: 'published', sourceTool: 'local_files_publish', createdAt: '',
    }]} />))
    expect(loadLocalArtifactPreview).toHaveBeenCalledWith({ rootId: 'workspace', rootName: '工作目录', path: 'out/海报.PNG', name: '海报.PNG' })
    const opener = container.querySelector<HTMLButtonElement>('[aria-label="查看 海报.PNG"]')!
    expect(opener.querySelector('img')?.src).toBe('blob:local-image')
    await act(async () => { opener.focus(); opener.click() })
    expect(document.body.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('blob:local-image')
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
    await act(async () => container.querySelector<HTMLButtonElement>('.artifact-name')!.click())
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ rootId: 'workspace', path: 'out/海报.PNG' }))
  } finally { await act(async () => root.unmount()); container.remove() }
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-image')
})

it('keeps the original file available when an image preview is too large and can retry', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  URL.createObjectURL = vi.fn(() => 'blob:retried-image')
  URL.revokeObjectURL = vi.fn()
  const metadata = { kind: 'image' as const, name: 'photo.webp', path: 'photo.webp', sizeBytes: 13000000, truncated: true }
  vi.mocked(loadLocalArtifactPreview).mockReset().mockResolvedValueOnce(metadata).mockResolvedValueOnce({ ...metadata, truncated: false, dataUrl: 'data:image/webp;base64,aW1hZ2U=' })
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const onOpen = vi.fn()
  try {
    await act(async () => root.render(<TaskArtifacts onOpen={onOpen} artifacts={[{ id: 'photo', name: 'photo.webp', path: 'photo.webp', rootId: 'root', rootName: '目录', kind: 'image', sourceTool: 'local_files_publish', createdAt: '' }]} />))
    expect(container.textContent).toContain('图片加载失败')
    await act(async () => container.querySelector<HTMLButtonElement>('.artifact-name')!.click())
    expect(onOpen).toHaveBeenCalledOnce()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="重新加载 photo.webp"]')!.click())
    expect(container.querySelector('img')?.src).toBe('blob:retried-image')
  } finally { await act(async () => root.unmount()); container.remove() }
})
it('opens published existing files without inventing a created-file review baseline', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const onOpen = vi.fn()
  try {
    await act(async () => root.render(<TaskArtifacts conversation onOpen={onOpen} artifacts={[{
      id: 'report', name: '报告.pdf', path: '报告.pdf', rootId: 'workspace', rootName: '工作目录',
      kind: 'pdf', action: 'published', sourceTool: 'local_files_publish', createdAt: '',
    }]} />))
    expect(container.textContent).toContain('交付了 1 个文件')
    expect(container.textContent).toContain('已就绪')
    await act(async () => { (container.querySelector('.artifact-name') as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith({ rootId: 'workspace', rootName: '工作目录', path: '报告.pdf', name: '报告.pdf' })
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('labels official present declarations as delivered files', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<TaskArtifacts conversation onOpen={() => undefined} artifacts={[{
      id: 'presented', name: '交付.xlsx', path: 'reports/交付.xlsx', rootId: 'harness-workspace', rootName: 'Harness 工作区',
      kind: 'spreadsheet', action: 'presented', sourceTool: 'present', createdAt: '',
    }]} />))
    expect(container.querySelector('header.sr-only')?.textContent).toBe('交付了 1 个文件')
    expect(container.textContent).toContain('已交付')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('keeps compact file rows accessible and opens the real artifact from its filename', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const onOpen = vi.fn()
  try {
    await act(async () => root.render(<TaskArtifacts conversation onOpen={onOpen} artifacts={[{
      id: 'report', name: '调研.xlsx', path: 'reports/调研.xlsx', rootId: 'workspace', rootName: '工作目录',
      kind: 'spreadsheet', sizeBytes: 2048, sourceTool: 'present', createdAt: '',
    }]} />))
    expect(container.querySelector('header.sr-only')?.textContent).toBe('生成了 1 个文件')
    expect(container.querySelector('article.artifact-spreadsheet')).not.toBeNull()
    expect(container.textContent).toContain('2.0 KB')
    expect(container.textContent).toContain('工作目录 / reports/调研.xlsx')
    await act(async () => { (container.querySelector('.artifact-name') as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ rootId: 'workspace', path: 'reports/调研.xlsx' }))
    expect(container.querySelector('[aria-label="在文件夹中显示 调研.xlsx"]')).not.toBeNull()
    onOpen.mockClear()
    vi.mocked(revealLocalArtifact).mockRejectedValueOnce(new Error('[XY-FILE-MISSING] missing'))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="在文件夹中显示 调研.xlsx"]')!.click())
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ rootId: 'workspace', path: 'reports/调研.xlsx' }))
  } finally { await act(async () => root.unmount()); container.remove() }
})
