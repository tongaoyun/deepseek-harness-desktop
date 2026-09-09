// @vitest-environment jsdom
import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { FileChangesCard } from './FileChangesCard'
import { InlineTaskActivity } from './InlineTaskActivity'
import { ExecutionTimeline } from './ExecutionTimeline'
import { LocalFilePreviewPanel } from './LocalFilePreviewPanel'
import { RichMessage } from './RichMessage'
import { codeDiffRows } from './codeDiff'
import { loadLocalArtifactPreview, undoLocalFileChange } from './localArtifactPreview'
import type { TaskFileChange, TaskMonitorState } from './types'

vi.mock('./localArtifactPreview', async (original) => ({ ...await original<typeof import('./localArtifactPreview')>(), loadLocalArtifactPreview: vi.fn(), undoLocalFileChange: vi.fn() }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })
const change: TaskFileChange = { id: 'one', rootId: 'root', rootName: 'repo', path: 'one.ts', name: 'one.ts', action: 'updated', sourceTool: 'local_files_write_text', backupPath: '.xiaoyin-backups/first/one.ts', afterHash: 'after', beforeHash: 'before', changedAt: '' }
const button = (text: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)!
function mount() { const element = document.body.appendChild(document.createElement('div')); const root = createRoot(element); return { element, root, cleanup: async () => { await act(async () => root.unmount()); element.remove() } } }

it('keeps tool disclosures stable through completion and the next tool starting', async () => {
  const app = mount()
  const first = { id: 'one', kind: 'tool' as const, status: 'running' as const, label: '读取文件', toolName: 'read_file', occurredAt: '' }
  try {
    await act(async () => app.root.render(<ExecutionTimeline entries={[first]} />))
    const group = app.element.querySelector<HTMLDetailsElement>('.execution-step-group')!
    expect(group.open).toBe(false)
    await act(async () => app.root.render(<ExecutionTimeline entries={[{ ...first, status: 'completed' }]} />))
    expect(group.open).toBe(false)
    await act(async () => group.querySelector('summary')!.click())
    expect(group.open).toBe(true)
    await act(async () => app.root.render(<ExecutionTimeline entries={[{ ...first, status: 'completed' }, { ...first, id: 'two' }]} />))
    expect(app.element.querySelector('.execution-step-group')).toBe(group)
    expect(group.open).toBe(true)
    await act(async () => app.root.render(<ExecutionTimeline entries={[{ ...first, status: 'completed' }, { ...first, id: 'two', status: 'completed' }]} />))
    expect(group.open).toBe(true)
  } finally { await app.cleanup() }
})

it('collapses completion before paint, without an intermediate expanded frame', async () => {
  const app = mount(); const snapshots: Array<string | null> = []
  const monitor: TaskMonitorState = { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [], timeline: [{ id: 'tool', kind: 'tool', label: '读取', status: 'completed', occurredAt: '' }] }
  function PaintProbe({ status }: { status: string }) {
    useLayoutEffect(() => { snapshots.push(app.element.querySelector('.inline-task-summary')!.getAttribute('aria-expanded')) }, [status])
    return null
  }
  const render = (status: TaskMonitorState['status']) => app.root.render(<><InlineTaskActivity monitor={{ ...monitor, status }} /><PaintProbe status={status} /></>)
  try {
    await act(async () => render('running'))
    await act(async () => render('completed'))
    expect(snapshots).toEqual(['true', 'false'])
  } finally { await app.cleanup() }
})

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

it('keeps approval actions visible even after the running process was collapsed', async () => {
  const app = mount(); const decide = vi.fn()
  let monitor: TaskMonitorState = { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [], timeline: [{ id: 'tool', label: '检查', kind: 'tool', status: 'completed', occurredAt: '' }] }
  const render = () => app.root.render(<InlineTaskActivity monitor={monitor} onApprovalDecision={decide} />)
  try {
    await act(async () => render())
    await act(async () => app.element.querySelector<HTMLButtonElement>('.inline-task-summary')!.click())
    monitor = { ...monitor, timeline: [...monitor.timeline!, { id: 'approval', approvalId: 'permission', kind: 'approval', label: '确认操作', status: 'running', occurredAt: '' }] }
    await act(async () => render())
    expect(app.element.querySelector('.inline-task-summary')?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => app.element.querySelector<HTMLButtonElement>('.inline-task-summary')!.click())
    await act(async () => button('允许本次操作').click())
    expect(decide).toHaveBeenCalledWith('permission', 'allow')
  } finally { await app.cleanup() }
})

it('keeps the latest streamed text visible when history is collapsed', async () => {
  const app = mount()
  const monitor: TaskMonitorState = { status: 'running', activity: '正在生成回复', updatedAt: '', steps: [], artifacts: [], timeline: [
    { id: 'old', kind: 'assistant', label: '说明', text: '旧的过程说明', status: 'completed', occurredAt: '' },
    { id: 'live', kind: 'assistant', label: '回复', text: '正在生成正文', status: 'running', occurredAt: '' },
  ] }
  try {
    await act(async () => app.root.render(<InlineTaskActivity monitor={monitor} />))
    await act(async () => app.element.querySelector<HTMLButtonElement>('.inline-task-summary')!.click())
    expect(app.element.textContent).toContain('正在生成正文')
    expect(app.element.textContent).not.toContain('旧的过程说明')
    await act(async () => app.root.render(<InlineTaskActivity monitor={{ ...monitor, timeline: [monitor.timeline![0], { ...monitor.timeline![1], text: '正在生成正文，继续更新' }] }} />))
    expect(app.element.textContent).toContain('正在生成正文，继续更新')
    expect(app.element.querySelector('.inline-task-summary')?.getAttribute('aria-expanded')).toBe('false')
  } finally { await app.cleanup() }
})

it('keeps important notices and the latest progress visible after a tool starts in collapsed history', async () => {
  const app = mount()
  const monitor: TaskMonitorState = { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [], timeline: [
    { id: 'old', kind: 'assistant', label: '说明', text: '旧的过程说明', status: 'completed', occurredAt: '' },
    { id: 'live', kind: 'assistant', label: '说明', text: '已检查文件，开始修改', status: 'completed', occurredAt: '' },
    { id: 'warning', kind: 'warning', label: '部分资料缺失', text: '请补充附件', status: 'completed', occurredAt: '' },
    { id: 'failed', kind: 'file', label: '写入文件', toolName: 'local_files_write_text', detail: '磁盘空间不足', status: 'failed', occurredAt: '' },
    { id: 'tool', kind: 'file', label: '读取文件', toolName: 'local_files_read_text', status: 'running', occurredAt: '' },
  ] }
  try {
    await act(async () => app.root.render(<InlineTaskActivity monitor={monitor} />))
    await act(async () => app.element.querySelector<HTMLButtonElement>('.inline-task-summary')!.click())
    expect(app.element.textContent).toContain('已检查文件，开始修改')
    expect(app.element.textContent).toContain('请补充附件')
    expect(app.element.textContent).toContain('磁盘空间不足')
    expect(app.element.textContent).not.toContain('旧的过程说明')
    expect(app.element.querySelector('.inline-task-summary')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => app.root.render(<InlineTaskActivity monitor={{ ...monitor, status: 'canceled' }} />))
    expect(app.element.textContent).not.toContain('磁盘空间不足')
    expect(app.element.querySelector('.inline-task-summary')?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => app.element.querySelector<HTMLButtonElement>('.inline-task-summary')!.click())
    expect(app.element.textContent).toContain('磁盘空间不足')
  } finally { await app.cleanup() }
})

it('deduplicates approval submissions across collapsing, reports errors locally and allows retry', async () => {
  const app = mount()
  let reject: (reason: Error) => void = () => {}
  const decide = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise })).mockResolvedValue(undefined)
  const monitor: TaskMonitorState = { status: 'running', activity: '等待确认', updatedAt: '', steps: [], artifacts: [], timeline: [{ id: 'approve', approvalId: 'operation', kind: 'approval', label: '修改文件', status: 'running', occurredAt: '' }] }
  try {
    await act(async () => app.root.render(<InlineTaskActivity monitor={monitor} onApprovalDecision={decide} />))
    await act(async () => { button('允许本次操作').click(); button('允许本次操作').click() })
    expect(decide).toHaveBeenCalledTimes(1)
    expect(button('拒绝').disabled).toBe(true)
    await act(async () => app.element.querySelector<HTMLButtonElement>('.inline-task-summary')!.click())
    expect(button('允许本次操作').disabled).toBe(true)
    expect(app.element.textContent).toContain('正在提交确认')
    await act(async () => reject(new Error('网络中断，请重试')))
    expect(app.element.querySelector('[role="alert"]')?.textContent).toBe('网络中断，请重试')
    await act(async () => button('允许本次操作').click())
    expect(decide).toHaveBeenCalledTimes(2)
    expect(app.element.textContent).toContain('确认已发送')
    expect(button('允许本次操作').disabled).toBe(true)
  } finally { await app.cleanup() }
})

it('keeps confirmation outside collapsed details and disables it while stopping', async () => {
  const app = mount(); const decide = vi.fn()
  const monitor: TaskMonitorState = { status: 'running', activity: '等待确认', updatedAt: '', steps: [], artifacts: [], timeline: [{ id: 'approve', approvalId: 'operation', kind: 'approval', label: '确认', status: 'running', occurredAt: '' }] }
  try {
    await act(async () => app.root.render(<InlineTaskActivity monitor={monitor} onApprovalDecision={decide} />))
    await act(async () => app.element.querySelector('details summary')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    expect(button('允许本次操作').closest('details')).toBeNull()
    await act(async () => app.root.render(<InlineTaskActivity monitor={{ ...monitor, activity: '正在停止' }} onApprovalDecision={decide} />))
    expect(button('允许本次操作').disabled).toBe(true)
    await act(async () => button('允许本次操作').click())
    expect(decide).not.toHaveBeenCalled()
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
