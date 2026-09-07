// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { TaskArtifacts } from './TaskArtifacts'
import { revealLocalArtifact } from './localArtifactPreview'

vi.mock('./localArtifactPreview', async (original) => ({ ...await original<object>(), revealLocalArtifact: vi.fn() }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
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

it('keeps compact file rows accessible and opens the real artifact from its filename', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const onOpen = vi.fn()
  try {
    await act(async () => root.render(<TaskArtifacts conversation onOpen={onOpen} artifacts={[{
      id: 'report', name: '调研.xlsx', path: 'reports/调研.xlsx', rootId: 'workspace', rootName: '工作目录',
      kind: 'spreadsheet', sizeBytes: 2048, sourceTool: 'office.xlsx.create', createdAt: '',
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
