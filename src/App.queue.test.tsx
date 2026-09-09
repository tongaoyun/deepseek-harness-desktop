// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import type { ChatPage } from './ChatPage'
import type { DesktopSidebar } from './DesktopSidebar'
import type { ScheduledTasksPage } from './ScheduledTasksPage'
import type { CapabilityCatalogPage } from './ExtensionCatalogPages'
import { creationPrompt } from './creationPrompts'
import * as harness from './harness'
import type { ConnectorCatalogEntry, LocalTaskRun } from './types'
import { mergeExpertKits, type ExpertKitView } from './expertKits'
import { runHarnessWithRecovery } from './taskRecovery'
import { reportTaskAudit } from './taskAudit'
import type { TaskOutcome } from './taskOutcome'
import { persistTaskHistory, loadTaskById, loadTaskHistory } from './taskHistory'
import { readTaskDraft, saveTaskDraft } from './taskDrafts'
import { useHarnessNotifications } from './useHarnessNotifications'
import { rememberInstruction, emptyMemoryProfile, learnCompletedTask } from './memory'

const fixtures = vi.hoisted(() => ({
  drop: undefined as Parameters<typeof import('./useDesktopDrop').useDesktopDrop>[0] | undefined,
  models: ['original-model', 'other-model'],
  user: { userId: 'queue-test', teamId: 'team', name: '测试员工' },
  catalog: { connectors: [] as ConnectorCatalogEntry[], expertKitCatalog: [], expertKits: [] as ExpertKitView[], knowledgeBases: [], skills: [], skillViews: [], syncIssues: [], loading: false },
  chat: undefined as ComponentProps<typeof ChatPage> | undefined,
  sidebar: undefined as ComponentProps<typeof DesktopSidebar> | undefined,
  schedules: undefined as ComponentProps<typeof ScheduledTasksPage> | undefined,
  creationCatalog: undefined as ComponentProps<typeof CapabilityCatalogPage> | undefined,
}))
vi.mock('./useEnterpriseSession', () => ({ useEnterpriseSession: () => ({ state: 'authenticated', user: fixtures.user, accessToken: 'test' }) }))
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
vi.mock('./api', async (original) => ({ ...await original<object>(), loadBootstrap: async () => ({ models: [...fixtures.models], capabilities: [], endpoints: { litellm: '/model', knowledge: '/knowledge', schedules: '/schedules' } }) }))
vi.mock('./taskHistory', async (original) => ({ ...await original<object>(), loadTaskHistory: vi.fn(async () => []), loadTaskById: vi.fn(), persistTaskHistory: vi.fn(async () => {}) }))
vi.mock('./taskRecovery', () => ({ runHarnessWithRecovery: vi.fn() }))
vi.mock('./taskAudit', () => ({ reportTaskAudit: vi.fn(async () => {}) }))
vi.mock('./memory', async (original) => ({ ...await original<object>(), rememberInstruction: vi.fn(), learnCompletedTask: vi.fn(async () => undefined) }))
vi.mock('./harness', async (original) => ({ ...await original<object>(), clearLocalDirectories: async () => {}, restoreLocalDirectories: async () => [], shutdownHarness: async () => {}, cancelHarness: async () => true }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const completedOutcome: TaskOutcome = { status: 'completed', summary: '已完成本次要求', remaining: [], checks: [] }

const olderTask = (): LocalTaskRun => ({ id: 'older-task', source: 'DESKTOP', name: '更早的定时任务', status: 'COMPLETED', createdAt: '2026-09-01', updatedAt: '2026-09-01', monitor: harness.createTaskMonitor(), messages: [{ role: 'user', text: '保留原始需求' }, { role: 'assistant', text: '历史成果已生成' }] })
it('starts a file generation task in the default workspace without requiring a directory picker', async () => {
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '成果已生成', sessionId: 'workspace-task' })
  await fixture(async () => {
    await submit('在默认工作目录创建测试文件')
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(fixtures.chat!.localFileError).toBe('')
    expect(fixtures.chat!.messages.at(-1)?.text).toBe('成果已生成')
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
    expect(fixtures.chat!.messages.map((message) => message.text).slice(0, 3)).toEqual(['解释排序算法', '原来的成果', '记住：以后用中文'])
    expect(fixtures.chat!.messages.at(-1)?.text).toContain('本机生效')
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
it('keeps a save failure visible on other pages and retries without running the task again', async () => {
  vi.mocked(persistTaskHistory).mockRejectedValue(new Error('模拟磁盘故障'))
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '内存中的最新结果', sessionId: 'save-test' })
  await fixture(async () => {
    await submit('保存测试')
    expect(document.querySelector('.task-save-warning')?.textContent).toContain('1 个任务尚未保存')
    await act(async () => fixtures.sidebar!.onPage('skills'))
    expect(document.querySelector('.task-save-warning')?.textContent).toContain('模拟磁盘故障')
    vi.mocked(persistTaskHistory).mockResolvedValue(undefined)
    await act(async () => document.querySelector<HTMLButtonElement>('.task-save-warning button')!.click())
    expect(document.querySelector('.task-save-warning')).toBeNull()
    expect(vi.mocked(persistTaskHistory).mock.calls.at(-1)![1].messages.at(-1)?.text).toBe('内存中的最新结果')
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
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
it('opens an unloaded scheduled task directly from durable history', async () => {
  vi.mocked(loadTaskById).mockResolvedValue(olderTask())
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onPage('schedules'))
    await act(async () => fixtures.schedules!.onOpenLocalTask!('older-task'))
    expect(loadTaskById).toHaveBeenCalledWith('queue-test', 'older-task')
    expect(fixtures.sidebar!.activeTaskId).toBe('older-task')
    expect(fixtures.chat!.messages[0].text).toBe('保留原始需求')
    expect(fixtures.sidebar!.tasks.some((task) => task.id === 'older-task')).toBe(true)
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
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: 'SCHEDULE_OK', sessionId: 'schedule-session', outcome: completedOutcome })
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
      expect(saved.messages.at(-1)?.text).toBe('SCHEDULE_OK')
      expect(fixtures.schedules!.local!.items[0].runs[0]).toMatchObject({ status: 'COMPLETED', taskId: saved.id })
      await act(async () => fixtures.sidebar!.onPage('chat'))
      expect(fixtures.chat!.prompt).toBe('未发送的日常草稿')
    })
  } finally { available.mockRestore() }
})
it.each(['other-model', 'removed-model'])('uses the scheduled model or pauses an unavailable model: %s', async (model) => {
  const available = vi.spyOn(harness, 'connectorDiagnosticsAvailable').mockReturnValue(true)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, options: unknown, handler?: (lock: object) => unknown) => (handler ?? options as (lock: object) => unknown)({}) } })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: 'MODEL_OK', sessionId: 'model-session', outcome: completedOutcome })
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
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '附件读取完成', sessionId: 'attachment-session', outcome: completedOutcome })
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
      expect(fixtures.chat!.taskMonitor.status).toBe('canceled')
      await act(async () => fixtures.sidebar!.onPage('schedules'))
      expect(fixtures.schedules!.local!.items[0]).toMatchObject({ active: false, runs: [{ taskId, status: 'CANCELED' }] })
      expect(vi.mocked(persistTaskHistory).mock.calls.at(-1)![1].status).toBe('CANCELED')
    })
  } finally { available.mockRestore() }
})

beforeEach(() => {
  vi.mocked(runHarnessWithRecovery).mockReset()
  vi.mocked(loadTaskHistory).mockResolvedValue([])
  fixtures.models = ['original-model', 'other-model']
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) })
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected network access in queue regression'))))
  Element.prototype.scrollTo = vi.fn()
})
afterEach(() => { fixtures.catalog.connectors = []; fixtures.catalog.expertKits = []; vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals() })

async function fixture(check: () => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try { await act(async () => root.render(<App />)); await check() }
  finally { await act(async () => root.unmount()); container.remove() }
}
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
    await act(async () => { first.resolve({ finalResponse: '排序说明', sessionId: original.sessionId!, outcome: completedOutcome }) })
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(2)
    const continuation = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(continuation).toMatchObject({ taskId: original.taskId, sessionId: original.sessionId, model: 'original-model', prompt: '再给一个例子' })
    expect(fixtures.chat!.prompt).toBe('另一个任务的草稿')
    expect(fixtures.chat!.activeModel).toBe('other-model')
    expect(fixtures.chat!.messages).toEqual([])
    await act(async () => { second.resolve({ finalResponse: '示例', sessionId: original.sessionId!, outcome: completedOutcome }) })
    const saved = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1] as LocalTaskRun
    expect(saved.messages.map((message) => message.text)).toEqual(['解释排序算法', '排序说明', '再给一个例子', '示例'])
    expect(fixtures.chat!.prompt).toBe('另一个任务的草稿')
  })
})

it.each(['partial', 'needs_input', 'needs_confirmation', 'blocked', 'unverified', undefined] as const)('retains incomplete outcomes and pauses queued work: %s', async (status) => {
  const first = deferredRun()
  const outcome: TaskOutcome | undefined = status ? { status, summary: '已生成初稿，尚待补充', remaining: ['补充销售数据'], checks: [] } : undefined
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise)
  await fixture(async () => {
    await submit('整理销售报告')
    await submit('将报告发给团队')
    await act(async () => first.resolve({ finalResponse: '已生成初稿', sessionId: 'report', outcome }))
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(fixtures.chat!.queue).toMatchObject({ paused: true, items: [{ text: '将报告发给团队' }] })
    expect(fixtures.chat!.taskMonitor.outcome?.status).toBe(status ?? 'unverified')
    const saved = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1]
    expect(saved.monitor.outcome).toEqual(fixtures.chat!.taskMonitor.outcome)
    expect(saved.messages.at(-1)?.monitor?.outcome).toEqual(saved.monitor.outcome)
    expect(reportTaskAudit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCEEDED' }))
    expect(learnCompletedTask).not.toHaveBeenCalled()
  })
})

it('runs clarification directly while preserving the paused queue', async () => {
  const first = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise).mockResolvedValue({ finalResponse: '报告已补齐', sessionId: 'report', outcome: completedOutcome })
  await fixture(async () => {
    await submit('整理销售报告')
    await submit('将报告发给团队')
    await act(async () => first.resolve({ finalResponse: '缺少统计月份', sessionId: 'report', outcome: { status: 'needs_input', summary: '缺少统计月份', remaining: ['提供月份'], checks: [] } }))
    await submit('统计八月份')
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].prompt).toBe('统计八月份')
    expect(fixtures.chat!.queue).toMatchObject({ paused: true, items: [{ text: '将报告发给团队' }] })
    expect(fixtures.chat!.taskMonitor.outcome?.status).toBe('completed')
    expect(reportTaskAudit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'SUCCEEDED' }))
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
    expect(fixtures.chat!.taskMonitor.status).toBe('failed')
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
    await act(async () => { first.resolve({ finalResponse: '完成', sessionId: original.sessionId!, outcome: completedOutcome }) })
    expect(runHarnessWithRecovery).toHaveBeenCalledOnce()
    expect(fixtures.chat!.queue?.paused).toBe(true)
    expect(fixtures.chat!.queue?.items[0].text).toBe('再给一个例子')
    expect(fixtures.chat!.taskMonitor.status).toBe('canceled')
    expect(fixtures.chat!.taskMonitor.failure).toBeUndefined()
    expect(fixtures.chat!.currentTaskRunning).toBe(false)
    expect(fixtures.chat!.messages.at(-1)?.text).not.toBe('完成')
  })
})

it('preserves partial output and completed work after stop, then continues with conversation context', async () => {
  const first = deferredRun(); const next = deferredRun()
  vi.mocked(runHarnessWithRecovery).mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
  await fixture(async () => {
    await submit('检查排序方法')
    expect(fixtures.chat!.taskMonitor.activity).toBe('正在处理')
    const request = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    const hook = vi.mocked(useHarnessNotifications).mock.calls.at(-1)![0]
    const streaming = hook.streamingTasksRef.current.get(request.taskId)!
    streaming.messages.at(-1)!.text = '已经检查了第一种方法。'
    streaming.monitor.steps = [{ id: 'done', kind: 'tool', label: '已检查', status: 'completed', startedAt: '' }, { id: 'pending', kind: 'tool', label: '检查中', status: 'running', startedAt: '' }]
    await act(async () => fixtures.chat!.onCancel())
    expect(fixtures.chat!.taskMonitor.activity).toBe('正在停止')
    await act(async () => first.reject(new Error('Host exited')))
    expect(fixtures.chat!.messages.at(-1)?.text).toBe('已经检查了第一种方法。')
    expect(fixtures.chat!.taskMonitor.steps.map((step) => step.status)).toEqual(['completed', 'canceled'])
    expect(fixtures.chat!.taskMonitor.failure).toBeUndefined()
    await submit('继续解释第二种')
    const continuation = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(continuation.taskId).toBe(request.taskId)
    expect(continuation.sessionId).not.toBe(request.sessionId)
    expect(continuation.prompt).toContain('已经检查了第一种方法。')
    expect(continuation.prompt).toContain('继续解释第二种')
    await act(async () => next.resolve({ sessionId: continuation.sessionId!, finalResponse: '第二种方法。' } as Awaited<ReturnType<typeof runHarnessWithRecovery>>))
    expect(fixtures.chat!.taskMonitor.status).toBe('completed')
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
    streaming.messages.at(-1)!.text = '第一份报表已生成，第二份尚未完成。'
    streaming.monitor.artifacts = [{ id: 'root:one.csv', rootId: 'root', rootName: '工作目录', path: 'one.csv', name: 'one.csv', kind: 'spreadsheet', action: 'published', sourceTool: 'local_files_publish', createdAt: '' }]
    await act(async () => first.reject(new Error('本轮达到模型输出上限')))
    expect(fixtures.chat!.taskMonitor.status).toBe('failed')
    expect(fixtures.chat!.messages.at(-1)?.text).toContain('第一份报表已生成')
    expect(fixtures.chat!.messages.at(-1)?.text).toContain('错误编号')
    expect(fixtures.chat!.taskMonitor.artifacts).toHaveLength(1)
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
    capabilitySnapshot: { createdAt: '', extensions: [], connectors: [], knowledgeBaseRefs: [] } }
  vi.spyOn(harness, 'restoreLocalDirectories').mockResolvedValue(directories)
  saveTaskDraft('queue-test', task.id, { prompt, attachments: [], directories, knowledgeRefs: [], connectorIds: [], model: 'original-model', updatedAt: 1 })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '复查完成', sessionId: 'persisted-session', outcome: completedOutcome })
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onOpenTask(task))
    expect(fixtures.chat!.prompt).toBe(prompt)
    await submit('复查原任务')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0]).toMatchObject({ sessionId: 'persisted-session', prompt: '复查原任务' })
  })
})

it('resumes an installed kit after native persistence reorders the capability snapshot', async () => {
  fixtures.catalog.expertKits = mergeExpertKits([], [{ installPath: '/extensions/reports', source: 'developer', packageSha256: 'a'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'reports', name: '报告专家', version: '1.0.0', summary: '生成报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [{ id: 'report', path: 'skills/report/SKILL.md' }], connectorRefs: [], requiredTools: [], serverWorkflows: [] } }])
  vi.mocked(runHarnessWithRecovery).mockImplementation(async (request) => ({ finalResponse: '完成', sessionId: request.sessionId!, outcome: completedOutcome }))
  let stored!: LocalTaskRun
  await fixture(async () => {
    await submit('/kit:reports 分析销售情况')
    const task = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1]
    stored = JSON.parse(JSON.stringify(task, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value))
  })
  vi.mocked(loadTaskHistory).mockResolvedValue([stored])
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onOpenTask(stored))
    await submit('/kit:reports 只读复查')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls.at(-1)![0]).toMatchObject({ sessionId: stored.sessionId, prompt: '/kit:reports 只读复查' })
  })
})

it('starts a new session when a restored draft changes the workspace', async () => {
  const task: LocalTaskRun = { ...olderTask(), sessionId: 'persisted-session', model: 'original-model', localDirectories: [{ id: 'old', name: '旧目录', path: '/old' }],
    capabilitySnapshot: { createdAt: '', extensions: [], connectors: [], knowledgeBaseRefs: [] } }
  const directories = [{ id: 'new', name: '新目录', path: '/new' }]
  vi.spyOn(harness, 'restoreLocalDirectories').mockResolvedValue(directories)
  saveTaskDraft('queue-test', task.id, { prompt: '继续', attachments: [], directories, knowledgeRefs: [], connectorIds: [], model: 'original-model', updatedAt: 1 })
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'new-session', outcome: completedOutcome })
  await fixture(async () => {
    await act(async () => fixtures.sidebar!.onOpenTask(task))
    await submit('检查当前目录')
    const request = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    expect(request.sessionId).not.toBe('persisted-session')
    expect(request.prompt).toContain('保留原始需求')
  })
})

it('sends only task-selected connectors and returns to automatic tools after removing the selection', async () => {
  fixtures.catalog.connectors = ['crm', 'drive'].map((id) => ({ id, name: id, summary: '', category: 'other', kind: 'mcp', scope: 'EMPLOYEE', status: 'ready', managed: false, version: '1', transport: 'streamable-http', url: `https://${id}.example/mcp`, authMode: 'none', toolNames: [`${id}_read`] })) as ConnectorCatalogEntry[]
  localStorage.setItem('xiaoyin.enabled-connectors.queue-test', JSON.stringify(['crm', 'drive']))
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'test-session' })
  await fixture(async () => {
    await act(async () => { fixtures.chat!.onToggleTaskConnector!('crm') })
    await submit('分析客户情况')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].connectors.map((item) => item.id)).toEqual(['crm'])
    await act(async () => { fixtures.chat!.onToggleTaskConnector!('crm') })
    await submit('继续分析')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].connectors.map((item) => item.id)).toEqual(['crm', 'drive'])
    await act(async () => { fixtures.chat!.onToggleTaskConnector!('unavailable') })
    await submit('继续')
    expect(runHarnessWithRecovery).toHaveBeenCalledTimes(2)
    expect(fixtures.chat!.localFileError).toContain('连接器尚未就绪')
  })
})

it('executes the selected kit and stops forcing it after the user removes the capability', async () => {
  fixtures.catalog.expertKits = mergeExpertKits([], [{ installPath: '/extensions/reports', source: 'developer', packageSha256: 'a'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'reports', name: '报告专家', version: '1.0.0', summary: '生成报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [{ id: 'report', path: 'skills/report/SKILL.md' }], connectorRefs: [], requiredTools: [], serverWorkflows: [] } }])
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'kit-session' })
  await fixture(async () => {
    await submit('/kit:reports 分析销售情况')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].selectedExtensions).toEqual([{ kind: 'expert-kit', id: 'reports' }])
    expect(fixtures.chat!.prompt).toBe('/kit:reports ')
    await submit('解释排序算法')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].selectedExtensions).toEqual([])
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].sessionId).not.toBe('kit-session')
  })
})

it('persists both kits and retains them when reopening the task', async () => {
  fixtures.catalog.expertKits = mergeExpertKits([], ['design', 'product'].map((id) => ({ installPath: `/extensions/${id}`, source: 'developer', packageSha256: 'a'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id, name: id, version: '1.0.0', summary: id, category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [{ id, path: `skills/${id}/SKILL.md` }], connectorRefs: [], requiredTools: [], serverWorkflows: [] } })))
  vi.mocked(runHarnessWithRecovery).mockResolvedValue({ finalResponse: '完成', sessionId: 'combined-session' })
  await fixture(async () => {
    await submit('/kit:design /kit:product 制定产品方案')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].selectedExtensions).toEqual([{ kind: 'expert-kit', id: 'design' }, { kind: 'expert-kit', id: 'product' }])
    expect(fixtures.chat!.prompt).toBe('/kit:design /kit:product ')
    const saved = vi.mocked(persistTaskHistory).mock.calls.at(-1)![1]
    expect(saved.invocationTokens).toEqual(['/kit:design', '/kit:product'])
    await act(async () => fixtures.sidebar!.onNewTask())
    await act(async () => fixtures.sidebar!.onOpenTask(saved))
    expect(fixtures.chat!.prompt).toBe('/kit:design /kit:product ')
  })
})

it('uses changed connector settings on continuation, keeps configured defaults, and drops deleted connectors', async () => {
  const connector: ConnectorCatalogEntry = { id: 'crm', name: 'CRM', summary: '', category: 'other', kind: 'mcp', scope: 'EMPLOYEE',
    status: 'ready', managed: false, version: '1', transport: 'streamable-http', url: 'https://crm.example/old', authMode: 'none', toolNames: ['read'], headers: { 'X-Client': 'xiaoyin' } }
  fixtures.catalog.connectors = [connector]
  localStorage.setItem('xiaoyin.enabled-connectors.queue-test', '["crm"]')
  vi.mocked(runHarnessWithRecovery).mockImplementation(async (input) => ({ sessionId: input.sessionId!, finalResponse: '客户分析完成' } as Awaited<ReturnType<typeof runHarnessWithRecovery>>))
  await fixture(async () => {
    await submit('分析客户')
    const first = vi.mocked(runHarnessWithRecovery).mock.calls[0][0]
    expect(first.connectors[0].headers).toEqual({ 'X-Client': 'xiaoyin' })
    fixtures.catalog.connectors = [{ ...connector, version: '2', url: 'https://crm.example/new', toolNames: ['read', 'search'] }]
    await submit('继续检查')
    const next = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(next.connectors[0]).toMatchObject({ version: '2', url: 'https://crm.example/new', toolNames: ['read', 'search'] })
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(next.prompt).toContain('客户分析完成')
    expect(first.connectors[0].version).toBe('1')
    fixtures.catalog.connectors = []
    await submit('总结结果')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[2][0].connectors).toEqual([])
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
    await act(async () => first.resolve({ sessionId: original.sessionId!, finalResponse: '排序说明', outcome: completedOutcome }))
    const next = vi.mocked(runHarnessWithRecovery).mock.calls[1][0]
    expect(next.model).toBe('replacement-model')
    expect(next.sessionId).not.toBe(original.sessionId)
    expect(next.prompt).toContain('排序说明')
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

it('applies installed extension updates and disablement to the next turn', async () => {
  function kit(version: string, enabled = true) {
    return mergeExpertKits([], [{ enabled, installPath: `/extensions/reports/${version}`, source: 'developer', packageSha256: version === '1.0.0' ? 'a'.repeat(64) : 'b'.repeat(64), manifest: { schemaVersion: '2', kind: 'expert-kit', id: 'reports', name: '报告专家', version, summary: '生成报告', category: 'other', minimumDesktopVersion: '0.1.30', commands: [], skills: [{ id: 'report', path: 'skills/report/SKILL.md' }], connectorRefs: [], requiredTools: [], serverWorkflows: [] } }])
  }
  fixtures.catalog.expertKits = kit('1.0.0')
  vi.mocked(runHarnessWithRecovery).mockImplementation(async (input) => ({ sessionId: input.sessionId!, finalResponse: '报告完成' } as Awaited<ReturnType<typeof runHarnessWithRecovery>>))
  await fixture(async () => {
    await submit('分析报告')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[0][0].allowedArtifacts[0].version).toBe('1.0.0')
    fixtures.catalog.expertKits = kit('2.0.0')
    await submit('继续检查')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[1][0].allowedArtifacts[0].version).toBe('2.0.0')
    fixtures.catalog.expertKits = kit('2.0.0', false)
    await submit('总结')
    expect(vi.mocked(runHarnessWithRecovery).mock.calls[2][0].allowedArtifacts).toEqual([])
  })
})
