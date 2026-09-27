// @vitest-environment jsdom
import { act, StrictMode, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import type { ChatPage } from './ChatPage'
import type { DesktopSidebar } from './DesktopSidebar'
import type { ScheduledTasksPage } from './ScheduledTasksPage'
import type { CapabilityCatalogPage } from './ExtensionCatalogPages'
import { creationPrompt } from './creationPrompts'
import * as harness from './harness'
import type { ConnectorCatalogEntry, KnowledgeBaseEntry, LocalTaskRun } from './types'
import { assistantEntry, entryText, userEntry } from './conversation/testing'
import type { ConversationEntry, AssistantTurn } from './conversation/types'
import { mergeExpertKits, type ExpertKitView } from './expertKits'
import { runHarnessWithRecovery } from './taskRecovery'
import { reportTaskAudit } from './taskAudit'
import { persistTaskHistory, loadTaskById, loadTaskHistory } from './taskHistory'
import { readTaskDraft, saveTaskDraft } from './taskDrafts'
import * as taskDrafts from './taskDrafts'
import { useHarnessNotifications } from './useHarnessNotifications'
import { rememberInstruction, emptyMemoryProfile, learnCompletedTask } from './memory'
import { loadBootstrap, loadKnowledgeBases } from './api'

const fixtures = vi.hoisted(() => ({
  drop: undefined as Parameters<typeof import('./useDesktopDrop').useDesktopDrop>[0] | undefined,
  models: ['original-model', 'other-model'],
  user: { userId: 'queue-test', teamId: 'team', name: '测试员工' },
  authState: 'authenticated' as 'authenticated' | 'required',
  catalog: { connectors: [] as ConnectorCatalogEntry[], expertKitCatalog: [], expertKits: [] as ExpertKitView[], knowledgeBases: [] as KnowledgeBaseEntry[], skills: [], skillViews: [], loading: false },
  chat: undefined as ComponentProps<typeof ChatPage> | undefined,
  sidebar: undefined as ComponentProps<typeof DesktopSidebar> | undefined,
  schedules: undefined as ComponentProps<typeof ScheduledTasksPage> | undefined,
  creationCatalog: undefined as ComponentProps<typeof CapabilityCatalogPage> | undefined,
}))
vi.mock('./useEnterpriseSession', () => ({ useEnterpriseSession: () => ({ state: fixtures.authState, user: fixtures.authState === 'authenticated' ? fixtures.user : null, sessionToken: fixtures.authState === 'authenticated' ? 'test' : '' }) }))
vi.mock('./useEnterpriseCatalog', () => ({ useEnterpriseCatalog: () => fixtures.catalog }))
vi.mock('./useHarnessHealth', () => ({ useHarnessHealth: () => ({ health: 'ready', detail: '', reportInfrastructureFailure: vi.fn() }) }))
vi.mock('./useDeviceHeartbeat', () => ({ useDeviceHeartbeat: () => vi.fn() }))
vi.mock('./useLocalImSync', () => ({ useLocalImSync: vi.fn() }))
vi.mock('./useHarnessNotifications', () => ({ useHarnessNotifications: vi.fn() }))
vi.mock('./useDesktopDrop', () => ({ useDesktopDrop: (props: Parameters<typeof import('./useDesktopDrop').useDesktopDrop>[0]) => { fixtures.drop = props; return false } }))
vi.mock('./ChatPage', () => ({ ChatPage: (props: ComponentProps<typeof ChatPage>) => { fixtures.chat = props; return null } }))
vi.mock('./DesktopSidebar', () => ({ DesktopSidebar: (props: ComponentProps<typeof DesktopSidebar>) => { fixtures.sidebar = props; return null } }))
vi.mock('./ScheduledTasksPage', () => ({ ScheduledTasksPage: (props: ComponentProps<typeof ScheduledTasksPage>) => { fixtures.schedules = props; return null } }))
vi.mock('./ExtensionCatalogPages', () => ({ CapabilityCatalogPage: (props: ComponentProps<typeof CapabilityCatalogPage>) => { fixtures.creationCatalog = props; return null } }))
vi.mock('./api', async (original) => ({ ...await original<object>(), loadBootstrap: vi.fn(async () => ({ employeeId: fixtures.user.userId, models: [...fixtures.models], capabilities: [], endpoints: { litellm: '/model', knowledge: '/knowledge', schedules: '/schedules' } })), loadKnowledgeBases: vi.fn() }))
vi.mock('./taskHistory', async (original) => ({ ...await original<object>(), loadTaskHistory: vi.fn(async () => ({ tasks: [], invalidCount: 0 })), loadTaskById: vi.fn(), persistTaskHistory: vi.fn(async () => {}) }))
vi.mock('./taskRecovery', () => ({ runHarnessWithRecovery: vi.fn() }))
vi.mock('./taskAudit', () => ({ reportTaskAudit: vi.fn(async () => {}) }))
vi.mock('./memory', async (original) => ({ ...await original<object>(), rememberInstruction: vi.fn(), learnCompletedTask: vi.fn(async () => undefined) }))
vi.mock('./harness', async (original) => ({ ...await original<object>(), clearLocalDirectories: async () => {}, restoreLocalDirectories: async () => [], shutdownHarness: vi.fn(async () => {}), cancelHarness: vi.fn(async () => true), steerHarness: vi.fn(async () => false), interruptHarness: vi.fn(async () => false), forkHarness: vi.fn(async () => 'session-forked') }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const entriesText = (entries: ConversationEntry[]) => entries.map((entry) => entry.role === 'user' ? entry.text : entry.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join(''))
const lastText = (entries: ConversationEntry[]) => entriesText(entries).at(-1)

const olderTask = (): LocalTaskRun => ({ id: 'older-task', source: 'DESKTOP', name: '更早的定时任务', status: 'COMPLETED', createdAt: '2026-09-01', updatedAt: '2026-09-01', projection: harness.createXiaoyinTaskProjection(), entries: [userEntry('u1', '保留原始需求'), assistantEntry('turn:1', '历史成果已生成')] })
const strippedTask = (): LocalTaskRun => ({ ...olderTask(), id: 'stripped-task', sessionId: 'session-stripped', entries: [], messagePreview: '历史摘要' })
it('checks selected knowledge against the live catalog before starting a task', async () => {
  const base: KnowledgeBaseEntry = { id: 'kb-1', referenceKey: 'weekly', reference: 'team:weekly', scope: 'TEAM', name: '周报资料', description: '', createdAt: '', updatedAt: '' }
  fixtures.catalog.knowledgeBases = [base]
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '已查询', sessionId: 'knowledge-session' })
  await fixture(async () => {
    await act(async () => fixtures.chat!.onAddKnowledge(base.reference))
    await submit('查询周报资料')
    expect(loadKnowledgeBases).toHaveBeenCalledOnce()
    expect(runHarnessWithRecovery).not.toHaveBeenCalled()
    expect(fixtures.chat!.localFileError).toContain('team:weekly')

    vi.mocked(loadKnowledgeBases).mockResolvedValueOnce([base])
    await submit('查询周报资料')
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
  })
})
it('starts a file generation task in the default workspace without requiring a directory picker', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '成果已生成', sessionId: 'workspace-task' })
  await fixture(async () => {
    await submit('在默认工作目录创建测试文件')
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(fixtures.chat!.localFileError).toBe('')
    expect(lastText(fixtures.chat!.entries)).toBe('成果已生成')
  })
})
it('appends explicit memory to the original task without losing prior messages or task identity', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '原来的成果', sessionId: 'original' })
  vi.mocked(rememberInstruction).mockResolvedValue({ ...emptyMemoryProfile, syncPending: true })
  await fixture(async () => {
    await submit('解释排序算法')
    const id = fixtures.sidebar!.activeTaskId
    await submit('记住：以后用中文')
    await act(async () => document.querySelector<HTMLButtonElement>('.desktop-dialog-actions .primary')!.click())
    expect(fixtures.sidebar!.activeTaskId).toBe(id)
    expect(entriesText(fixtures.chat!.entries).slice(0, 3)).toEqual(['解释排序算法', '原来的成果', '记住：以后用中文'])
    expect(lastText(fixtures.chat!.entries)).toContain('本机生效')
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(vi.mocked(persistTaskHistory).mock.calls.at(-1)![1].id).toBe(id)
  })
})
it('does not learn preferences from a stopped turn', async () => {
  const run = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValue(run.promise)
  await fixture(async () => {
    await submit('以后请用中文')
    await act(async () => fixtures.chat!.onCancel())
    await act(async () => run.resolve({ finalResponse: '完成', sessionId: 'stopped' }))
    expect(learnCompletedTask).not.toHaveBeenCalled()
  })
})
it('does not start a task until its initial record is durable and keeps the input for retry', async () => {
  vi.mocked(persistTaskHistory).mockRejectedValueOnce(new Error('模拟磁盘故障'))
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '内存中的最新结果', sessionId: 'save-test' })
  await fixture(async () => {
    await submit('保存测试')
    expect(runHarnessWithRecovery).not.toHaveBeenCalled()
    expect(fixtures.chat!.prompt).toBe('保存测试')
    expect(fixtures.chat!.localFileError).toContain('任务尚未启动，本地记录保存失败：模拟磁盘故障')
    await submit('保存测试')
    expect(lastText(vi.mocked(persistTaskHistory).mock.calls.at(-1)![1].entries)).toBe('内存中的最新结果')
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
  })
})
it('waits for the initial task write before starting the Harness turn', async () => {
  let finishWrite!: () => void
  vi.mocked(persistTaskHistory).mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve }))
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'durable-session' })
  await fixture(async () => {
    await act(async () => fixtures.chat!.onPrompt('先保存再运行'))
    await act(async () => fixtures.chat!.onSubmit({ preventDefault() {} } as React.FormEvent))
    expect(persistTaskHistory).toHaveBeenCalledWith(fixtures.user.userId, expect.objectContaining({ status: 'RUNNING' }))
    expect(entriesText(fixtures.chat!.entries)).toEqual(['先保存再运行', ''])
    expect(fixtures.chat!.currentTaskRunning).toBe(true)
    expect(fixtures.chat!.prompt).toBe('')
    expect(runHarnessWithRecovery).not.toHaveBeenCalled()
    await act(async () => finishWrite())
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
  })
})
it('stops a visible turn before its initial write finishes without starting Harness', async () => {
  let finishWrite!: () => void
  vi.mocked(persistTaskHistory).mockImplementationOnce(() => new Promise<void>((resolve) => { finishWrite = resolve }))
  await fixture(async () => {
    await act(async () => fixtures.chat!.onPrompt('启动前停止'))
    await act(async () => fixtures.chat!.onSubmit({ preventDefault() {} } as React.FormEvent))
    await act(async () => fixtures.chat!.onCancel())
    expect(fixtures.chat!.currentTaskRunning).toBe(false)
    expect(fixtures.chat!.taskProjection.status).toBe('canceled')
    await act(async () => finishWrite())
    expect(runHarnessWithRecovery).not.toHaveBeenCalled()
    expect(vi.mocked(persistTaskHistory).mock.calls.at(-1)![1].status).toBe('CANCELED')
  })
})
it('lets a later new task start while an earlier new-task write is still pending', async () => {
  let finishFirstWrite!: () => void
  vi.mocked(persistTaskHistory)
    .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstWrite = resolve }))
    .mockResolvedValue(undefined)
  vi.mocked(runHarnessWithRecovery).mockImplementation(async (input) => ({
    finalResponse: `已完成：${input.prompt}`,
    sessionId: input.sessionId!,
  }))
  await fixture(async () => {
    await act(async () => fixtures.chat!.onPrompt('第一个任务'))
    await act(async () => fixtures.chat!.onSubmit({ preventDefault() {} } as React.FormEvent))
    expect(persistTaskHistory).toHaveBeenCalledTimes(1)

    await act(async () => { await fixtures.sidebar!.onNewTask() })
    await submit('第二个任务')
    expect(persistTaskHistory).toHaveBeenCalledTimes(3)
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].prompt).toContain('第二个任务')

    await act(async () => finishFirstWrite())
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(2)
  })
})
it('preserves unsaved input when switching tasks and allows switching after retry succeeds', async () => {
  await fixture(async () => {
    const write = localStorage.setItem.bind(localStorage)
    const failure = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('xiaoyin.task-drafts.')) throw new Error('storage full')
      write(key, value)
    })
    await act(async () => fixtures.chat!.onPrompt('不能丢失的需求'))
    await act(async () => { await fixtures.sidebar!.onNewTask() })
    expect(fixtures.chat!.prompt).toBe('不能丢失的需求')
    expect(document.querySelector('.task-save-warning')?.textContent).toContain('当前草稿尚未保存')
    failure.mockRestore()
    await act(async () => document.querySelector<HTMLButtonElement>('.task-save-warning button')!.click())
    expect(document.querySelector('.task-save-warning')).toBeNull()
    expect(readTaskDraft('queue-test', '')?.prompt).toBe('不能丢失的需求')
    await act(async () => fixtures.sidebar!.onPage('schedules'))
    await act(async () => { await fixtures.schedules!.onCreateWithXiaoyin!() })
    expect(fixtures.chat!.prompt).toBe(creationPrompt('schedule'))
  })
})
it('restores and runs the execution mode saved with the draft', async () => {
  await saveTaskDraft('queue-test', '', { prompt: '先研究方案', attachments: [], directories: [], knowledgeRefs: [], connectorIds: [], model: 'original-model', executionMode: 'plan', updatedAt: 1 })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '方案已整理', sessionId: 'default-agent' })
  await fixture(async () => {
    expect(fixtures.chat!.prompt).toBe('先研究方案')
    await submit('先研究方案')
    expect(fixtures.chat!.executionMode).toBe('plan')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].executionMode).toBe('plan')
    expect(vi.mocked(persistTaskHistory).mock.calls.at(-1)![1].executionMode).toBe('plan')
  })
})
it('coalesces rapid draft edits and flushes the final value before changing tasks', async () => {
  await fixture(async () => {
    const write = vi.spyOn(localStorage, 'setItem')
    await act(async () => fixtures.chat!.onPrompt('第一版'))
    await act(async () => fixtures.chat!.onPrompt('第二版'))
    await act(async () => fixtures.chat!.onPrompt('最终版'))
    expect(readTaskDraft('queue-test', '')).toBeUndefined()
    const pendingClose = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(pendingClose)
    expect(pendingClose.defaultPrevented).toBe(true)
    await act(async () => { await fixtures.sidebar!.onNewTask() })
    expect(readTaskDraft('queue-test', '')?.prompt).toBe('最终版')
    expect(write.mock.calls.filter(([key]) => key === 'xiaoyin.task-drafts.queue-test')).toHaveLength(1)
  })
})
it('opens an unloaded scheduled task directly from durable history', async () => {
  vi.mocked(loadTaskById).mockResolvedValue(olderTask())
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onPage('schedules'))
    await act(async () => fixtures.schedules!.onOpenLocalTask!('older-task'))
    expect(loadTaskById).toHaveBeenCalledWith('queue-test', 'older-task')
    expect(fixtures.sidebar!.activeTaskId).toBe('older-task')
    expect(fixtures.chat!.entries[0].role === 'user' ? fixtures.chat!.entries[0].text : entryText(fixtures.chat!.entries[0])).toBe('保留原始需求')
    expect(fixtures.sidebar!.tasks.some((task) => task.id === 'older-task')).toBe(true)
  })
})

it('keeps the current task open when a stripped history item cannot be hydrated', async () => {
  vi.mocked(loadTaskHistory).mockResolvedValue({ tasks: [olderTask(), strippedTask()], invalidCount: 0 })
  vi.mocked(loadTaskById).mockRejectedValue(new Error('Harness 会话内容暂时无法读取'))
  await fixture(async () => {
    await vi.waitFor(() => expect(fixtures.sidebar!.tasks).toHaveLength(2))
    await act(async () => { await fixtures.sidebar!.onOpenTask(olderTask()) })
    expect(fixtures.sidebar!.activeTaskId).toBe('older-task')
    expect(lastText(fixtures.chat!.entries)).toBe('历史成果已生成')

    await act(async () => { await fixtures.sidebar!.onOpenTask(strippedTask()) })
    expect(fixtures.sidebar!.activeTaskId).toBe('older-task')
    expect(lastText(fixtures.chat!.entries)).toBe('历史成果已生成')
    expect(document.querySelector('.desktop-toast.error')?.textContent).toContain('当前会话未切换')
  })
})

it('keeps local schedules and settings available when enterprise bootstrap is offline', async () => {
  vi.mocked(loadBootstrap).mockRejectedValueOnce(new Error('offline'))
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onPage('schedules'))
    expect(fixtures.schedules).toBeDefined()
    expect(fixtures.schedules!.models).toEqual([])
    expect(fixtures.schedules!.onCreateWithXiaoyin).toBeUndefined()

    await act(async () => fixtures.sidebar!.onPage('settings'))
    expect(document.querySelector('.desktop-settings')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('.settings-navigation button:disabled')?.textContent).toContain('企业服务连接后可用')
  })
})

it('keeps the Shell switch unchanged and reports a failed runtime preference write', async () => {
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onPage('settings'))
    await act(async () => document.querySelector<HTMLButtonElement>('.settings-navigation button:last-child')!.click())
    const shell = document.querySelector<HTMLInputElement>('input[aria-label="允许本地命令执行"]')!
    expect(shell.checked).toBe(true)
    const originalWrite = localStorage.setItem.bind(localStorage)
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'xiaoyin.runtime.queue-test.allow-shell') throw new Error('storage unavailable')
      originalWrite(key, value)
    })
    await act(async () => shell.click())
    expect(shell.checked).toBe(true)
    expect(document.querySelector('.desktop-toast.error')?.textContent).toContain('运行时设置未能保存')
    write.mockRestore()
  })
})

it('disables optional local execution capabilities when runtime preferences cannot be read', async () => {
  const originalRead = localStorage.getItem.bind(localStorage)
  vi.spyOn(localStorage, 'getItem').mockImplementation((key) => {
    if (key.startsWith('xiaoyin.runtime.')) throw new Error('storage unavailable')
    return originalRead(key)
  })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'restricted-task' })
  await fixture(async () => {
    await submit('整理资料')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0]).toMatchObject({
      allowShell: false, allowLsp: false, allowExternalAgents: false, allowHooks: false,
    })
  })
})

it('remains usable when WebView storage fails for every key', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => { throw new Error('storage unavailable') },
    setItem: () => { throw new Error('storage unavailable') },
    removeItem: () => { throw new Error('storage unavailable') },
  })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'storage-failure-task' })
  await fixture(async () => {
    expect(fixtures.chat!.activeModel).toBe('original-model')
    await act(async () => fixtures.chat!.onSelectModel('other-model'))
    expect(fixtures.chat!.activeModel).toBe('other-model')
    expect(document.querySelector('.desktop-toast.error')?.textContent).toContain('模型选择未能保存')
    await submit('整理资料')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0]).toMatchObject({
      model: 'other-model', allowShell: false, allowLsp: false,
      allowExternalAgents: false, allowHooks: false,
    })
  })
})

it('does not switch back to an old scheduled task after the user starts another task', async () => {
  let resolve!: (task: LocalTaskRun) => void
  vi.mocked(loadTaskById).mockReturnValue(new Promise((done) => { resolve = done }))
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onPage('schedules'))
    await act(async () => fixtures.schedules!.onOpenLocalTask!('older-task'))
    await act(async () => { await fixtures.sidebar!.onNewTask() })
    await act(async () => fixtures.chat!.onPrompt('当前新草稿'))
    await act(async () => resolve(olderTask()))
    expect(fixtures.sidebar!.activeTaskId).not.toBe('older-task')
    expect(fixtures.chat!.prompt).toBe('当前新草稿')
  })
})

const pastedAuthorization = { directories: [], attachments: [{ id: 'file-test', name: '中文报告.pdf', rootId: 'root', rootName: '资料', rootPath: '/tmp/fixtures', path: '中文报告.pdf', kind: 'file' as const }] }
it('shares duplicate handling between native file paste, drag and file selection', async () => {
  vi.spyOn(harness, 'clipboardFilePaths').mockResolvedValue(['/tmp/fixtures/中文报告.pdf'])
  const authorize = vi.spyOn(harness, 'authorizeDroppedPaths').mockResolvedValue(pastedAuthorization)
  vi.spyOn(harness, 'authorizeLocalFiles').mockResolvedValue(pastedAuthorization)
  await fixture(async () => {
    await act(async () => { await fixtures.chat!.onPasteFiles!([]) })
    await act(async () => { await fixtures.drop!.onPaths(['/tmp/fixtures/中文报告.pdf']) })
    await act(async () => { await fixtures.chat!.onAddLocalFiles() })
    expect(fixtures.chat!.pendingAttachments).toHaveLength(1)
    expect(authorize).toHaveBeenCalledTimes(2)
  })
})

it('discards a late dropped file after switching to another task context', async () => {
  let finish!: (value: typeof pastedAuthorization) => void
  vi.spyOn(harness, 'authorizeDroppedPaths').mockReturnValue(new Promise((resolve) => { finish = resolve }))
  await fixture(async () => {
    let pending!: Promise<unknown>
    await act(async () => { pending = fixtures.drop!.onPaths(['/tmp/fixtures/中文报告.pdf']) })
    await act(async () => { await fixtures.sidebar!.onNewTask() })
    await act(async () => { finish(pastedAuthorization); await pending })
    expect(fixtures.chat!.pendingAttachments).toHaveLength(0)
    expect(fixtures.chat!.localFileError).toBe('')
  })
})

it('keeps successfully imported clipboard files and reports individual failures', async () => {
  vi.spyOn(harness, 'clipboardFilePaths').mockResolvedValue([])
  vi.spyOn(harness, 'importPastedFile').mockResolvedValueOnce(pastedAuthorization).mockRejectedValueOnce(new Error('读取失败'))
  await fixture(async () => {
    await act(async () => { await fixtures.chat!.onPasteFiles!([new File(['a'], '中文报告.pdf'), new File(['b'], 'bad.txt')]) })
    expect(fixtures.chat!.pendingAttachments).toHaveLength(1)
    expect(fixtures.chat!.localFileError).toContain('bad.txt：读取失败')
    expect(fixtures.chat!.pastingAttachments).toBe(false)
  })
})
it('seeds schedule creation only into an empty draft and preserves edits on repeated entry', async () => {
  await fixture(async () => {
    const enter = async () => {
      await act(async () => fixtures.sidebar!.onPage('schedules'))
      await act(async () => { await fixtures.schedules!.onCreateWithXiaoyin!() })
    }
    await enter()
    const template = '我要创建一个定时任务，每【时间间隔】执行【具体任务】'
    expect(fixtures.chat!.prompt).toBe(template)
    await enter()
    expect(fixtures.chat!.prompt).toBe(template)
    const edited = '每周一上午 9 点整理销售周报，附上表格'
    await act(async () => fixtures.chat!.onPrompt(edited))
    await enter()
    expect(fixtures.chat!.prompt).toBe(edited)
    expect(runHarnessWithRecovery).not.toHaveBeenCalled()
  })
})
it('opens a separate schedule draft without changing an unrelated unsent draft', async () => {
  await fixture(async () => {
    await act(async () => fixtures.chat!.onPrompt('正在编写的其他需求'))
    await act(async () => fixtures.sidebar!.onPage('schedules'))
    await act(async () => { await fixtures.schedules!.onCreateWithXiaoyin!() })
    expect(fixtures.chat!.prompt).toBe(creationPrompt('schedule'))
    await act(async () => { await fixtures.sidebar!.onNewTask() })
    expect(fixtures.chat!.prompt).toBe('正在编写的其他需求')
  })
})
it('isolates all three creation drafts, models and creation types across switches and remounts', async () => {
  const enter = async (kind: 'skill' | 'expert-kit' | 'schedule') => {
    await act(async () => fixtures.sidebar!.onPage(kind === 'schedule' ? 'schedules' : kind === 'skill' ? 'skills' : 'packs'))
    await act(async () => {
      if (kind === 'schedule') await fixtures.schedules!.onCreateWithXiaoyin!()
      else await fixtures.creationCatalog!.onCreate!()
    })
  }
  const kinds = ['skill', 'expert-kit', 'schedule'] as const
  await fixture(async () => {
    await act(async () => fixtures.chat!.onPrompt('普通新任务草稿'))
    for (const kind of kinds) {
      await enter(kind)
      expect(fixtures.chat!.prompt).toBe(creationPrompt(kind))
      expect(fixtures.chat!.creationKind).toBe(kind === 'schedule' ? undefined : kind)
      await act(async () => { fixtures.chat!.onPrompt(`${kind} 的自定义需求`); fixtures.chat!.onSelectModel(kind === 'skill' ? 'other-model' : 'original-model') })
    }
    for (const kind of kinds) {
      await enter(kind)
      expect(fixtures.chat!.prompt).toBe(`${kind} 的自定义需求`)
      expect(fixtures.chat!.creationKind).toBe(kind === 'schedule' ? undefined : kind)
      expect(fixtures.chat!.activeModel).toBe(kind === 'skill' ? 'other-model' : 'original-model')
    }
    await act(async () => { await fixtures.sidebar!.onNewTask() })
    expect(fixtures.chat!.prompt).toBe('普通新任务草稿')
    expect(fixtures.chat!.creationKind).toBeUndefined()
  })
  await fixture(async () => {
    for (const kind of kinds) {
      await enter(kind)
      expect(fixtures.chat!.prompt).toBe(`${kind} 的自定义需求`)
      expect(fixtures.chat!.creationKind).toBe(kind === 'schedule' ? undefined : kind)
    }
  })
  expect(runHarnessWithRecovery).not.toHaveBeenCalled()
})
it('clears only the submitted creation draft and preserves the ordinary new-task draft', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'creation-session' })
  await fixture(async () => {
    await act(async () => fixtures.chat!.onPrompt('普通草稿'))
    await act(async () => fixtures.sidebar!.onPage('schedules'))
    await act(async () => { await fixtures.schedules!.onCreateWithXiaoyin!() })
    await submit('只解释定时任务是什么，不要调用工具')
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(readTaskDraft(fixtures.user.userId, 'creation:schedule')).toBeUndefined()
    expect(readTaskDraft(fixtures.user.userId, '')?.prompt).toBe('普通草稿')
  })
})
it('runs a local schedule through the same desktop execution flow without replacing the open draft', async () => {
  const available = vi.spyOn(harness, 'connectorDiagnosticsAvailable').mockReturnValue(true)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: unknown, handler?: (lock: object) => unknown) => (handler ?? options as (lock: object) => unknown)({}) } })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: 'SCHEDULE_OK', sessionId: 'schedule-session' })
  try {
    await fixture(async () => {
      await act(async () => fixtures.chat!.onPrompt('未发送的日常草稿'))
      await act(async () => fixtures.sidebar!.onPage('schedules'))
      await act(async () => { await fixtures.schedules!.local!.save({ name: '定时验收', prompt: '只回复 SCHEDULE_OK', cronExpression: '0 9 * * *', timeZone: 'Asia/Shanghai', directories: [] }) })
      const id = fixtures.schedules!.local!.items[0].id
      await act(async () => { await fixtures.schedules!.local!.action(id, 'run') })
      expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
      const saved = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1]
      expect(saved.name).toBe('定时验收')
      expect(lastText(saved.entries)).toBe('SCHEDULE_OK')
      expect(fixtures.schedules!.local!.items[0].runs[0]).toMatchObject({ status: 'COMPLETED', taskId: saved.id })
      await act(async () => fixtures.sidebar!.onPage('chat'))
      expect(fixtures.chat!.prompt).toBe('未发送的日常草稿')
    })
  } finally { available.mockRestore() }
})
it.each(['other-model', 'removed-model'])('uses the scheduled model or pauses an unavailable model: %s', async (model) => {
  const available = vi.spyOn(harness, 'connectorDiagnosticsAvailable').mockReturnValue(true)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: unknown, handler?: (lock: object) => unknown) => (handler ?? options as (lock: object) => unknown)({}) } })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: 'MODEL_OK', sessionId: 'model-session' })
  try {
    await fixture(async () => {
      await act(async () => fixtures.sidebar!.onPage('schedules'))
      await act(async () => { await fixtures.schedules!.local.save({ name: '模型验收', prompt: '只回复 MODEL_OK', model, cronExpression: '0 9 * * *', timeZone: 'Asia/Shanghai', directories: [] }) })
      const id = fixtures.schedules!.local.items[0].id
      await act(async () => { await fixtures.schedules!.local.action(id, 'run') })
      const plan = fixtures.schedules!.local.items[0]
      if (model === 'other-model') {
        expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
        expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].model).toBe(model)
        expect(plan.runs[0].status).toBe('COMPLETED')
      } else {
        expect(runHarnessWithRecovery).not.toHaveBeenCalled()
        expect(plan).toMatchObject({ active: false, runs: [{ status: 'FAILED', detail: expect.stringContaining('模型已不可用') }] })
        expect(plan.runs[0].taskId).toBeUndefined()
      }
    })
  } finally { available.mockRestore() }
})
it('restores scheduled attachment roots and forwards attachments to the ordinary task runner', async () => {
  const available = vi.spyOn(harness, 'connectorDiagnosticsAvailable').mockReturnValue(true)
  const restore = vi.spyOn(harness, 'restoreLocalDirectories').mockResolvedValue([{ id: 'attachment-root', name: '资料', path: '/fixture' }])
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: unknown, handler?: (lock: object) => unknown) => (handler ?? options as (lock: object) => unknown)({}) } })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '附件读取完成', sessionId: 'attachment-session' })
  const attachment = { id: 'attachment-root:input.csv', rootId: 'attachment-root', rootName: '资料', rootPath: '/fixture', path: 'input.csv', name: 'input.csv', kind: 'file' as const }
  try {
    await fixture(async () => {
      await act(async () => fixtures.sidebar!.onPage('schedules'))
      await act(async () => { await fixtures.schedules!.local.save({ name: '附件计划', prompt: '读取附件并总结', cronExpression: '0 9 * * *', timeZone: 'Asia/Shanghai', directories: [], attachments: [attachment] }) })
      const id = fixtures.schedules!.local.items[0].id
      await act(async () => { await fixtures.schedules!.local.action(id, 'run') })
      expect(restore).toHaveBeenCalledWith(['/fixture'])
      expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0]).toMatchObject({ attachments: [attachment], localFileRootIds: ['attachment-root'] })
      expect(fixtures.schedules!.local.items[0].runs[0].status).toBe('COMPLETED')
    })
  } finally { available.mockRestore(); restore.mockRestore() }
})
it('keeps canceled local schedules and their desktop tasks in the same stopped state', async () => {
  const available = vi.spyOn(harness, 'connectorDiagnosticsAvailable').mockReturnValue(true)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: unknown, handler?: (lock: object) => unknown) => (handler ?? options as (lock: object) => unknown)({}) } })
  const execution = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValue(execution.promise)
  try {
    await fixture(async () => {
      await act(async () => fixtures.sidebar!.onPage('schedules'))
      await act(async () => { await fixtures.schedules!.local!.save({ name: '停止验收', prompt: '运行验收', cronExpression: '0 9 * * *', timeZone: 'Asia/Shanghai', directories: [] }) })
      const id = fixtures.schedules!.local!.items[0].id
      let pending!: Promise<void>
      await act(async () => { pending = fixtures.schedules!.local!.action(id, 'run') })
      const taskId = fixtures.schedules!.local!.items[0].runs[0].taskId!
      await act(async () => fixtures.schedules!.onOpenLocalTask!(taskId))
      await act(async () => fixtures.chat!.onCancel())
      await act(async () => { execution.reject(new Error('stopped')); await pending })
      expect(fixtures.chat!.taskProjection.status).toBe('canceled')
      await act(async () => fixtures.sidebar!.onPage('schedules'))
      expect(fixtures.schedules!.local!.items[0]).toMatchObject({ active: false, runs: [{ taskId, status: 'CANCELED' }] })
      expect(vi.mocked(persistTaskHistory).mock.calls.at(-1)![1].status).toBe('CANCELED')
    })
  } finally { available.mockRestore() }
})

beforeEach(() => {
  vi.mocked(runHarnessWithRecovery).mockReset()
  vi.mocked(persistTaskHistory).mockReset().mockResolvedValue(undefined)
  vi.mocked(harness.shutdownHarness).mockReset().mockResolvedValue(undefined)
  vi.mocked(loadTaskById).mockReset()
  vi.mocked(loadKnowledgeBases).mockReset().mockResolvedValue([])
  vi.mocked(loadTaskHistory).mockResolvedValue({ tasks: [], invalidCount: 0 })
  fixtures.models = ['original-model', 'other-model']
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected network access in queue regression'))))
  Element.prototype.scrollTo = vi.fn()
})
afterEach(() => { fixtures.authState = 'authenticated'; fixtures.catalog.connectors = []; fixtures.catalog.expertKits = []; fixtures.catalog.knowledgeBases = []; vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

async function fixture(check: () => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try { await act(async () => root.render(<App />)); await check() }
  finally { await act(async () => root.unmount()); container.remove() }
}

it('finishes draft restoration when StrictMode restarts initialization', async () => {
  await saveTaskDraft('queue-test', '', { prompt: '保留的草稿', attachments: [], directories: [], knowledgeRefs: [], connectorIds: [], model: 'original-model', updatedAt: 1 })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<StrictMode><App /></StrictMode>))
    expect(container.textContent).not.toContain('正在恢复本机草稿')
    expect(fixtures.chat!.prompt).toBe('保留的草稿')
    expect(readTaskDraft('queue-test', '')?.prompt).toBe('保留的草稿')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

it('shows draft loading when New Task is clicked from the catalog and allows retry after loading', async () => {
  const load = taskDrafts.loadTaskDraftState
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => { finish = resolve })
  vi.spyOn(taskDrafts, 'loadTaskDraftState').mockImplementation(async (owner) => { await waiting; await load(owner) })
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onPage('packs'))
    expect(fixtures.sidebar!.page).toBe('packs')
    await act(async () => fixtures.sidebar!.onNewTask())
    expect(fixtures.sidebar!.page).toBe('chat')
    expect(document.body.textContent).toContain('正在恢复本机草稿')
    await act(async () => finish())
    expect(document.body.textContent).not.toContain('正在恢复本机草稿')
    await act(async () => fixtures.sidebar!.onPage('packs'))
    await act(async () => fixtures.sidebar!.onNewTask())
    expect(fixtures.sidebar!.page).toBe('chat')
    expect(fixtures.chat!.prompt).toBe('')
  })
})

it('recovers the last input after ERP automatically invalidates the workspace', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<App />))
    await act(async () => fixtures.chat!.onPrompt('刚输入还未写入 SQLite'))
    expect(readTaskDraft('queue-test', '')).toBeUndefined()
    expect(localStorage.getItem('xiaoyin.pending-task-draft.queue-test')).toContain('刚输入还未写入 SQLite')
    fixtures.authState = 'required'
    await act(async () => root.render(<App />))
    expect(document.querySelector('.dingtalk-auth-screen')).not.toBeNull()
    fixtures.authState = 'authenticated'
    await act(async () => root.render(<App />))
    expect(fixtures.chat!.prompt).toBe('刚输入还未写入 SQLite')
    expect(readTaskDraft('queue-test', '')?.prompt).toBe('刚输入还未写入 SQLite')
  } finally { fixtures.authState = 'authenticated'; await act(async () => root.unmount()); container.remove() }
})

it('does not carry chat messages or a draft into another employee workspace', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '员工一的答复', sessionId: 'employee-one' })
  const original = fixtures.user
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<App />))
    await submit('员工一的任务')
    await act(async () => fixtures.chat!.onPrompt('员工一的未提交草稿'))
    expect(entriesText(fixtures.chat!.entries).some((text) => text.includes('员工一'))).toBe(true)
    expect(fixtures.chat!.prompt).toBe('员工一的未提交草稿')
    fixtures.user = { ...original, userId: 'another-employee' }
    await act(async () => root.render(<App />))
    expect(fixtures.chat!.entries).toEqual([])
    expect(fixtures.chat!.prompt).toBe('')
  } finally {
    fixtures.user = original
    await act(async () => root.unmount())
    container.remove()
  }
})

it('waits for old native tasks to stop and retries a failed account transition', async () => {
  const original = fixtures.user
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<App />))
    let failStop!: (error: Error) => void
    vi.mocked(harness.shutdownHarness).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failStop = reject }))
    fixtures.user = { ...original, userId: 'another-employee' }
    fixtures.chat = undefined
    await act(async () => root.render(<App />))
    expect(fixtures.chat).toBeUndefined()
    expect(document.querySelector('.dingtalk-auth-screen')).not.toBeNull()
    await act(async () => failStop(new Error('native shutdown failed')))
    const retry = document.querySelector<HTMLButtonElement>('.dingtalk-auth-screen button')
    expect(retry).not.toBeNull()
    expect(document.querySelector('.dingtalk-auth-error')?.textContent).not.toContain('native shutdown failed')
    await act(async () => retry!.click())
    expect(fixtures.chat).toBeDefined()
    expect(fixtures.chat!.entries).toEqual([])
  } finally {
    fixtures.user = original
    await act(async () => root.unmount())
    container.remove()
  }
})

it('does not reopen the old workspace while a rapid account switch is still cleaning up', async () => {
  const original = fixtures.user
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<App />))
    let finishFirst!: () => void
    let finishSecond!: () => void
    vi.mocked(harness.shutdownHarness)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishSecond = resolve }))
    fixtures.chat = undefined
    fixtures.user = { ...original, userId: 'another-employee' }
    await act(async () => root.render(<App />))
    fixtures.user = original
    await act(async () => root.render(<App />))
    expect(fixtures.chat).toBeUndefined()
    await act(async () => finishFirst())
    expect(fixtures.chat).toBeUndefined()
    expect(document.querySelector('.dingtalk-auth-screen')).not.toBeNull()
    await act(async () => finishSecond())
    expect(fixtures.chat).toBeDefined()
  } finally {
    fixtures.user = original
    await act(async () => root.unmount())
    container.remove()
  }
})
async function submit(text: string) {
  await act(async () => { fixtures.chat!.onPrompt(text) })
  await act(async () => { fixtures.chat!.onSubmit({ preventDefault() {} } as React.FormEvent) })
}
function deferredRun() {
  let resolve: (result: Awaited<ReturnType<typeof runHarnessWithRecovery>>) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<Awaited<ReturnType<typeof runHarnessWithRecovery>>>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('continues in the original session and preserves another task’s draft and model selection', async () => {
  const first = deferredRun(); const second = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  await fixture(async () => {
    await submit('解释排序算法')
    const original = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    await submit('再给一个例子')
    expect(fixtures.chat!.queue?.items).toHaveLength(1)
    await act(async () => { fixtures.sidebar!.onNewTask() })
    await act(async () => { fixtures.chat!.onPrompt('另一个任务的草稿'); fixtures.chat!.onSelectModel('other-model') })
    await act(async () => { first.resolve({ finalResponse: '排序说明', sessionId: original.sessionId! }) })
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(2)
    const continuation = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(continuation).toMatchObject({ taskId: original.taskId, sessionId: original.sessionId, model: 'original-model', prompt: '再给一个例子' })
    expect(fixtures.chat!.prompt).toBe('另一个任务的草稿')
    expect(fixtures.chat!.activeModel).toBe('other-model')
    expect(fixtures.chat!.entries).toEqual([])
    await act(async () => { second.resolve({ finalResponse: '示例', sessionId: original.sessionId! }) })
    const saved = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1] as LocalTaskRun
    expect(entriesText(saved.entries)).toEqual(['解释排序算法', '排序说明', '再给一个例子', '示例'])
    expect(fixtures.chat!.prompt).toBe('另一个任务的草稿')
  })
})

it('treats an officially completed tool-free turn as delivered and learnable', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValueOnce({ finalResponse: '2', sessionId: 'answer' })
  await fixture(async () => {
    await submit('1+1=?')
    expect(fixtures.chat!.taskProjection.status).toBe('completed')
    expect(lastText(fixtures.chat!.entries)).toBe('2')
    expect(learnCompletedTask).toHaveBeenCalledOnce()
    expect(reportTaskAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCEEDED' }))
  })
})

it('pauses the queue after execution fails and retains unsent requirements', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  await fixture(async () => {
    await submit('解释排序算法')
    await submit('再给一个例子')
    await act(async () => { first.reject(new Error('测试执行失败')) })
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(fixtures.chat!.queue).toMatchObject({ paused: true, items: [{ text: '再给一个例子' }] })
    expect(fixtures.chat!.taskProjection.status).toBe('failed')
  })
})

it('keeps the queue paused when stop races with a successful completion', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  await fixture(async () => {
    await submit('解释排序算法')
    await submit('再给一个例子')
    await act(async () => { fixtures.chat!.onCancel() })
    const original = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    await act(async () => { first.resolve({ finalResponse: '完成', sessionId: original.sessionId! }) })
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(fixtures.chat!.queue?.paused).toBe(true)
    expect(fixtures.chat!.queue?.items[0].text).toBe('再给一个例子')
    expect(fixtures.chat!.taskProjection.status).toBe('canceled')
    expect(fixtures.chat!.taskProjection.failure).toBeUndefined()
    expect(fixtures.chat!.currentTaskRunning).toBe(false)
    expect(lastText(fixtures.chat!.entries)).not.toBe('完成')
  })
})

it('preserves partial output and completed work after stop, then continues with conversation context', async () => {
  const first = deferredRun(); const next = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
  await fixture(async () => {
    await submit('检查排序方法')
    expect(fixtures.chat!.taskProjection.activity).toBe('正在处理')
    const request = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    const hook = vi.mocked(useHarnessNotifications).mock.calls.at(-1)![0]
    const streaming = hook.streamingTasksRef.current.get(request.taskId)!
    const turn1 = streaming.entries.at(-1) as AssistantTurn; turn1.segments = [{ kind: 'text', id: '1:1', text: '已经检查了第一种方法。', streaming: true }]
    streaming.projection.steps = [{ id: 'done', kind: 'tool', label: '已检查', status: 'completed', startedAt: '' }, { id: 'pending', kind: 'tool', label: '检查中', status: 'running', startedAt: '' }]
    await act(async () => fixtures.chat!.onCancel())
    expect(fixtures.chat!.taskProjection.activity).toBe('正在停止')
    await act(async () => first.reject(new Error('Host exited')))
    expect(lastText(fixtures.chat!.entries)).toBe('已经检查了第一种方法。')
    expect(fixtures.chat!.taskProjection.steps.map((step) => step.status)).toEqual(['completed', 'canceled'])
    expect(fixtures.chat!.taskProjection.failure).toBeUndefined()
    await submit('继续解释第二种')
    const continuation = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(continuation.taskId).toBe(request.taskId)
    // The stopped turn left a balanced session log: the conversation continues
    // in place instead of being flattened into a replayed prompt.
    expect(continuation.sessionId).toBe(request.sessionId)
    expect(continuation.prompt).toBe('继续解释第二种')
    await act(async () => next.resolve({ sessionId: continuation.sessionId!, finalResponse: '第二种方法。' } as Awaited<ReturnType<typeof runHarnessWithRecovery>>))
    expect(fixtures.chat!.taskProjection.status).toBe('completed')
  })
})

it('keeps partial text and real artifacts visible when execution fails after producing output', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  await fixture(async () => {
    await submit('处理报表')
    const request = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    const hook = vi.mocked(useHarnessNotifications).mock.calls.at(-1)![0]
    const streaming = hook.streamingTasksRef.current.get(request.taskId)!
    const turn2 = streaming.entries.at(-1) as AssistantTurn; turn2.segments = [{ kind: 'text', id: '1:1', text: '第一份报表已生成，第二份尚未完成。', streaming: true }]
    streaming.projection.artifacts = [{ id: 'root:one.csv', rootId: 'root', rootName: '工作目录', path: 'one.csv', name: 'one.csv', kind: 'spreadsheet', action: 'published', sourceTool: 'local_files_publish', createdAt: '' }]
    await act(async () => first.reject(new Error('本轮达到模型输出上限')))
    expect(fixtures.chat!.taskProjection.status).toBe('failed')
    expect(lastText(fixtures.chat!.entries)).toContain('第一份报表已生成')
    const failedTurn = fixtures.chat!.entries.at(-1) as AssistantTurn
    expect(failedTurn.meta.failure?.message).toContain('错误编号')
    expect(fixtures.chat!.taskProjection.artifacts).toHaveLength(1)
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
  })
})

it('restores independent new-task and conversation drafts without clearing either', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'test-session' })
  await fixture(async () => {
    await submit('解释排序算法')
    const task = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1]
    await act(async () => { fixtures.chat!.onPrompt('这个任务的追问') })
    await act(async () => { fixtures.sidebar!.onNewTask() })
    await act(async () => { fixtures.chat!.onPrompt('新任务未发送'); fixtures.chat!.onSelectModel('other-model') })
    await act(async () => { fixtures.sidebar!.onOpenTask(task) })
    expect(fixtures.chat!.prompt).toBe('这个任务的追问')
    await act(async () => { fixtures.sidebar!.onNewTask() })
    expect(fixtures.chat!.prompt).toBe('新任务未发送')
    expect(fixtures.chat!.activeModel).toBe('other-model')
    expect(readTaskDraft('queue-test', task.id)?.prompt).toBe('这个任务的追问')
  })
  await fixture(async () => {
    expect(fixtures.chat!.prompt).toBe('新任务未发送')
    expect(fixtures.chat!.activeModel).toBe('other-model')
  })
})

it.each(['', '继续检查'])('resumes the persisted session after remount with an unchanged workspace draft: %s', async (prompt) => {
  const directories = [{ id: 'work', name: '工作', path: '/work' }]
  const task: LocalTaskRun = { ...olderTask(), sessionId: 'persisted-session', model: 'original-model', localDirectories: directories,
    capabilitySnapshot: { schemaVersion: 2, createdAt: 'test', selections: [], artifacts: [], implicitArtifacts: [], localTools: [], requestedConnectorIds: [], connectors: [], requestedKnowledgeBaseRefs: [], knowledgeBaseRefs: [] } }
  vi.spyOn(harness, 'restoreLocalDirectories').mockResolvedValue(directories)
  await saveTaskDraft('queue-test', task.id, { prompt, attachments: [], directories, knowledgeRefs: [], connectorIds: [], model: 'original-model', updatedAt: 1 })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '复查完成', sessionId: 'persisted-session' })
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onOpenTask(task))
    expect(fixtures.chat!.prompt).toBe(prompt)
    await submit('复查原任务')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0]).toMatchObject({ sessionId: 'persisted-session', prompt: '复查原任务' })
  })
})

it('resumes an installed kit after native persistence reorders the capability snapshot', async () => {
  fixtures.catalog.expertKits = mergeExpertKits([], [{ installPath: '/extensions/reports', source: 'developer', packageSha256: 'a'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'reports', name: '报告专家', version: '1.0.0', summary: '生成报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [{ id: 'report', path: 'skills/report/SKILL.md' }], connectorRefs: [], requiredTools: [] } }])
  vi.mocked(runHarnessWithRecovery).mockImplementation(async (request) => ({ finalResponse: '完成', sessionId: request.sessionId! }))
  let stored!: LocalTaskRun
  await fixture(async () => {
    await submit('/kit:reports 分析销售情况')
    const task = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1]
    stored = JSON.parse(JSON.stringify(task, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value))
  })
  vi.mocked(loadTaskHistory).mockResolvedValue({ tasks: [stored], invalidCount: 0 })
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onOpenTask(stored))
    await submit('/kit:reports 只读复查')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls.at(-1)![0]).toMatchObject({
      sessionId: stored.sessionId, prompt: '只读复查',
      capabilitySnapshot: { selections: [{ mode: 'explicit', kind: 'expert-kit', extensionId: 'reports', extensionVersion: '1.0.0' }] },
    })
  })
})

it('starts a new session when a restored draft changes the workspace', async () => {
  const task: LocalTaskRun = { ...olderTask(), sessionId: 'persisted-session', model: 'original-model', localDirectories: [{ id: 'old', name: '旧目录', path: '/old' }],
    capabilitySnapshot: { schemaVersion: 2, createdAt: 'test', selections: [], artifacts: [], implicitArtifacts: [], localTools: [], requestedConnectorIds: [], connectors: [], requestedKnowledgeBaseRefs: [], knowledgeBaseRefs: [] } }
  const directories = [{ id: 'new', name: '新目录', path: '/new' }]
  vi.spyOn(harness, 'restoreLocalDirectories').mockResolvedValue(directories)
  await saveTaskDraft('queue-test', task.id, { prompt: '继续', attachments: [], directories, knowledgeRefs: [], connectorIds: [], model: 'original-model', updatedAt: 1 })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'new-session' })
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onOpenTask(task))
    await submit('检查当前目录')
    const request = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    expect(request.sessionId).not.toBe('persisted-session')
    expect(request.prompt).toContain('保留原始需求')
  })
})

it('sends only task-selected connectors and removes them from the capability snapshot when deselected', async () => {
  fixtures.catalog.connectors = ['crm', 'drive'].map((id) => ({ id, name: id, summary: '', category: 'other', kind: 'mcp', scope: 'EMPLOYEE', status: 'ready', managed: false, version: '1', transport: 'streamable-http', url: `https://${id}.example/mcp`, authMode: 'none', toolNames: [`${id}_read`] })) as ConnectorCatalogEntry[]
  localStorage.setItem('xiaoyin.enabled-connectors.queue-test', JSON.stringify(['crm', 'drive']))
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'test-session' })
  await fixture(async () => {
    await act(async () => { fixtures.chat!.onToggleTaskConnector!('crm') })
    await submit('分析客户情况')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].capabilitySnapshot.connectors.map((item) => item.id)).toEqual(['crm'])
    await act(async () => { fixtures.chat!.onToggleTaskConnector!('crm') })
    await submit('继续分析')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].capabilitySnapshot.connectors).toEqual([])
    await act(async () => { fixtures.chat!.onToggleTaskConnector!('unavailable') })
    await submit('继续')
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(2)
    expect(fixtures.chat!.localFileError).toContain('连接器尚未就绪')
  })
})

it('executes the selected kit and stops forcing it after the user removes the capability', async () => {
  fixtures.catalog.expertKits = mergeExpertKits([], [{ installPath: '/extensions/reports', source: 'developer', packageSha256: 'a'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'reports', name: '报告专家', version: '1.0.0', summary: '生成报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [{ id: 'report', path: 'skills/report/SKILL.md' }], connectorRefs: [], requiredTools: [] } }])
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'kit-session' })
  await fixture(async () => {
    await submit('/kit:reports 分析销售情况')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].capabilitySnapshot.selections).toEqual([
      { mode: 'explicit', kind: 'expert-kit', extensionId: 'reports', extensionVersion: '1.0.0' },
    ])
    expect(fixtures.chat!.prompt).toBe('/kit:reports ')
    await submit('解释排序算法')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].capabilitySnapshot.selections).toEqual([])
    // Dropping a capability restarts the host with the new set and resumes the
    // same conversation instead of rebuilding it.
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].sessionId).toBe('kit-session')
  })
})

it.each(['connector', 'tool', 'artifact'])('shows kit preparation errors and allows retry after fixing %s', async (missing) => {
  fixtures.catalog.connectors = [{ id: 'erp-mcp', name: 'ERP', summary: '', category: 'other', kind: 'mcp', scope: 'EMPLOYEE', status: 'ready', managed: false, version: '1', transport: 'streamable-http', url: 'https://erp.example/mcp', authMode: 'none', toolNames: ['order.intake_diagnose_order'] }] as ConnectorCatalogEntry[]
  if (missing !== 'connector') localStorage.setItem('xiaoyin.enabled-connectors.queue-test', '["erp-mcp"]')
  fixtures.catalog.expertKits = mergeExpertKits([], [{ installPath: '/extensions/orders', source: 'developer', packageSha256: missing === 'artifact' ? undefined : 'a'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'orders', name: '订单专家', version: '1.0.0', summary: '订单诊断', category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [], connectorRefs: ['erp-mcp'], requiredTools: [missing === 'tool' ? 'order_intake_diagnose_order' : 'order.intake_diagnose_order'] } }])
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'kit-session' })
  await fixture(async () => {
    const input = '/kit:orders 检查订单'
    await submit(input)
    expect(runHarnessWithRecovery).not.toHaveBeenCalled()
    expect(persistTaskHistory).not.toHaveBeenCalled()
    expect(fixtures.chat!.prompt).toBe(input)
    expect(fixtures.chat!.localFileError).toContain('消息未能发送')
    expect(fixtures.chat!.localFileError).toContain(missing === 'connector' ? '连接器尚未就绪' : missing === 'tool' ? 'order_intake_diagnose_order' : '缺少可信制品')
    const kit = fixtures.catalog.expertKits[0]
    kit.connectorRefs = missing === 'connector' ? [] : ['erp-mcp']
    kit.requiredTools = missing === 'connector' ? [] : ['order.intake_diagnose_order']
    kit.installed!.packageSha256 = 'a'.repeat(64)
    await submit(input)
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(1)
    expect(fixtures.chat!.localFileError).toBe('')
    expect(fixtures.chat!.prompt).toBe('/kit:orders ')
  })
})

it('persists both kits and retains them when reopening the task', async () => {
  fixtures.catalog.expertKits = mergeExpertKits([], ['design', 'product'].map((id) => ({ installPath: `/extensions/${id}`, source: 'developer', packageSha256: 'a'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id, name: id, version: '1.0.0', summary: id, category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [{ id, path: `skills/${id}/SKILL.md` }], connectorRefs: [], requiredTools: [] } })))
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'combined-session' })
  await fixture(async () => {
    await submit('/kit:design /kit:product 制定产品方案')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].capabilitySnapshot.selections).toEqual([
      { mode: 'explicit', kind: 'expert-kit', extensionId: 'design', extensionVersion: '1.0.0' },
      { mode: 'explicit', kind: 'expert-kit', extensionId: 'product', extensionVersion: '1.0.0' },
    ])
    expect(fixtures.chat!.prompt).toBe('/kit:design /kit:product ')
    const saved = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1]
    expect(saved.invocationTokens).toEqual(['/kit:design', '/kit:product'])
    expect(saved.capabilitySnapshot?.selections).toEqual([
      { mode: 'explicit', kind: 'expert-kit', extensionId: 'design', extensionVersion: '1.0.0' },
      { mode: 'explicit', kind: 'expert-kit', extensionId: 'product', extensionVersion: '1.0.0' },
    ])
    await act(async () => fixtures.sidebar!.onNewTask())
    await act(async () => fixtures.sidebar!.onOpenTask(saved))
    expect(fixtures.chat!.prompt).toBe('/kit:design /kit:product ')
  })
})

it('refreshes ready connector settings between turns and blocks execution after the employee revokes it', async () => {
  const connector: ConnectorCatalogEntry = { id: 'crm', name: 'CRM', summary: '', category: 'other', kind: 'mcp', scope: 'EMPLOYEE',
    status: 'ready', managed: false, version: '1', transport: 'streamable-http', url: 'https://crm.example/old', authMode: 'none', toolNames: ['read'], headers: { 'X-Client': 'xiaoyin' } }
  fixtures.catalog.connectors = [connector]
  localStorage.setItem('xiaoyin.enabled-connectors.queue-test', '["crm"]')
  vi.mocked(runHarnessWithRecovery).mockImplementation(async (input) => ({ sessionId: input.sessionId!, finalResponse: '客户分析完成' } as Awaited<ReturnType<typeof runHarnessWithRecovery>>))
  await fixture(async () => {
    await act(async () => { fixtures.chat!.onToggleTaskConnector!('crm') })
    await submit('分析客户')
    const first = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    expect(first.capabilitySnapshot.connectors[0].headers).toEqual({ 'X-Client': 'xiaoyin' })
    fixtures.catalog.connectors = [{ ...connector, version: '2', url: 'https://crm.example/new', toolNames: ['read', 'search'] }]
    await submit('继续检查')
    const next = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(next.capabilitySnapshot.connectors[0]).toMatchObject({ version: '2', url: 'https://crm.example/new', toolNames: ['read', 'search'] })
    expect(next.sessionId).toBe(first.sessionId)
    expect(first.capabilitySnapshot.connectors[0].version).toBe('1')
    fixtures.catalog.connectors = []
    await submit('总结结果')
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(2)
    expect(fixtures.chat!.localFileError).toContain('连接器尚未就绪')
  })
})

it('refreshes model policy between queued turns without interrupting a running model request', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
    .mockImplementation(async (input) => ({ sessionId: input.sessionId!, finalResponse: '示例' } as Awaited<ReturnType<typeof runHarnessWithRecovery>>))
  await fixture(async () => {
    await submit('解释排序')
    const original = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    await submit('再给一个例子')
    fixtures.models = ['replacement-model']
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(1)
    expect(original.model).toBe('original-model')
    await act(async () => first.resolve({ sessionId: original.sessionId!, finalResponse: '排序说明' }))
    const next = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(next.model).toBe('replacement-model')
    // The new model resumes the same session: continuity without replay.
    expect(next.sessionId).toBe(original.sessionId)
    expect(next.prompt).toBe('再给一个例子')
  })
})

it('does not invent a default model when the policy has no available models', async () => {
  fixtures.models = []
  await fixture(async () => {
    await submit('开始工作')
    expect(runHarnessWithRecovery).not.toHaveBeenCalled()
    expect(fixtures.chat!.localFileError).toContain('没有可用模型')
  })
})

it('pins an extension version for the task and blocks it after disablement', async () => {
  function kit(version: string, enabled = true) {
    return mergeExpertKits([], [{ enabled, installPath: `/extensions/reports/${version}`, source: 'developer', packageSha256: version === '1.0.0' ? 'a'.repeat(64) : 'b'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'reports', name: '报告专家', version, summary: '生成报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [{ id: 'report', path: 'skills/report/SKILL.md' }], connectorRefs: [], requiredTools: [] } }])
  }
  fixtures.catalog.expertKits = kit('1.0.0')
  vi.mocked(runHarnessWithRecovery).mockImplementation(async (input) => ({ sessionId: input.sessionId!, finalResponse: '报告完成' } as Awaited<ReturnType<typeof runHarnessWithRecovery>>))
  await fixture(async () => {
    await submit('/kit:reports 分析报告')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].capabilitySnapshot.artifacts[0].version).toBe('1.0.0')
    fixtures.catalog.expertKits = kit('2.0.0')
    await submit('/kit:reports 继续检查')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].capabilitySnapshot.artifacts[0].version).toBe('1.0.0')
    fixtures.catalog.expertKits = kit('2.0.0', false)
    await submit('/kit:reports 总结')
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(2)
    expect(fixtures.chat!.localFileError).toContain('尚未安装或已不可用')
  })
})

it('injects a message into the running turn instead of queueing it', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  vi.mocked(harness.steerHarness).mockResolvedValue(true)
  await fixture(async () => {
    await submit('整理销售报告')
    const taskId = vi.mocked(runHarnessWithRecovery).mock.calls[0][0].taskId
    await submit('改用方案 B')
    expect(harness.steerHarness).toHaveBeenCalledWith(taskId, '改用方案 B')
    // The steered text rides the current turn: no second run, no queue entry.
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(fixtures.chat!.queue?.items ?? []).toHaveLength(0)
    expect(fixtures.chat!.prompt).toBe('')
    const openTurn = fixtures.chat!.entries.at(-1)
    expect(openTurn).toMatchObject({ role: 'assistant', status: 'streaming', segments: [{ kind: 'user', text: '改用方案 B' }] })
    await act(async () => first.resolve({ sessionId: 'steered-session', finalResponse: '已按方案 B 处理' }))
    expect(fixtures.chat!.entries.at(-1)).toMatchObject({ role: 'assistant', status: 'completed', segments: [
      { kind: 'user', text: '改用方案 B' }, { kind: 'text', text: '已按方案 B 处理' },
    ] })
  })
})

it('queues the message when the turn can no longer take steering', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  vi.mocked(harness.steerHarness).mockResolvedValue(false)
  await fixture(async () => {
    await submit('整理销售报告')
    await submit('改用方案 B')
    expect(fixtures.chat!.queue?.items).toMatchObject([{ text: '改用方案 B' }])
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
  })
})

it('stops the running turn immediately through the isolated process handle', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  await fixture(async () => {
    await submit('检查排序方法')
    await act(async () => fixtures.chat!.onCancel())
    expect(harness.cancelHarness).toHaveBeenCalledOnce()
  })
})

it('does not wait for a graceful interrupt acknowledgement before stopping', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  await fixture(async () => {
    await submit('检查排序方法')
    await act(async () => fixtures.chat!.onCancel())
    expect(harness.cancelHarness).toHaveBeenCalledOnce()
  })
})

it('regenerates the last turn on a forked session and keeps the earlier conversation', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValueOnce({ finalResponse: '第一版答案', sessionId: 'session-one' })
  await fixture(async () => {
    await submit('解释排序算法')
    const taskId = vi.mocked(runHarnessWithRecovery).mock.calls[0][0].taskId
    expect(lastText(fixtures.chat!.entries)).toBe('第一版答案')
    vi.mocked(harness.forkHarness).mockResolvedValue('session-one-r1')
    vi.mocked(runHarnessWithRecovery).mockResolvedValueOnce({ finalResponse: '第二版答案', sessionId: 'session-one-r1' })
    await act(async () => { await fixtures.chat!.onRegenerateTurn!() })
    expect(harness.forkHarness).toHaveBeenCalledWith(taskId)
    const regenerated = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    // The forked session carries the earlier context; the prompt is just the turn's input.
    expect(regenerated.sessionId).toBe('session-one-r1')
    expect(regenerated.prompt).toBe('解释排序算法')
    expect(entriesText(fixtures.chat!.entries)).toEqual(['解释排序算法', '第二版答案'])
    expect(lastText(fixtures.chat!.entries)).toBe('第二版答案')
  })
})

it('rebuilds the session when the log cannot be forked for regeneration', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValueOnce({ finalResponse: '第一版答案', sessionId: 'session-one' })
  await fixture(async () => {
    await submit('解释排序算法')
    vi.mocked(harness.forkHarness).mockRejectedValue(new Error('session log is not a balanced turn prefix'))
    vi.mocked(runHarnessWithRecovery).mockResolvedValueOnce({ finalResponse: '重放后的答案', sessionId: 'session-fresh' })
    await act(async () => { await fixtures.chat!.onRegenerateTurn!() })
    const regenerated = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(regenerated.sessionId).not.toBe('session-one')
    expect(lastText(fixtures.chat!.entries)).toBe('重放后的答案')
  })
})

it('settles a quiet turn when native cancellation does not return', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  vi.mocked(harness.cancelHarness).mockReturnValueOnce(new Promise<boolean>(() => {}))
  vi.useFakeTimers()
  await fixture(async () => {
    await submit('查询这个订单')
    await act(async () => fixtures.chat!.onCancel())
    expect(harness.cancelHarness).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
    expect(fixtures.chat!.currentTaskRunning).toBe(false)
    expect(fixtures.chat!.taskProjection.status).toBe('canceled')
  })
  vi.useRealTimers()
})

it('does not need a delayed stop timer after the turn settles', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  await fixture(async () => {
    await submit('查询这个订单')
    await act(async () => fixtures.chat!.onCancel())
    await act(async () => first.resolve({ finalResponse: '已完成', sessionId: 'settled' }))
    expect(harness.cancelHarness).toHaveBeenCalledOnce()
  })
})
