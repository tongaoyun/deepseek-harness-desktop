// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatPage, type ChatPageProps } from './ChatPage'
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
  activeModel: 'model', composerRef: { current: null }, harnessHealth: 'ready', harnessHealthDetail: '', harnessRunning: false,
  knowledgeBases: [], localDirectories: [], localFileError: '', messageListRef: { current: null }, messages: [],
  modelMenuOpen: false, modelPickerRef: { current: null }, models: [], pendingAttachments: [],
  onAddKnowledge: noop, onAddLocalDirectory: noop, onAddLocalFiles: noop, onCancel: noop, onPrepareRetry: noop,
  onPrompt: noop, onReconnect: noop, onRecoverHarness: noop, onRemoveAttachment: noop, onRemoveKnowledge: noop,
  onRemoveLocalDirectory: noop, onSelectModel: noop, onSubmit: noop, onToggleModelMenu: noop,
  prompt: '', runtimeStatus: 'ready', selectedKnowledgeBaseRefs: [], taskProjection: { status: 'idle', activity: '', updatedAt: '', steps: [], artifacts: [] },
}

it('uses bounded conversation layout only while messages exist', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<ChatPage {...base} />))
    expect(container.querySelector('.chat-workspace.has-conversation')).toBeNull()
    await act(async () => root.render(<ChatPage {...base} messages={[{ role: 'assistant', text: '已完成' }]} />))
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
  const messages = ['first', 'second'].map((name) => ({ role: 'assistant' as const, text: name, projection: { ...base.taskProjection, status: 'completed' as const, changes: [{ ...change, backupPath: `.xiaoyin-backups/${name}/one.ts` }] } }))
  try {
    await act(async () => root.render(<ChatPage {...base} taskId="one" messages={messages} />))
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[aria-label="打开 one.ts"]')[0].click())
    expect(container.querySelector('.local-file-preview')).not.toBeNull()
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[aria-label="打开 one.ts"]')[1].click())
    expect(loadLocalArtifactPreview).toHaveBeenCalledWith(expect.objectContaining({ path: '.xiaoyin-backups/second/one.ts' }))
    expect(container.querySelectorAll('.conversation-turn')).toHaveLength(2)
    await act(async () => root.render(<ChatPage {...base} taskId="two" messages={messages} />))
    expect(container.querySelector('.local-file-preview')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('does not force-scroll incoming messages while reading older content', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const listRef = { current: null as HTMLDivElement | null }
  try {
    await act(async () => root.render(<ChatPage {...base} messageListRef={listRef} messages={[{ role: 'assistant', text: 'earlier' }]} />))
    Object.defineProperties(listRef.current!, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } })
    await act(async () => listRef.current!.dispatchEvent(new Event('scroll', { bubbles: true })))
    vi.mocked(Element.prototype.scrollTo).mockClear()
    await act(async () => root.render(<ChatPage {...base} messageListRef={listRef} messages={[{ role: 'assistant', text: 'earlier' }, { role: 'assistant', text: 'new output' }]} />))
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-label="滚动到最新消息"]')).not.toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('resets a scrolled-up viewport when switching between tasks with identical message shape', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const listRef = { current: null as HTMLDivElement | null }
  const messages = [{ role: 'assistant' as const, text: '同样的最后一条消息' }]
  try {
    await act(async () => root.render(<ChatPage {...base} taskId="old" messageListRef={listRef} messages={messages} />))
    Object.defineProperties(listRef.current!, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } })
    await act(async () => listRef.current!.dispatchEvent(new Event('scroll', { bubbles: true })))
    vi.mocked(Element.prototype.scrollTo).mockClear()
    await act(async () => root.render(<ChatPage {...base} taskId="new" messageListRef={listRef} messages={messages} />))
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'auto' })
    expect(container.querySelector('[aria-label="滚动到最新消息"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('returns to the live turn after an explicit send from a scrolled-up conversation', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const listRef = { current: null as HTMLDivElement | null }
  const messages = [{ role: 'assistant' as const, text: 'earlier' }]
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault())
  try {
    await act(async () => root.render(<ChatPage {...base} onSubmit={onSubmit} messageListRef={listRef} prompt="新问题" messages={messages} />))
    Object.defineProperties(listRef.current!, { scrollHeight: { value: 2000, configurable: true }, clientHeight: { value: 400, configurable: true } })
    await act(async () => listRef.current!.dispatchEvent(new Event('scroll', { bubbles: true })))
    vi.mocked(Element.prototype.scrollTo).mockClear()
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(onSubmit).toHaveBeenCalledOnce()
    await act(async () => root.render(<ChatPage {...base} onSubmit={onSubmit} messageListRef={listRef} messages={[...messages, { role: 'user', text: '新问题' }, { role: 'assistant', text: '', pending: true }]} />))
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'auto' })
    expect(container.querySelector('[aria-label="滚动到最新消息"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('streams each message once, then collapses history without hiding the final response', async () => {
  const projection: XiaoyinTaskProjection = { status: 'running', activity: '正在处理', updatedAt: '', steps: [], artifacts: [], timeline: [
    { id: 'tool', kind: 'command', label: '检查项目', status: 'completed', text: 'pnpm test', occurredAt: '' },
    { id: 'answer', kind: 'assistant', label: '回复', status: 'running', text: '正在生成的正文', occurredAt: '' },
  ] }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (pending: boolean) => root.render(<ChatPage {...base} harnessRunning={pending} taskProjection={projection} messages={[{ role: 'assistant', text: '正在生成的正文', pending }]} />)
  try {
    await act(async () => render(true))
    expect(container.querySelector('.execution-timeline')!.textContent).toContain('正在生成的正文')
    expect(container.textContent!.split('正在生成的正文')).toHaveLength(2)
    expect(container.querySelector('.active-task-strip')).toBeNull()
    expect(container.querySelector('.timeline-commentary-label')).toBeNull()
    projection.status = 'completed'
    await act(async () => render(false))
    expect(container.querySelector('.inline-task-summary')!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.execution-timeline')).toBeNull()
    expect(container.textContent).toContain('正在生成的正文')
    await act(async () => container.querySelector<HTMLButtonElement>('.inline-task-summary')!.click())
    expect(container.querySelector('.execution-timeline')!.textContent).toContain('pnpm test')
    expect(container.textContent!.split('正在生成的正文')).toHaveLength(2)
  } finally { await act(async () => root.unmount()); container.remove() }
})

it('stops one turn, disables repeat stops and restores the composer without a fake failure', async () => {
  const onCancel = vi.fn()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (activity: string, status: XiaoyinTaskProjection['status']) => root.render(<ChatPage {...base} onCancel={onCancel} harnessRunning={status === 'running'} taskProjection={{ ...base.taskProjection, activity, status }} messages={[{ role: 'assistant', text: '', pending: status === 'running' }]} />)
  try {
    await act(async () => render('正在处理', 'running'))
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止本轮"]')!.click())
    expect(onCancel).toHaveBeenCalledOnce()
    await act(async () => render('正在停止', 'running'))
    expect(container.querySelector<HTMLButtonElement>('[aria-label="正在停止"]')!.disabled).toBe(true)
    await act(async () => render('已停止', 'canceled'))
    expect(container.querySelector('[aria-label="发送"]')).not.toBeNull()
    expect(container.textContent).toContain('已停止')
    expect(container.querySelector('[aria-label="复制回答"]')).toBeNull()
    expect(container.textContent).not.toContain('失败')
  } finally { await act(async () => root.unmount()); container.remove() }
})
it('initially renders only recent long-history messages, then loads earlier messages without changing message indexes', async () => {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  const messages = Array.from({ length: 1000 }, (_, index) => ({ role: 'assistant' as const, text: `历史-${index}` }))
  try {
    await act(async () => root.render(<ChatPage {...base} taskId="long" messages={messages} />))
    expect(container.querySelectorAll('.conversation-turn')).toHaveLength(60)
    expect(container.textContent).not.toContain('历史-939')
    await act(async () => container.querySelector<HTMLButtonElement>('.conversation-load-earlier')!.click())
    expect(container.querySelectorAll('.conversation-turn')).toHaveLength(120)
    expect(container.textContent).toContain('历史-880')
    await act(async () => root.render(<ChatPage {...base} taskId="other" messages={messages} />))
    expect(container.querySelectorAll('.conversation-turn')).toHaveLength(60)
  } finally { await act(async () => root.unmount()); container.remove() }
})
