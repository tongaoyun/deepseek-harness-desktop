// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatPage, type ChatPageProps } from './ChatPage'
import { assistantEntry, toolSegment, userEntry } from './conversation/testing'
import type { ConversationEntry } from './conversation/types'
import type { XiaoyinTaskProjection } from './types'
import { loadLocalArtifactPreview } from './localArtifactPreview'

vi.mock('./localArtifactPreview', async (original) => ({ ...await original<typeof import('./localArtifactPreview')>(), loadLocalArtifactPreview: vi.fn(async (target) => ({ name: target.name, path: target.path, kind: 'code', content: 'const ok = true', sizeBytes: 15, truncated: false })) }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
  Element.prototype.scrollTo = vi.fn()
})
afterEach(() => vi.unstubAllGlobals())
const noop = () => {}
const base: ChatPageProps = {
  activeModel: 'model', composerRef: { current: null }, entries: [], harnessHealth: 'ready', harnessHealthDetail: '', harnessRunning: false,
  knowledgeBases: [], localDirectories: [], localFileError: '', messageListRef: { current: null },
  modelMenuOpen: false, modelPickerRef: { current: null }, models: [], pendingAttachments: [],
  onAddKnowledge: noop, onAddLocalDirectory: noop, onAddLocalFiles: noop, onCancel: noop, onEditTurn: noop,
  onPrompt: noop, onReconnect: noop, onRecoverHarness: noop, onRemoveAttachment: noop, onRemoveKnowledge: noop,
  onRemoveLocalDirectory: noop, onSelectModel: noop, onSubmit: noop, onToggleModelMenu: noop,
  prompt: '', runtimeStatus: 'ready', selectedKnowledgeBaseRefs: [], taskProjection: { status: 'idle', activity: '', updatedAt: '', steps: [], artifacts: [] },
}

it('uses bounded conversation layout only while entries exist', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} />))
    expect(container.querySelector('.chat-workspace.has-conversation')).toBeNull()
    await act(async () => root.render(<ChatPage {...base} entries={[assistantEntry('turn:1', '已完成')]} />))
    const workspace = container.querySelector('.chat-workspace.has-conversation')!
    expect(workspace).not.toBeNull()
    const list = workspace.querySelector('.message-list')!
    expect(workspace.querySelector('.task-composer')?.parentElement).toBe(list.parentElement)
    expect(list.querySelector('.task-composer')).toBeNull()
    await act(async () => root.render(<ChatPage {...base} taskId="new" />))
    expect(container.querySelector('.chat-workspace.has-conversation')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('replaces same-path review metadata across turns and clears previews on task switch', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const change = { id: 'root:one.ts', rootId: 'root', rootName: 'repo', name: 'one.ts', path: 'one.ts', action: 'updated' as const, sourceTool: 'local_files_write_text', changedAt: '' }
  const render = (backup: string) => root.render(<ChatPage {...base} taskId="one" taskProjection={{ ...base.taskProjection, status: 'completed', changes: [{ ...change, backupPath: `.xiaoyin-backups/${backup}/one.ts` }] }} entries={[assistantEntry('turn:1', 'done')]} />)
  try {
    await act(async () => render('first'))
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[aria-label="打开 one.ts"]')[0].click())
    expect(container.querySelector('.local-file-preview')).not.toBeNull()
    await act(async () => render('second'))
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[aria-label="打开 one.ts"]')[0].click())
    expect(loadLocalArtifactPreview).toHaveBeenCalledWith(expect.objectContaining({ path: '.xiaoyin-backups/second/one.ts' }))
    expect(container.querySelectorAll('.conversation-turn')).toHaveLength(1)
    await act(async () => root.render(<ChatPage {...base} taskId="two" taskProjection={{ ...base.taskProjection, status: 'completed', changes: [{ ...change, backupPath: '.xiaoyin-backups/second/one.ts' }] }} entries={[assistantEntry('turn:1', 'done')]} />))
    expect(container.querySelector('.local-file-preview')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('does not force-scroll incoming turns while reading older content', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const listRef = { current: null as HTMLDivElement | null }
  try {
    await act(async () => root.render(<ChatPage {...base} messageListRef={listRef} entries={[assistantEntry('turn:1', 'earlier')]} />))
    Object.defineProperties(listRef.current!, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } })
    await act(async () => listRef.current!.dispatchEvent(new Event('scroll', { bubbles: true })))
    vi.mocked(Element.prototype.scrollTo).mockClear()
    await act(async () => root.render(<ChatPage {...base} messageListRef={listRef} entries={[assistantEntry('turn:1', 'earlier'), assistantEntry('turn:2', 'new output')]} />))
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="滚动到最新消息"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('resets a scrolled-up viewport when switching between tasks with identical entry shape', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const listRef = { current: null as HTMLDivElement | null }
  const entries = [assistantEntry('turn:1', '同样的最后一条消息')]
  try {
    await act(async () => root.render(<ChatPage {...base} taskId="old" messageListRef={listRef} entries={entries} />))
    Object.defineProperties(listRef.current!, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } })
    await act(async () => listRef.current!.dispatchEvent(new Event('scroll', { bubbles: true })))
    vi.mocked(Element.prototype.scrollTo).mockClear()
    await act(async () => root.render(<ChatPage {...base} taskId="new" messageListRef={listRef} entries={entries} />))
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'auto' })
    expect(container.querySelector('[aria-label="滚动到最新消息"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('returns to the live turn after an explicit send from a scrolled-up conversation', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const listRef = { current: null as HTMLDivElement | null }
  const entries: ConversationEntry[] = [assistantEntry('turn:1', 'earlier')]
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault())
  try {
    await act(async () => root.render(<ChatPage {...base} onSubmit={onSubmit} messageListRef={listRef} prompt="新问题" entries={entries} />))
    Object.defineProperties(listRef.current!, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } })
    await act(async () => listRef.current!.dispatchEvent(new Event('scroll', { bubbles: true })))
    vi.mocked(Element.prototype.scrollTo).mockClear()
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(onSubmit).toHaveBeenCalledOnce()
    await act(async () => root.render(<ChatPage {...base} onSubmit={onSubmit} messageListRef={listRef} entries={[...entries, userEntry('u2', '新问题'), assistantEntry('pending', [], {}, 'streaming')]} />))
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'auto' })
    expect(container.querySelector('[aria-label="滚动到最新消息"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('keeps streamed text in place exactly once while tool cards append below it', async () => {
  const projection: XiaoyinTaskProjection = { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [] }
  const streaming = assistantEntry('turn:1', [
    { kind: 'text', id: '1:1', text: '正在生成的正文', streaming: true },
    toolSegment('call-1', 'bash', { label: '运行命令', command: 'pnpm test', status: 'running' }),
  ], {}, 'streaming')
  const settled = assistantEntry('turn:1', [
    { kind: 'text', id: '1:1', text: '正在生成的正文' },
    toolSegment('call-1', 'bash', { label: '运行命令', command: 'pnpm test' }),
    { kind: 'text', id: '1:2', text: '检查完成。' },
  ], { startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:02.000Z' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} harnessRunning taskProjection={projection} entries={[streaming]} />))
    expect(container.querySelector('.turn-status-line')?.textContent).toContain('已处理')
    expect(container.querySelector('.turn-status-line .turn-spinner')).not.toBeNull()
    expect(container.querySelector('.turn-activity')).not.toBeInstanceOf(HTMLDetailsElement)
    // The streamed text lives in the turn body exactly once, with the tool card below it.
    expect(container.textContent!.split('正在生成的正文')).toHaveLength(2)
    expect(container.querySelector('.streaming-response')?.textContent).toContain('正在生成的正文')
    expect(container.querySelector('.tool-group')).not.toBeNull()
    expect(container.querySelectorAll('.tool-group .timeline-tool')).toHaveLength(1)
    await act(async () => root.render(<ChatPage {...base} taskProjection={{ ...projection, status: 'completed' }} entries={[settled]} />))
    // Settlement never removes what was already written, and never duplicates it.
    expect(container.textContent!.split('正在生成的正文')).toHaveLength(2)
    expect(container.textContent).toContain('检查完成。')
    expect(container.querySelector('.turn-status-line')?.textContent).toContain('用时 2秒')
    expect(container.querySelector<HTMLDetailsElement>('.turn-activity')?.open).toBe(false)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows Codex-style subtask status rows from the Harness projection', async () => {
  const projection: XiaoyinTaskProjection = {
    ...base.taskProjection, status: 'running', activity: '正在处理', updatedAt: '',
    subagents: [
      { id: 'image', label: '图片服务', status: 'running', startedAt: '' },
      { id: 'xiaokai', label: '小凯', status: 'completed', startedAt: '', completedAt: '' },
      { id: 'cdp', label: 'CDP', status: 'failed', startedAt: '', completedAt: '' },
    ],
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} harnessRunning taskProjection={projection} entries={[assistantEntry('turn:1', [], {}, 'streaming')]} />))
    const list = container.querySelector('[aria-label="任务状态"]')!
    expect(list.textContent).toContain('图片服务')
    expect(list.textContent).toContain('执行中')
    expect(list.textContent).toContain('小凯')
    expect(list.textContent).toContain('已完成')
    expect(list.textContent).toContain('CDP')
    expect(list.textContent).toContain('失败')
    expect(list.querySelector('.turn-spinner')).not.toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows one quiet activity summary without nesting successful tool receipts', async () => {
  const entries = [assistantEntry('turn:1', [
    { kind: 'commentary', id: 'progress', text: '我先检查工作簿。' },
    { kind: 'thinking', id: 'private-1', text: 'Private model reasoning' },
    toolSegment('discover', 'tool_discover', { label: '选择所需工具' }),
    { kind: 'thinking', id: 'private-2', text: 'More private reasoning' },
    toolSegment('skill', 'skill', { label: '加载文档洞察' }),
    toolSegment('roots', 'local_files_roots', { label: '检查可用工作目录' }),
    toolSegment('read', 'office_document_read', {
      label: '读取 inventory-report.xlsx', path: 'inventory-report.xlsx',
      completedAt: '2026-09-01T00:00:00.450Z',
    }),
    toolSegment('check', 'office_document_check', { label: '检查文档结构' }),
    toolSegment('report', 'task_report', { label: '整理交付结果' }),
    { kind: 'text', id: 'answer', text: '合计 80.50。' },
  ], { startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:17.000Z' })]
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} entries={entries} />))
    const groups = container.querySelectorAll<HTMLElement>('.tool-group')
    expect(groups).toHaveLength(1)
    expect(groups[0]).toBeInstanceOf(HTMLDetailsElement)
    expect(groups[0].textContent).toContain('已加载技能 已读取文件 已检查文档结构')
    expect(container.textContent).toContain('合计 80.50。')
    expect(container.querySelector('.turn-commentary')?.textContent).toContain('我先检查工作簿。')
    expect(container.textContent).toContain('17秒')
    expect(container.textContent).not.toContain('0秒')
    expect(container.textContent).not.toContain('思考过程')
    expect(container.textContent).not.toContain('Private model reasoning')
    expect((groups[0] as HTMLDetailsElement).open).toBe(false)
    await act(async () => groups[0].querySelector('summary')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(groups[0].querySelectorAll('.timeline-tool').length).toBeGreaterThan(0)
    expect(container.textContent).not.toContain('选择所需工具')
    expect(container.textContent).not.toContain('整理交付结果')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('condenses directory setup and listing into one Codex-style activity row', async () => {
  const entry = assistantEntry('turn:1', [
    { kind: 'commentary', id: 'progress', text: '我先看一下下载目录里的内容。' },
    toolSegment('roots', 'local_files_roots', { label: '检查可用工作目录' }),
    toolSegment('list', 'local_files_list', { label: '查看目录', path: '.', itemCount: 135, detail: '135 项' }),
    { kind: 'text', id: 'answer', text: '下载目录里主要有这些内容。' },
  ], { startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:14.000Z' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} entries={[entry]} />))
    const activity = container.querySelector<HTMLDetailsElement>('.turn-activity')!
    await act(async () => activity.querySelector('summary')!.click())
    const group = activity.querySelector<HTMLElement>('.tool-group')!
    expect(group).toBeInstanceOf(HTMLDetailsElement)
    expect(group.querySelector('summary')?.textContent).toBe('已列出当前目录中的文件')
    expect((group as HTMLDetailsElement).open).toBe(false)
    await act(async () => group.querySelector('summary')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(activity.querySelector('.timeline-tool')).not.toBeNull()
    expect(activity.textContent).toContain('检查可用工作目录')
    expect(activity.querySelector('.timeline-output')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('hides the internal plan-review tool instead of exposing a failed tool row', async () => {
  const entry = assistantEntry('turn:1', [
    toolSegment('plan', 'exit_plan_mode', { label: '提交计划审阅', status: 'failed', detail: 'Error: The user chose to keep planning; revise the plan and present it again.' }),
    { kind: 'text', id: 'answer', text: '已按反馈更新计划。' },
  ], { startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:04.000Z' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} entries={[entry]} />))
    expect(container.querySelector('.turn-activity')).toBeNull()
    expect(container.querySelector('.timeline-tool')).toBeNull()
    expect(container.textContent).not.toContain('Error: The user chose to keep planning')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('omits subsecond duration instead of displaying a zero or approximate time', async () => {
  const entry = assistantEntry('turn:1', '完成', { startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:00.450Z' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} entries={[entry]} />))
    expect(container.querySelector('.turn-facts')?.textContent ?? '').not.toMatch(/<1秒|0秒/)
    expect(container.textContent).toContain('完成')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('shows context compaction as a replayable timeline event', async () => {
  const entry = assistantEntry('turn:1', [
    { kind: 'commentary', id: 'progress', text: '继续处理长任务。' },
    { kind: 'status', id: 'compaction:c-1', statusKind: 'compaction', label: '上下文已自动压缩', status: 'completed', startedAt: '2026-09-01T00:00:02.000Z', completedAt: '2026-09-01T00:00:04.000Z' },
    { kind: 'text', id: 'answer', text: '任务完成。' },
  ], { startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:05.000Z' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} entries={[entry]} />))
    expect(container.querySelector('.turn-event')?.textContent).toContain('上下文已自动压缩2秒')
    expect(container.querySelector('.turn-commentary')?.textContent).toContain('继续处理长任务。')
    expect(container.textContent).toContain('任务完成。')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('keeps provider token telemetry out of the visible conversation', async () => {
  const entry = assistantEntry('turn:1', '2', { tokenUsage: { inputTokens: 120, cacheReadTokens: 80, cacheWriteTokens: 10, outputTokens: 5 } })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} entries={[entry]} />))
    expect(container.querySelector('.turn-facts')).toBeNull()
    expect(container.textContent).not.toContain('缓存读取')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('never drops text when a tool call lands between two text segments', async () => {
  const entries = [assistantEntry('turn:1', [
    { kind: 'text', id: '1:1', text: '我先检查文件。' },
    toolSegment('call-1', 'local_files_read_text', { label: '读取 a.ts' }),
    { kind: 'text', id: '1:2', text: '文件已检查完毕。' },
  ])]
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} entries={entries} />))
    expect(container.textContent).toContain('我先检查文件。')
    expect(container.textContent).toContain('文件已检查完毕。')
    expect(container.textContent!.split('我先检查文件。')).toHaveLength(2)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('renders a textless turn without an error state', async () => {
  const entries = [assistantEntry('turn:1', [toolSegment('call-1', 'local_files_write_text', { label: '写入 report.md' })])]
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} taskProjection={{ ...base.taskProjection, status: 'completed' }} entries={entries} />))
    expect(container.querySelector('.tool-group')).not.toBeNull()
    expect(container.textContent).toContain('本轮没有文字说明')
    expect(container.textContent).not.toContain('失败')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('stops one turn, disables repeat stops and restores the composer without a fake failure', async () => {
  const onCancel = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (activity: string, status: XiaoyinTaskProjection['status'], turnStatus: 'streaming' | 'canceled') => root.render(<ChatPage {...base} onCancel={onCancel} harnessRunning={status === 'running'} taskProjection={{ ...base.taskProjection, activity, status }} entries={[assistantEntry('turn:1', [], {}, turnStatus)]} />)
  try {
    await act(async () => render('正在处理', 'running', 'streaming'))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止本轮"]')!.click())
    expect(onCancel).toHaveBeenCalledOnce()
    await act(async () => render('正在停止', 'running', 'streaming'))
    expect(container.querySelector<HTMLButtonElement>('[aria-label="正在停止"]')!.disabled).toBe(true)
    await act(async () => render('已停止', 'canceled', 'canceled'))
    expect(container.querySelector('[aria-label="发送"]')).not.toBeNull()
    expect(container.textContent).toContain('已停止')
    expect(container.textContent).not.toContain('失败')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('explains a slow first model response instead of showing an indefinite generic spinner', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const startedAt = new Date(Date.now() - 11_000).toISOString()
  try {
    await act(async () => root.render(<ChatPage {...base} harnessRunning taskProjection={{ ...base.taskProjection, status: 'running', activity: '正在分析任务', startedAt }} entries={[assistantEntry('turn:1', [], { startedAt }, 'streaming')]} />))
    expect(container.textContent).toContain('正在分析任务 · 已处理 11秒')
    expect(container.textContent).toContain('模型响应较慢，仍在等待')
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('offers edit on the last turn and copy once the turn has text', async () => {
  const onEditTurn = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} onEditTurn={onEditTurn} entries={[assistantEntry('turn:1', '结论。')]} />))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="编辑后重发"]')!.click())
    expect(onEditTurn).toHaveBeenCalledOnce()
    expect(container.querySelector('[aria-label="复制回答"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('initially renders only recent long-history turns, then loads earlier turns without changing indexes', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const entries = Array.from({ length: 1000 }, (_, index) => assistantEntry(`turn:${index}`, `历史-${index}`))
  try {
    await act(async () => root.render(<ChatPage {...base} taskId="long" entries={entries} />))
    expect(container.querySelectorAll('.conversation-turn')).toHaveLength(60)
    expect(container.textContent).not.toContain('历史-939')
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-load-earlier')!.click())
    expect(container.querySelectorAll('.conversation-turn')).toHaveLength(120)
    expect(container.textContent).toContain('历史-880')
    await act(async () => root.render(<ChatPage {...base} taskId="other" entries={entries} />))
    expect(container.querySelectorAll('.conversation-turn')).toHaveLength(60)
  } finally { await act(async () => root.unmount()); container.remove() }
})
