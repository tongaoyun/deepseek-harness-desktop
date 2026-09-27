import { FolderOpen } from 'lucide-react'
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  createExpertKitDownload,
  loadExpertKitReadme,
  createSkillDownload,
  loadKnowledgeBases,
  resolveServerEndpoint,
  localScheduleNamespace,
  submitFeedback,
} from './api'
import { DingTalkAuthScreen } from './DingTalkAuthScreen'
import { TASK_RESUME_PROMPT } from './taskInterruption'
import { openDingTalkLogin } from './auth'
import { ExpertKitDetailsModal } from './ExpertKitDetailsModal'
import { extensionCustomizationPrompt } from './expertKitDetails'
import { SkillDetailsModal } from './SkillDetailsModal'
import {
  customizeExpertKit,
  exportExpertKit,
  installDeveloperExtension,
  installExtension,
  removeCatalogExtension,
  removeDeveloperExpertKit,
  removeDeveloperExtension,
  type ExpertKitView,
} from './expertKits'
import {
  authorizeLocalDirectory,
  authorizeDroppedPaths,
  authorizeLocalFiles,
  importPastedFile,
  clipboardFilePaths,
  type DroppedPathAuthorization,
  authorizeStandardLocalDirectories,
  cancelHarness,
  checkHarnessProvider,
  clearLocalDirectories,
  classifyHarnessFailure,
  createHarnessFailure,
  connectorDiagnosticsAvailable,
  createXiaoyinTaskProjection,
  diagnoseConnectors,
  restoreLocalDirectories,
  inspectHarnessSession,
  forkHarness,
  respondHarnessApproval,
  respondHarnessQuestion,
  steerHarness,
  revokeLocalDirectory,
  shutdownHarness,
  type AuthorizedLocalDirectory,
} from './harness'
import { loadHarnessExternalAgentsEnabled, loadHarnessHooksEnabled, loadHarnessLspEnabled, loadHarnessShellEnabled, saveHarnessExternalAgentsEnabled, saveHarnessHooksEnabled, saveHarnessLspEnabled, saveHarnessShellEnabled } from './runtimePreferences'
import type {
  ConnectorCatalogEntry,
  LocalTaskAttachment,
} from './types'
import { useEnterpriseSession } from './useEnterpriseSession'
import { ScheduledTasksPage } from './ScheduledTasksPage'
import { ImChannelsPage } from './ImChannelsPage'
import { loadTaskHistory, loadTaskById, persistCapabilityNotice, persistTaskHistory, removeTaskHistory } from './taskHistory'
import { useTaskPersistence } from './useTaskPersistence'
import { useHistoryPages } from './useHistoryPages'
import { useTaskCheckpoints } from './useTaskCheckpoints'
import { useLocalSchedules } from './useLocalSchedules'
import { useLocalScheduleTools } from './useLocalScheduleTools'
import { useLocalSkillTools } from './useLocalSkillTools'
import { attachmentSelectionError } from './attachmentLimits'
import { restoredTaskSessionId } from './harnessSession'
import { prepareTaskTurn } from './taskTurn'
import { startLocalIm, stopLocalImRuntime } from './localIm'
import type { ConversationEntry } from './conversation/types'
import { appendSteerToOpenTurn, ensureFinalText, reconcileTaskConversation, resetOpenTurn, settleOpenTurn } from './conversation/entries'
import type { InstalledExpertKit, LocalTaskRun, XiaoyinTaskProjection } from './types'
import { parseMemoryCommand, learnCompletedTask } from './memory'
import { useMemoryCommands } from './useMemoryCommands'
import { useMemorySync } from './useMemorySync'
import { availableModels, loadSelectedModel, resolveSelectedModel, saveSelectedModel } from './modelSelection'
import { loadReasoningEffort, resolveReasoningEffort, saveReasoningEffort, type ReasoningEffort } from './modelReasoning'
import { standardLocalDirectories } from './localFileIntent'
import { creationPrompt, type XiaoyinCreationKind } from './creationPrompts'
import { McpConnectorDialog } from './McpConnectorDialog'
import { ExtensionUploadDialog } from './ExtensionUploadDialog'
import { extensionInvocations, sameCapabilitySelection, selectedInvocations } from './extensionInvocations'
import { persistBundledConnectors } from './connectorImport'
import { buildRuntimeConnectorCatalog } from './connectors'
import { loadEnabledConnectorIds, saveEnabledConnectorIds } from './connectorPreferences'
import {
  connectorSecretTemplate,
  connectorSecretValues,
  deleteConnectorSecrets,
  loadConnectorSecrets,
  saveConnectorSecrets,
  type ConnectorSecretStore,
} from './connectorSecrets'
import { KnowledgeBasePage } from './KnowledgeBasePage'
import { DesktopSettingsPage } from './DesktopSettingsPage'
import { ConnectorsPage } from './ConnectorsPage'
import { connectorAuthorization } from './connectorAuthorization'
import type { SkillView } from './skills'
import { assertKnowledgeBaseRefsAvailable, capabilitySnapshotForExecution, reconcileConnectorSnapshot, resolveCapabilitySnapshot } from './capabilitySnapshot'
import { useEnterpriseBootstrap } from './useEnterpriseBootstrap'
import { DesktopSidebar } from './DesktopSidebar'
import { ChatPage } from './ChatPage'
import { extensionMatches, type ExtensionFilter } from './ExtensionToolbar'
import type { ExtensionCategoryFilter } from './extensionCategories'
import { CapabilityCatalogPage } from './ExtensionCatalogPages'
import { ExtensionAuthoringModal } from './ExtensionAuthoringModal'
import { deletePersonalConnector, loadPersonalConnectors, savePersonalConnector, type ExtensionKind } from './extensionSubmissions'
import { ExtensionPageActions } from './ExtensionPageActions'
import { useEnterpriseCatalog } from './useEnterpriseCatalog'
import { useDesktopDialog } from './DesktopDialog'
import { runHarnessWithRecovery } from './taskRecovery'
import { useHarnessHealth } from './useHarnessHealth'
import { useDeviceHeartbeat } from './useDeviceHeartbeat'
import { inspectDeviceHeartbeatContext } from './deviceHeartbeat'
import { reportTaskAudit } from './taskAudit'
import { useDesktopDrop } from './useDesktopDrop'
import { useApplyDesktopPreferences } from './desktopPreferences'
import { useLocalImSync } from './useLocalImSync'
import { useHarnessNotifications, type StreamingTaskState } from './useHarnessNotifications'
import { AUTOMATIC_TASK_LIMIT, useTaskQueue, type QueuedPrompt } from './useTaskQueue'
import { clearStagedTaskDraft, draftRootPaths, loadTaskDraftState, readTaskDraft, recentWorkDirectories, rememberWorkDirectory, saveTaskDraft, stageTaskDraft, type TaskDraft } from './taskDrafts'
import { joinComposerPrompt, splitComposerPrompt } from './composerInput'
import './styles.css'

const extensionNav = [
  { id: 'skills', label: '技能与套件' },
  { id: 'connectors', label: '连接器' },
  { id: 'knowledge', label: '知识库' },
]

function sameValues(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return expected.size === right.length && left.every((value) => expected.has(value))
}

function taskProjectionRunning(current: XiaoyinTaskProjection, now: string): XiaoyinTaskProjection {
  return { ...current, status: 'running', activity: '正在处理', updatedAt: now, startedAt: current.startedAt ?? now, executionStarted: false, retry: undefined }
}

function taskProjectionCompleted(current: XiaoyinTaskProjection, now: string): XiaoyinTaskProjection {
  return { ...current, status: 'completed', activity: '任务已完成', updatedAt: now, completedAt: now, retry: undefined }
}

function taskProjectionFailed(current: XiaoyinTaskProjection, failure: ReturnType<typeof classifyHarnessFailure>, canceled: boolean, now: string): XiaoyinTaskProjection {
  return {
    ...current,
    status: canceled ? 'canceled' : 'failed',
    activity: canceled ? '已停止' : '任务执行失败',
    updatedAt: now,
    completedAt: now,
    failure: canceled ? undefined : {
      code: failure.code,
      category: failure.category,
      detail: failure.message.slice(0, 500),
      title: failure.title,
      infrastructure: failure.infrastructure,
      retryable: failure.retryable,
    },
    retry: undefined,
    steps: current.steps.map((step) => step.status === 'running' ? { ...step, status: 'canceled', completedAt: now, label: `${step.label}（结果待核对）` } : step),
    timeline: current.timeline?.map((entry) => entry.status === 'running' ? { ...entry, status: 'canceled', completedAt: now, label: `${entry.label}（结果待核对）` } : entry),
    subagents: current.subagents?.map((agent) => agent.status === 'running' ? { ...agent, status: 'canceled', completedAt: now } : agent),
  }
}

export default function App() {
  const session = useEnterpriseSession()
  const owner = session.state === 'authenticated' ? session.user?.userId : undefined
  const [activeOwner, setActiveOwner] = useState(owner)
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [transitionError, setTransitionError] = useState('')
  const [transitionAttempt, setTransitionAttempt] = useState(0)
  const cleanupQueue = useRef<Promise<void>>(Promise.resolve())
  const cleanupStarted = useRef(false)
  const transitioning = useRef(false)
  useEffect(() => {
    if (cleanupStarted.current && activeOwner === owner && !transitioning.current) return
    cleanupStarted.current = true
    transitioning.current = true
    setWorkspaceReady(false)
    let obsolete = false
    setTransitionError('')
    const cleanup = cleanupQueue.current.then(async () => {
      await Promise.all([shutdownHarness(), stopLocalImRuntime(), clearLocalDirectories()])
    })
    cleanupQueue.current = cleanup.catch(() => undefined)
    void cleanup.then(() => {
      if (!obsolete) { transitioning.current = false; setActiveOwner(owner); setWorkspaceReady(true) }
    }, () => {
      if (!obsolete) setTransitionError('旧账号的本地任务未能停止，请重试。')
    })
    return () => { obsolete = true }
  }, [activeOwner, owner, transitionAttempt])
  if (!workspaceReady || activeOwner !== owner || transitioning.current) {
    return <DingTalkAuthScreen authorizing={false} checking={!transitionError} error={transitionError}
      onReopen={() => setTransitionAttempt((value) => value + 1)} />
  }
  return <EmployeeWorkspace key={owner ? `employee:${owner}` : 'signed-out'} session={session} />
}

function EmployeeWorkspace({ session }: { session: ReturnType<typeof useEnterpriseSession> }) {
  useApplyDesktopPreferences()
  const { confirm: confirmAction, dialog: confirmationDialog, notify, toast } = useDesktopDialog()
  const { sessionToken, authorizing, error: authError, logout, reopen, state: authState, user } = session
  const sessionTokenForApi = sessionToken
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const { bootstrap, runtimeStatus, error: configurationError } = useEnterpriseBootstrap(authState === 'authenticated' ? user?.userId : undefined, sessionToken, connectionAttempt)
  const memoryCommands = useMemoryCommands(confirmAction)
  useMemorySync(bootstrap ? user?.userId : undefined, bootstrap?.endpoints.memoryProfile ?? '/api/v1/memory-profile', sessionTokenForApi,
    () => notify('记忆存在跨设备修改冲突，请到设置 → 记忆选择版本。本机内容已保留。', 'error'))
  const [prompt, setPrompt] = useState('')
  const [page, setPage] = useState('chat')
  const [imConversationKey, setImConversationKey] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [entries, setEntries] = useState<ConversationEntry[]>([])
  const [localTasks, setLocalTasks] = useState<LocalTaskRun[]>([])
  const taskPersistence = useTaskPersistence(user?.userId, localTasks)
  const historyOwnerRef = useRef('')
  const storedTaskOpenRef = useRef(0)
  const [currentLocalTaskId, setCurrentLocalTaskId] = useState('')
  const [authoringKind, setAuthoringKind] = useState<ExtensionKind>()
  const [uploadKind, setUploadKind] = useState<'skill' | 'expert-kit'>()
  const [authoringInstructions, setAuthoringInstructions] = useState('')
  const [editingConnector, setEditingConnector] = useState<ConnectorCatalogEntry>()
  const [creationKind, setCreationKind] = useState<'skill' | 'expert-kit'>()
  const [capabilityKind, setCapabilityKind] = useState<'skills' | 'packs'>('skills')
  const [enabledConnectorIds, setEnabledConnectorIds] = useState<string[]>([])
  const [connectorSecrets, setConnectorSecrets] = useState<ConnectorSecretStore>({})
  const [expertKitError, setExpertKitError] = useState('')
  const {
    connectors,
    expertKitCatalog,
    expertKits,
    error: enterpriseCatalogError,
    knowledgeBases,
    loading: expertKitsLoading,
    refresh: refreshEnterpriseCatalog,
    refreshInstalled: refreshCatalogInstalled,
    replaceConnectors,
    skills,
    skillViews,
  } = useEnterpriseCatalog({ sessionToken, bootstrap, enabledConnectorIds, user })
  const [developerKitBusy, setDeveloperKitBusy] = useState(false)
  const localExtensionInstallLock = useRef(false)
  const [installingKitId, setInstallingKitId] = useState('')
  const [installingSkillId, setInstallingSkillId] = useState('')
  const [removingCatalogId, setRemovingCatalogId] = useState('')
  const [activeExpertKitId, setActiveExpertKitId] = useState('')
  const [activeSkillId, setActiveSkillId] = useState('')
  const [harnessSessionId, setHarnessSessionId] = useState('')
  const [currentCapabilitySnapshot, setCurrentCapabilitySnapshot] = useState<import('./types').CapabilitySnapshot>()
  const [selectedKnowledgeBaseRefs, setSelectedKnowledgeBaseRefs] = useState<string[]>([])
  const [selectedTaskConnectorIds, setSelectedTaskConnectorIds] = useState<string[]>([])
  const [recentDirectories, setRecentDirectories] = useState<AuthorizedLocalDirectory[]>([])
  const [pastingAttachments, setPastingAttachments] = useState(false)
  const draftOwnerRef = useRef('')
  const draftPausedRef = useRef(true)
  const [runningTaskIds, setRunningTaskIds] = useState<string[]>([])
  const [taskContextRestoring, setTaskContextRestoring] = useState(false)
  const runtimePreferenceOwner = user?.userId ?? ''
  const [allowShell, setAllowShell] = useState(() => loadHarnessShellEnabled(runtimePreferenceOwner))
  const [allowLsp, setAllowLsp] = useState(() => loadHarnessLspEnabled(runtimePreferenceOwner))
  const [allowExternalAgents, setAllowExternalAgents] = useState(() => loadHarnessExternalAgentsEnabled(runtimePreferenceOwner))
  const [allowHooks, setAllowHooks] = useState(() => loadHarnessHooksEnabled(runtimePreferenceOwner))
  useEffect(() => {
    setAllowShell(loadHarnessShellEnabled(runtimePreferenceOwner))
    setAllowLsp(loadHarnessLspEnabled(runtimePreferenceOwner))
    setAllowExternalAgents(loadHarnessExternalAgentsEnabled(runtimePreferenceOwner))
    setAllowHooks(loadHarnessHooksEnabled(runtimePreferenceOwner))
  }, [runtimePreferenceOwner])
  const {
    health: harnessHealth,
    detail: harnessHealthDetail,
    hostHealth: harnessHostHealth,
    recover: recoverHarness,
    reportInfrastructureFailure,
  } = useHarnessHealth(authState === 'authenticated', Boolean(bootstrap?.modelApiKey), allowShell, allowLsp, allowExternalAgents, allowHooks)
  const harnessOperational = harnessHealth === 'idle' || harnessHealth === 'ready'
  const [taskProjection, setTaskProjection] = useState<XiaoyinTaskProjection>(createXiaoyinTaskProjection)
  const taskProjectionRef = useRef<XiaoyinTaskProjection>(taskProjection)
  const [localDirectories, setLocalDirectories] = useState<AuthorizedLocalDirectory[]>([])
  const [pendingAttachments, setPendingAttachments] = useState<LocalTaskAttachment[]>([])
  const attachmentImportRef = useRef(false)
  const attachmentViewRef = useRef({ pendingAttachments, localDirectories, page })
  attachmentViewRef.current = { pendingAttachments, localDirectories, page }
  const [localFileError, setLocalFileError] = useState('')
  const [draftSaveError, setDraftSaveError] = useState('')
  const [draftStateStatus, setDraftStateStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const draftRevisionRef = useRef(0)
  const draftDirtyRef = useRef(false)
  const draftStageNonceRef = useRef('')
  const draftSaveTimerRef = useRef<number | undefined>(undefined)
  const [selectedModel, setSelectedModel] = useState('')
  const [reasoningSelection, setReasoningSelection] = useState<{ model: string; effort?: ReasoningEffort }>()
  const updateRuntimePreference = <T,>(value: T, save: (value: T) => boolean, update: (value: T) => void) => {
    if (save(value)) update(value)
    else notify('运行时设置未能保存，本次未切换。请检查本机存储后重试。', 'error')
  }
  const [executionMode, setExecutionMode] = useState<'agent' | 'plan'>('agent')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [taskSearchOpen, setTaskSearchOpen] = useState(false)
  const [taskQuery, setTaskQuery] = useState('')
  const historyPages = useHistoryPages(authState === 'authenticated' ? user?.userId : undefined, taskQuery, (items) => setLocalTasks((current) => {
    const known = new Set(current.map((task) => task.id))
    return [...current, ...items.filter((task) => !known.has(task.id))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }), localTasks.map((task) => task.id))
  const [extensionQuery, setExtensionQuery] = useState('')
  const [extensionFilter, setExtensionFilter] = useState<ExtensionFilter>('market')
  const [extensionCategory, setExtensionCategory] = useState<ExtensionCategoryFilter>('all')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const taskSearchInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const streamingTasksRef = useRef(new Map<string, StreamingTaskState>())
  const currentLocalTaskIdRef = useRef('')
  const creationDraftKeyRef = useRef('')
  const taskContextRestoreIdRef = useRef(0)
  const enabledConnectorIdsRef = useRef<string[]>([])
  const runtimeConnectors = useMemo(() => buildRuntimeConnectorCatalog(
    connectors, enabledConnectorIds, connectorSecrets,
  ), [connectorSecrets, connectors, enabledConnectorIds])
  const activeModel = resolveSelectedModel(bootstrap?.models ?? [], selectedModel)
  const activeReasoningEffort = resolveReasoningEffort(activeModel, reasoningSelection?.model === activeModel
    ? reasoningSelection.effort : loadReasoningEffort(user?.userId ?? '', activeModel))
  const localImContext = useMemo(() => bootstrap && user ? {
    employeeId: user.userId,
    teamId: user.teamId,
    litellmBaseUrl: bootstrap.endpoints.litellm,
    knowledgeEndpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge),
    scheduleEndpoint: localScheduleNamespace(),
    capabilitySnapshot: resolveCapabilitySnapshot({
      expertKits,
      skills: skillViews,
      selections: [],
      connectors: runtimeConnectors,
      selectedConnectorIds: runtimeConnectors.filter((connector) => connector.enabled && connector.status === 'ready').map((connector) => connector.id),
      createdAt: 'im-channel-runtime',
    }),
    model: activeModel,
    modelApiKey: bootstrap.modelApiKey,
    sessionToken,
    allowShell,
    allowLsp,
    allowExternalAgents,
    allowHooks,
  } : undefined, [sessionToken, activeModel, allowExternalAgents, allowHooks, allowLsp, allowShell, bootstrap, expertKits, runtimeConnectors, skillViews, user])
  const selectCurrentLocalTaskId = (id: string) => {
    currentLocalTaskIdRef.current = id
    setCurrentLocalTaskId(id)
  }
  const taskStartLocks = useRef(new Set<string>())
  const currentTaskRunning = Boolean(currentLocalTaskId && runningTaskIds.includes(currentLocalTaskId))
  const taskQueue = useTaskQueue({
    owner: user?.userId, ready: authState === 'authenticated' && runtimeStatus === 'ready' && harnessOperational,
    tasks: localTasks, runningIds: runningTaskIds, run: runQueued,
  })
  const localSchedules = useLocalSchedules(user ? `${user.userId}:${localScheduleNamespace()}` : undefined,
    connectorDiagnosticsAvailable() && authState === 'authenticated' && runtimeStatus === 'ready' && harnessOperational && runningTaskIds.length < AUTOMATIC_TASK_LIMIT,
    async (schedule, taskId, scheduleRunId) => {
      if (schedule.model && !bootstrap?.models.includes(schedule.model)) return { notStarted: '计划指定的模型已不可用，请编辑计划重新选择模型；计划已暂停' }
      const directories = [...schedule.directories, ...(schedule.attachments ?? []).flatMap((file) => file.rootPath ? [{ id: file.rootId, name: file.rootName, path: file.rootPath }] : [])]
        .filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index)
      const now = new Date().toISOString()
      const task: LocalTaskRun = { id: taskId, source: 'DESKTOP', name: schedule.name, status: 'COMPLETED', createdAt: now, updatedAt: now,
        scheduleId: schedule.id, scheduleRunId,
        ...schedule.taskContext, localDirectories: directories, model: schedule.model || activeModel, entries: [], projection: createXiaoyinTaskProjection(now) }
      let started = false
      try {
        return await executeTask(schedule.prompt, schedule.attachments ?? [], task, async () => { started = true }) ?? { notStarted: '本轮未启动，请检查工作目录、模型和能力配置后再执行；计划已暂停' }
      } catch (error) {
        if (!started) return { notStarted: `本轮未启动：${error instanceof Error ? error.message : String(error)}` }
        throw error
      }
    })
  useLocalScheduleTools(user ? `${user.userId}:${localScheduleNamespace()}` : undefined, localSchedules, localTasks, runningTaskIds)
  useLocalSkillTools(authState === 'authenticated' && user && bootstrap ? `${user.userId}:${localScheduleNamespace()}` : undefined, {
    skills: skillViews, employeeId: user?.userId ?? '', endpoint: bootstrap?.endpoints.skills ?? '', sessionToken,
    refresh: () => refreshInstalledKits(),
  }, localTasks, runningTaskIds)
  const dragActive = useDesktopDrop({
    enabled: authState === 'authenticated' && page === 'chat' && connectorDiagnosticsAvailable(),
    running: currentTaskRunning || taskContextRestoring || pastingAttachments,
    onPaths: (paths) => importTaskAttachments(() => authorizeDroppedPaths(paths)),
    onError: setLocalFileError,
  })
  const sendDeviceHeartbeat = useDeviceHeartbeat({
    sessionToken,
    authenticated: authState === 'authenticated',
    bootstrap,
    employeeId: user?.userId,
    expertKits: expertKitCatalog,
    harnessHealth,
    harnessCapabilities: harnessHostHealth?.capabilities,
    runtimeReady: runtimeStatus === 'ready',
    skills,
  })
  useLocalImSync({
    context: localImContext,
    currentTaskId: currentLocalTaskId,
    employeeId: user?.userId,
    enabled: authState === 'authenticated',
    tasks: localTasks,
    onSyncError: (message) => notify(message, 'error'),
    onTasksChanged: setLocalTasks,
    onCurrentTaskChanged: (task) => {
      setEntries(task.entries)
      setHarnessSessionId(task.sessionId ?? '')
      taskProjectionRef.current = task.projection
      setTaskProjection(task.projection)
    },
  })
  useHarnessNotifications({
    currentTaskIdRef: currentLocalTaskIdRef,
    streamingTasksRef,
    onCapabilityNotice: (taskId, notice) => {
      if (!user) return
      void persistCapabilityNotice(user.userId, taskId, notice).catch((reason) => {
        notify(`能力告警未保存：${reason instanceof Error ? reason.message : String(reason)}`, 'error')
      })
    },
    onTaskUpdate: (taskId, projection, taskEntries) => setLocalTasks((current) => current.map((task) => task.id === taskId
      ? { ...task, updatedAt: projection.updatedAt, projection, entries: taskEntries }
      : task)),
    onCurrentUpdate: (projection, taskEntries) => {
      taskProjectionRef.current = projection
      setTaskProjection(projection)
      if (taskEntries) setEntries(taskEntries)
    },
  })
  useTaskCheckpoints(user?.userId, localTasks, () => {}, (_owner, task) => taskPersistence.save(task))

  useEffect(() => {
    if (!['skills', 'connectors'].includes(page)) return
    setExtensionQuery('')
    setExtensionFilter('market')
    setExtensionCategory('all')
  }, [page])

  useEffect(() => {
    if (!configurationError) return
    setLocalFileError(configurationError)
    return () => { setLocalFileError((current) => current === configurationError ? '' : current) }
  }, [configurationError])

  useEffect(() => {
    if (!bootstrap || !user) return
    setSelectedModel(resolveSelectedModel(
      bootstrap.models,
      loadSelectedModel(user.userId),
    ))
  }, [bootstrap, user])

  useEffect(() => {
    if (!user) {
      enabledConnectorIdsRef.current = []
      setEnabledConnectorIds([])
      setConnectorSecrets({})
      return
    }
    let disposed = false
    const enabled = loadEnabledConnectorIds(user.userId)
    enabledConnectorIdsRef.current = enabled
    setEnabledConnectorIds(enabled)
    void loadConnectorSecrets(user.userId)
      .then((value) => { if (!disposed) setConnectorSecrets(value) })
      .catch((reason) => { if (!disposed) setLocalFileError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true }
  }, [user])

  useEffect(() => {
    if (authState !== 'authenticated' || !user) {
      historyOwnerRef.current = ''
      setLocalTasks([])
      selectCurrentLocalTaskId('')
      return
    }
    if (historyOwnerRef.current !== user.userId) { historyOwnerRef.current = user.userId; setLocalTasks([]) }
    let disposed = false
    void loadTaskHistory(user.userId)
      .then(({ tasks }) => { if (!disposed) {
        setLocalTasks((current) => {
          const known = new Set(current.map((task) => task.id))
          return [...current, ...tasks.filter((task) => !known.has(task.id))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        })
      } })
      .catch((reason) => { if (!disposed) setLocalFileError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true }
  }, [authState, user])

  useEffect(() => {
    if (!taskSearchOpen) return
    taskSearchInputRef.current?.focus()
  }, [taskSearchOpen])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !document.querySelector('[role="dialog"]')) {
        event.preventDefault()
        void newTask()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSidebarCollapsed(false)
        setTaskSearchOpen(true)
      }
      if (event.key === 'Escape') {
        setTaskSearchOpen(false)
        setModelMenuOpen(false)
      }
    }
    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  })

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [page, activeExpertKitId])

  const visibleExpertKits = useMemo(
    () => expertKits.filter((item) => extensionMatches(item, extensionQuery, extensionFilter, extensionCategory)),
    [expertKits, extensionCategory, extensionFilter, extensionQuery],
  )
  const visibleSkillViews = useMemo(
    () => skillViews.filter((item) => extensionMatches(item, extensionQuery, extensionFilter, extensionCategory)),
    [extensionCategory, extensionFilter, extensionQuery, skillViews],
  )

  useEffect(() => {
    if (authState !== 'authenticated' || !user) { draftOwnerRef.current = ''; draftPausedRef.current = true; setDraftStateStatus('loading'); return }
    draftOwnerRef.current = user.userId
    draftPausedRef.current = true
    setDraftStateStatus('loading')
    creationDraftKeyRef.current = ''
    setCreationKind(undefined)
    let disposed = false
    void initializeDraftState(user.userId, () => !disposed)
    return () => { disposed = true }
  }, [authState, user?.userId])
  useLayoutEffect(() => {
    if (draftStateStatus !== 'ready' || !user || draftOwnerRef.current !== user.userId || draftPausedRef.current) return
    const revision = ++draftRevisionRef.current
    draftDirtyRef.current = true
    try {
      draftStageNonceRef.current = stageTaskDraft(user.userId, currentLocalTaskId || creationDraftKeyRef.current,
        { prompt, attachments: pendingAttachments, directories: localDirectories, knowledgeRefs: selectedKnowledgeBaseRefs, connectorIds: selectedTaskConnectorIds, model: activeModel, reasoningEffort: activeReasoningEffort, executionMode, updatedAt: Date.now() })
    } catch {
      draftStageNonceRef.current = ''
      setDraftSaveError('草稿尚未暂存，请检查本机存储空间。认证失效或关闭应用前请重试保存。')
    }
    draftSaveTimerRef.current = window.setTimeout(() => {
      if (draftRevisionRef.current === revision) void saveCurrentDraft()
    }, 250)
    return () => window.clearTimeout(draftSaveTimerRef.current)
  }, [user?.userId, currentLocalTaskId, prompt, pendingAttachments, localDirectories, selectedKnowledgeBaseRefs, selectedTaskConnectorIds, activeModel, activeReasoningEffort, executionMode, taskContextRestoring, draftStateStatus])
  useEffect(() => { setDraftSaveError('') }, [user?.userId])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!draftSaveError && !draftDirtyRef.current) return
      event.preventDefault(); event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draftSaveError])

  if (authState !== 'authenticated') {
    return <DingTalkAuthScreen authorizing={authorizing} checking={authState === 'checking'} error={authError} onReopen={() => void reopen()} />
  }

  const activeExpertKit = expertKits.find((kit) => kit.id === activeExpertKitId)
  const activeSkill = skillViews.find((skill) => skill.id === activeSkillId)
  const toggleConnector = (connectorId: string, enabled: boolean) => {
    if (!user) return
    setEnabledConnectorIds((current) => {
      const next = saveEnabledConnectorIds(
        user.userId,
        enabled ? [...current, connectorId] : current.filter((id) => id !== connectorId),
      )
      enabledConnectorIdsRef.current = next
      return next
    })
    setCurrentCapabilitySnapshot(undefined)
    setHarnessSessionId('')
  }
  const persistPersonalConnector = async (connector: ConnectorCatalogEntry, importing = false) => {
    if (!user) throw new Error('请先登录')
    const existing = loadPersonalConnectors(user.userId).some((item) => item.id === connector.id)
    if (importing && (existing || connectors.some((item) => item.id === connector.id))) throw new Error('该连接器已存在，请使用编辑配置或更换名称 / ID')
    if (!existing && connectors.some((item) => item.id === connector.id)) throw new Error('该 ID 已被企业或内置连接器使用，请更换 ID')
    const template = connectorSecretTemplate({ ...connector, managed: false, scope: 'PERSONAL' })
    const previous = runtimeConnectors.find(item => item.id === connector.id)
    if (previous?.authMode === 'oauth' && (previous.url !== connector.url || connector.authMode !== 'oauth')) {
      await connectorAuthorization(user.userId, previous, 'disconnect')
    }
    setConnectorSecrets(await saveConnectorSecrets(user.userId, connector.id, connectorSecretValues(connector)))
    savePersonalConnector(user.userId, template)
    replaceConnectors((current) => [template, ...current.filter((item) => item.id !== connector.id)])
    if (!existing) toggleConnector(connector.id, connector.authMode !== 'oauth')
    setCurrentCapabilitySnapshot(undefined)
    setHarnessSessionId('')
  }

  const removePersonalConnector = async (id: string) => {
    if (!user) throw new Error('请先登录')
    const connector = runtimeConnectors.find(item => item.id === id)
    if (connector?.authMode === 'oauth') await connectorAuthorization(user.userId, connector, 'disconnect')
    setConnectorSecrets(await deleteConnectorSecrets(user.userId, id))
    deletePersonalConnector(user.userId, id)
    replaceConnectors((current) => current.filter((item) => item.id !== id))
    toggleConnector(id, false)
  }

  const visibleLocalTasks = taskQuery.trim()
    ? localTasks.filter((task) => {
      const query = taskQuery.trim().toLocaleLowerCase()
      return historyPages.ids.includes(task.id) || task.name.toLocaleLowerCase().includes(query)
        || task.messagePreview?.toLocaleLowerCase().includes(query)
    })
    : localTasks
  const focusComposer = () => window.requestAnimationFrame(() => composerRef.current?.focus())
  const startNewTask = async (initialPrompt = '', nextCreationKind?: 'skill' | 'expert-kit', draftKind?: XiaoyinCreationKind) => {
    if (draftStateStatus !== 'ready') {
      setActiveExpertKitId('')
      setActiveSkillId('')
      setPage('chat')
      notify(draftStateStatus === 'failed' ? '本机草稿读取失败，请点击重新读取后再创建任务。' : '正在读取本机草稿，请稍候再创建任务。', 'error')
      return
    }
    if (!await saveCurrentDraft()) return
    creationDraftKeyRef.current = draftKind ? `creation:${draftKind}` : ''
    const saved = user ? readTaskDraft(user.userId, creationDraftKeyRef.current) : undefined
    setActiveExpertKitId('')
    setActiveSkillId('')
    taskContextRestoreIdRef.current += 1
    setTaskContextRestoring(false)
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setEntries([])
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
    setSelectedKnowledgeBaseRefs([])
    selectCurrentLocalTaskId('')
    setCreationKind(nextCreationKind)
    setPendingAttachments([])
    const projection = createXiaoyinTaskProjection()
    taskProjectionRef.current = projection
    setTaskProjection(projection)
    setLocalDirectories([])
    setLocalFileError('')
    focusComposer()
    // A fresh task always starts in Agent mode; historical tasks retain their saved mode.
    let draft = saved ? { ...saved, executionMode: 'agent' as const } : undefined
    if (initialPrompt && (!draftKind || !saved?.prompt.trim())) {
      const initial = splitComposerPrompt(initialPrompt)
      const existing = splitComposerPrompt(saved?.prompt ?? '').text
      const nextPrompt = initial.tokens.length ? joinComposerPrompt(initial.tokens, initial.text || existing) : [initialPrompt, existing].filter(Boolean).join('\n\n')
      draft = { ...emptyDraft(), ...saved, executionMode: 'agent', prompt: nextPrompt }
    }
    await restoreDraftContext(draft)
  }
  const newTask = () => startNewTask()
  const createWithXiaoyin = (kind: XiaoyinCreationKind) => startNewTask(
    creationPrompt(kind), kind === 'schedule' ? undefined : kind, kind,
  )
  const persistLocalTask = (task: LocalTaskRun) => {
    if (!user) return
    setLocalTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
    void taskPersistence.save(task).catch(() => undefined)
  }
  const openLocalTask = async (task: LocalTaskRun): Promise<void> => {
    const request = ++storedTaskOpenRef.current
    const generation = taskContextRestoreIdRef.current
    const owner = user?.userId
    const stillCurrent = () => storedTaskOpenRef.current === request && taskContextRestoreIdRef.current === generation
      && historyOwnerRef.current === owner
    let selectedTask = task
    // Durable transcripts live in Harness Persistence; hydrate stripped local indexes on demand.
    if (user && task.sessionId && task.entries.length === 0 && !streamingTasksRef.current.has(task.id)) {
      try {
        const hydrated = await loadTaskById(user.userId, task.id)
        if (!stillCurrent()) return
        if (!hydrated) { notify('该任务记录不可用，可能已删除。当前会话未切换。', 'error'); return }
        selectedTask = hydrated
        setLocalTasks((current) => current.map((item) => item.id === hydrated.id ? hydrated : item))
      } catch (reason) {
        if (stillCurrent()) notify(`读取任务详情失败：${reason instanceof Error ? reason.message : String(reason)}。当前会话未切换。`, 'error')
        return
      }
    }
    if (!stillCurrent()) return
    if (!await saveCurrentDraft()) return
    const streaming = streamingTasksRef.current.get(selectedTask.id)
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setEntries(streaming?.entries ?? reconcileTaskConversation(selectedTask.entries, selectedTask.projection.status, selectedTask.projection.completedAt))
    selectCurrentLocalTaskId(selectedTask.id)
    setCreationKind(undefined)
    setCurrentCapabilitySnapshot(selectedTask.capabilitySnapshot)
    taskProjectionRef.current = streaming?.projection ?? selectedTask.projection
    setTaskProjection(streaming?.projection ?? selectedTask.projection)
    const draft = user ? readTaskDraft(user.userId, selectedTask.id) : undefined
    setHarnessSessionId(restoredTaskSessionId(selectedTask, draft))
    const openedAt = new Date().toISOString()
    const openedTask = { ...selectedTask, lastOpenedAt: openedAt }
    // Later completion/failure snapshots are based on the in-memory turn.
    // Keep its read marker so opening a running task does not resurrect the
    // unread dot when that turn settles.
    if (streaming?.task) streaming.task.lastOpenedAt = openedAt
    persistLocalTask(openedTask)
    void restoreDraftContext(draft ?? { ...emptyDraft(), prompt: joinComposerPrompt(selectedTask.invocationTokens ?? [], ''), directories: selectedTask.localDirectories ?? [], knowledgeRefs: selectedTask.capabilitySnapshot?.knowledgeBaseRefs ?? [], connectorIds: selectedTask.capabilitySnapshot?.connectors.map((connector) => connector.id) ?? [], model: selectedTask.model ?? activeModel, reasoningEffort: selectedTask.reasoningEffort, executionMode: selectedTask.executionMode ?? 'agent' })
    focusComposer()
  }
  async function openStoredTask(id: string) {
    const existing = localTasks.find((task) => task.id === id)
    if (existing) { openLocalTask(existing); return }
    if (!user) return
    const request = ++storedTaskOpenRef.current
    const generation = taskContextRestoreIdRef.current
    const originPage = attachmentViewRef.current.page
    const stillCurrent = () => storedTaskOpenRef.current === request && historyOwnerRef.current === user.userId
      && taskContextRestoreIdRef.current === generation && attachmentViewRef.current.page === originPage
    try {
      const task = await loadTaskById(user.userId, id)
      if (!stillCurrent()) return
      if (!task) { notify('该任务记录不可用，可能已删除或执行尚未开始。', 'error'); return }
      setLocalTasks((current) => current.some((item) => item.id === task.id) ? current : [...current, task])
      openLocalTask(task)
    } catch (reason) { if (stillCurrent()) notify(`读取任务失败：${String(reason)}`, 'error') }
  }
  function emptyDraft(): TaskDraft { return { prompt: '', attachments: [], directories: [], knowledgeRefs: [], connectorIds: [], model: activeModel, reasoningEffort: activeReasoningEffort, executionMode: 'agent', updatedAt: Date.now() } }
  async function initializeDraftState(owner: string, stillMounted: () => boolean = () => true) {
    setDraftStateStatus('loading')
    try {
      await loadTaskDraftState(owner)
      if (!stillMounted() || draftOwnerRef.current !== owner) return
      setRecentDirectories(recentWorkDirectories(owner))
      await restoreDraftContext(readTaskDraft(owner, ''))
      if (!stillMounted() || draftOwnerRef.current !== owner) return
      setDraftSaveError('')
      setDraftStateStatus('ready')
    } catch (reason) {
      if (!stillMounted() || draftOwnerRef.current !== owner) return
      draftPausedRef.current = true
      setDraftSaveError(`草稿加载失败：${reason instanceof Error ? reason.message : String(reason)}`)
      setDraftStateStatus('failed')
    }
  }
  async function saveCurrentDraft() {
    if (draftStateStatus !== 'ready') return false
    if (!user || draftOwnerRef.current !== user.userId || draftPausedRef.current) return true
    window.clearTimeout(draftSaveTimerRef.current)
    const revision = draftRevisionRef.current
    const nonce = draftStageNonceRef.current
    const draftId = currentLocalTaskId || creationDraftKeyRef.current
    try {
      await saveTaskDraft(user.userId, draftId, { prompt, attachments: pendingAttachments, directories: localDirectories, knowledgeRefs: selectedKnowledgeBaseRefs, connectorIds: selectedTaskConnectorIds, model: activeModel, reasoningEffort: activeReasoningEffort, executionMode, updatedAt: Date.now() })
      if (nonce) clearStagedTaskDraft(user.userId, draftId, nonce)
      if (revision !== draftRevisionRef.current) return false
      draftDirtyRef.current = false
      setDraftSaveError('')
      return true
    }
    catch { setDraftSaveError('草稿保存失败，请检查本机存储空间。当前输入已保留；保存成功前不能切换到其他对话。'); return false }
  }
  async function restoreDraftContext(saved?: TaskDraft) {
    const generation = ++taskContextRestoreIdRef.current
    draftPausedRef.current = true
    const draft = saved ?? emptyDraft()
    setPrompt(draft.prompt); setPendingAttachments(draft.attachments); setLocalDirectories(draft.directories)
    setSelectedKnowledgeBaseRefs(draft.knowledgeRefs); setSelectedTaskConnectorIds(draft.connectorIds)
    setExecutionMode(draft.executionMode ?? 'agent')
    setSelectedModel(bootstrap ? resolveSelectedModel(bootstrap.models, draft.model) : draft.model)
    setReasoningSelection({ model: draft.model, effort: draft.reasoningEffort ?? loadReasoningEffort(user?.userId ?? '', draft.model) })
    setTaskContextRestoring(true); setLocalFileError('')
    try {
      await clearLocalDirectories()
      if (generation !== taskContextRestoreIdRef.current) return
      const paths = draftRootPaths(draft)
      const restored = await restoreLocalDirectories(paths)
      if (generation !== taskContextRestoreIdRef.current) return
      if (restored.length < paths.length) setLocalFileError('部分草稿附件或目录已移动，请移除失效项后重新添加。草稿文字已保留。')
    } catch (reason) {
      if (generation === taskContextRestoreIdRef.current) setLocalFileError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation === taskContextRestoreIdRef.current) { draftPausedRef.current = false; setTaskContextRestoring(false) }
    }
  }
  const addLocalDirectory = async (path?: string) => {
    const generation = taskContextRestoreIdRef.current
    setLocalFileError('')
    try {
      const authorization = path ? (await restoreLocalDirectories([path]))[0] : await authorizeLocalDirectory()
      if (generation !== taskContextRestoreIdRef.current) return
      if (path && !authorization) throw new Error('该目录已移动或不可用，请重新选择。')
      if (!authorization) return
      setLocalDirectories((current) => current.some((item) => item.id === authorization.id)
        ? current
        : [...current, authorization])
      setHarnessSessionId('')
      if (user) { await rememberWorkDirectory(user.userId, authorization); setRecentDirectories(recentWorkDirectories(user.userId)) }
    } catch (error) {
      setLocalFileError(error instanceof Error ? error.message : String(error))
    }
  }
  const importTaskAttachments = async (load: () => Promise<(DroppedPathAuthorization & { error?: string }) | null>, showProgress = true): Promise<boolean> => {
    if (attachmentImportRef.current || currentTaskRunning || taskContextRestoring) {
      setLocalFileError('请等待当前处理完成后，再添加附件。')
      return true
    }
    attachmentImportRef.current = true
    const generation = taskContextRestoreIdRef.current
    const current = () => generation === taskContextRestoreIdRef.current && attachmentViewRef.current.page === 'chat'
    setLocalFileError('')
    if (showProgress) setPastingAttachments(true)
    try {
      const value = await load()
      if (!current()) return true
      if (!value) return false
      const merged = [...new Map([...attachmentViewRef.current.pendingAttachments, ...value.attachments].map((item) => [item.id, item])).values()]
      const error = attachmentSelectionError(merged)
      if (error) { setLocalFileError(error); return true }
      if (value.error) setLocalFileError(value.error)
      const addedFiles = value.attachments.some((item) => !attachmentViewRef.current.pendingAttachments.some((existing) => existing.id === item.id))
      const addedDirectories = value.directories.some((item) => !attachmentViewRef.current.localDirectories.some((existing) => existing.id === item.id))
      if (!addedFiles && !addedDirectories) return true
      attachmentViewRef.current.pendingAttachments = merged
      setPendingAttachments(merged)
      setLocalDirectories((directories) => [...new Map([...directories, ...value.directories].map((item) => [item.id, item])).values()])
      setHarnessSessionId('')
      focusComposer()
      return true
    } catch (reason) {
      if (current()) setLocalFileError(reason instanceof Error ? reason.message : String(reason))
      return true
    } finally {
      attachmentImportRef.current = false
      setPastingAttachments(false)
    }
  }
  const addLocalFiles = () => importTaskAttachments(authorizeLocalFiles)
  const pasteFiles = (files: File[]) => importTaskAttachments(async () => {
    const generation = taskContextRestoreIdRef.current
    const paths = await clipboardFilePaths()
    if (generation !== taskContextRestoreIdRef.current) return null
    if (paths.length) { setPastingAttachments(true); return authorizeDroppedPaths(paths) }
    if (!files.length) return null
    if (files.length > 16) throw new Error('每次任务最多添加 16 个附件。')
    setPastingAttachments(true)
    const result: DroppedPathAuthorization & { error?: string } = { directories: [], attachments: [] }
    const errors: string[] = []
    for (const file of files) {
      if (generation !== taskContextRestoreIdRef.current) return null
      try {
        const value = await importPastedFile(file)
        result.directories.push(...value.directories); result.attachments.push(...value.attachments)
      } catch (reason) { errors.push(`${file.name}：${reason instanceof Error ? reason.message : String(reason)}`) }
    }
    if (errors.length) result.error = errors.join('；')
    return result
  }, false)
  const removeLocalDirectory = async (id: string) => {
    setLocalFileError('')
    try {
      await revokeLocalDirectory(id)
      setLocalDirectories((current) => current.filter((item) => item.id !== id))
      setPendingAttachments((current) => current.filter((item) => item.rootId !== id))
      setHarnessSessionId('')
    } catch (error) {
      setLocalFileError(error instanceof Error ? error.message : String(error))
    }
  }
  const addKnowledgeContext = (reference: string) => {
    setSelectedKnowledgeBaseRefs((current) => current.includes(reference) ? current : [...current, reference])
    setCurrentCapabilitySnapshot(undefined)
    setHarnessSessionId('')
    focusComposer()
  }
  const removeKnowledgeContext = (reference: string) => {
    setSelectedKnowledgeBaseRefs((current) => current.filter((item) => item !== reference))
    setCurrentCapabilitySnapshot(undefined)
    setHarnessSessionId('')
  }
  const logoutWithCleanup = async () => {
    if (!await saveCurrentDraft()) return
    await clearLocalDirectories()
    await Promise.all([shutdownHarness(), stopLocalImRuntime()])
    setLocalDirectories([])
    await logout()
  }

  const submitDesktopFeedback = async (message: string, category: 'BUG' | 'SUGGESTION' | 'QUESTION' | 'OTHER', images?: File[]) => {
    if (!bootstrap || !user) throw new Error('企业服务尚未连接')
    const device = await inspectDeviceHeartbeatContext().catch(() => undefined)
    await submitFeedback(user.userId, sessionToken, message, {
      category,
      desktopVersion: device?.desktopVersion,
      deviceId: device?.deviceId,
      taskId: currentLocalTaskIdRef.current || undefined,
    }, images)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (attachmentImportRef.current || pastingAttachments || taskContextRestoring) return
    if (currentTaskRunning) {
      const supplementalText = splitComposerPrompt(prompt).text.trim()
      if (!supplementalText) return
      if (pendingAttachments.length) { setLocalFileError('插话暂支持文字，请在当前轮完成后添加附件。'); return }
      const open = streamingTasksRef.current.get(currentLocalTaskId)?.entries.at(-1)
      const pendingQuestion = open?.role === 'assistant' && open.status === 'streaming'
        ? open.segments.findLast((segment) => segment.kind === 'question' && segment.status === 'running')
        : undefined
      if (pendingQuestion?.kind === 'question') {
        if (pendingQuestion.questions.length !== 1) { setLocalFileError('请在上方逐项回答问题。'); return }
        try {
          const accepted = await respondHarnessQuestion(currentLocalTaskId, pendingQuestion.questionId,
            [{ id: pendingQuestion.questions[0]!.id, selected: [], custom: supplementalText }])
          if (!accepted) throw new Error('问题已失效，请等待当前任务结束后重发。')
          setPrompt(''); setLocalFileError('')
        } catch (reason) { setLocalFileError(reason instanceof Error ? reason.message : String(reason)) }
        return
      }
      // Steering is the live path; when the turn cannot take it (it just ended,
      // or the runtime is unavailable) the message queues for the next turn
      // instead of being lost.
      if (await steerRunningTask(prompt) || await taskQueue.enqueue(currentLocalTaskId, prompt)) setPrompt('')
      return
    }
    const currentQueue = taskQueue.queues[currentLocalTaskId]
    if (currentQueue?.items.length && !currentQueue.paused) {
      if (!splitComposerPrompt(prompt).text.trim()) return
      if (pendingAttachments.length) { setLocalFileError('排队暂支持文字，请在当前轮完成后添加附件。'); return }
      if (await taskQueue.enqueue(currentLocalTaskId, prompt)) setPrompt('')
      return
    }
    await executeTask(prompt, pendingAttachments)
  }

  /**
   * Inject one message into the running turn. A turn that ends between the
   * check and the write is a normal race: the caller queues the message.
   */
  const steerRunningTask = async (text: string): Promise<boolean> => {
    const taskId = currentLocalTaskId
    if (!taskId) return false
    try {
      if (!await steerHarness(taskId, text)) return false
      const streaming = streamingTasksRef.current.get(taskId)
      const steerTurn: ConversationEntry = { id: `steer-${crypto.randomUUID()}`, role: 'user', text, source: 'steer' }
      if (streaming) {
        streaming.entries = appendSteerToOpenTurn(streaming.entries, steerTurn)
        if (currentLocalTaskIdRef.current === taskId) setEntries(streaming.entries)
      }
      return true
    } catch { return false }
  }

  async function runQueued(task: LocalTaskRun, item: QueuedPrompt, accepted: () => Promise<void>) {
    if (!bootstrap || !user || runtimeStatus !== 'ready') return 'blocked' as const
    try { return await executeTask(item.text, [], task, accepted, item.id) === true ? 'completed' as const : 'failed' as const }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason), 'error'); return 'blocked' as const }
  }

  async function executeTask(rawInput: string, messageAttachments: LocalTaskAttachment[], queuedTask?: LocalTaskRun, accepted?: () => Promise<void>, queuedItemId?: string, forcedSessionId?: string): Promise<boolean | 'canceled' | undefined> {
    const input = rawInput.trim() || (messageAttachments.length > 0 ? '请查看并处理这些附件。' : '')
    if (!input) return
    if (!bootstrap || !user || runtimeStatus !== 'ready') {
      const message = runtimeStatus !== 'ready' ? '企业服务正在重连，消息尚未发送，请稍后重试。' : '当前登录状态不可用，请重新登录后重试。'
      if (currentLocalTaskIdRef.current === currentLocalTaskId) setLocalFileError(message)
      else notify(message, 'error')
      return false
    }
    const contextTaskId = queuedTask?.id ?? currentLocalTaskId
    const contextGeneration = taskContextRestoreIdRef.current
    const taskId = contextTaskId || crypto.randomUUID()
    const lockKey = contextTaskId || `new-task:${contextGeneration}`
    if (taskStartLocks.current.has(lockKey) || streamingTasksRef.current.has(taskId)) {
      if ((currentLocalTaskIdRef.current === contextTaskId || currentLocalTaskIdRef.current === taskId) && contextGeneration === taskContextRestoreIdRef.current) {
        setLocalFileError('消息正在发送，请稍候。')
      }
      return
    }
    taskStartLocks.current.add(lockKey)
    const isCurrent = () => (currentLocalTaskIdRef.current === contextTaskId || (!contextTaskId && currentLocalTaskIdRef.current === taskId))
      && (Boolean(queuedTask) || contextGeneration === taskContextRestoreIdRef.current)
    const reportInputError = (message: string) => { if (isCurrent()) setLocalFileError(message); else notify(message, 'error') }
    const contextEntries = queuedTask?.entries ?? entries
    const contextProjection = queuedTask?.projection ?? taskProjectionRef.current
    const existingTask = queuedTask ?? localTasks.find((task) => task.id === contextTaskId)
    const taskModel = resolveSelectedModel(bootstrap.models, queuedTask ? queuedTask.model : activeModel)
    const taskReasoningEffort = resolveReasoningEffort(taskModel, queuedTask ? queuedTask.reasoningEffort : activeReasoningEffort)
    const taskExecutionMode = queuedTask?.executionMode ?? executionMode
    try {
      if (!taskModel) { reportInputError('当前没有可用模型，请在控制中心配置模型后重试。'); return }
      const attachmentError = attachmentSelectionError(messageAttachments)
      if (attachmentError) { reportInputError(attachmentError); return }
      const availableInvocations = extensionInvocations(expertKits, skillViews)
      const requestedTokens = queuedTask?.invocationTokens ?? splitComposerPrompt(input).tokens
      const requestedSelections = queuedTask?.capabilitySnapshot?.selections
      const invalidInvocation = (requestedSelections
        ? requestedSelections.length > 8 || requestedSelections.some((selection) => !availableInvocations.some((item) => sameCapabilitySelection(item.selection, selection)))
        : requestedTokens.length > 8 || requestedTokens.some((token) => !availableInvocations.some((item) => item.token === token)))
      if (invalidInvocation) {
        reportInputError('该技能、套件或命令尚未安装或已不可用，请输入 / 重新选择。')
        return
      }
      if (!queuedTask && taskContextRestoring) {
        setLocalFileError('正在恢复该任务的工作目录，请稍候。')
        return
      }
      const memoryCommand = !queuedTask && messageAttachments.length === 0 ? parseMemoryCommand(input) : undefined
      if (memoryCommand) {
        const existingTask = localTasks.find((task) => task.id === taskId)
        setPrompt('')
        let reply = '未更改长期记忆。'
        try {
          reply = await memoryCommands.run(memoryCommand, user.userId, bootstrap.endpoints.memoryProfile ?? '/api/v1/memory-profile', sessionToken, taskId)
        } catch (error) {
          reply = `记忆未更改：${error instanceof Error ? error.message : String(error)}`
        }
        const timestamp = new Date().toISOString()
        const projection = taskProjectionCompleted({ ...createXiaoyinTaskProjection(timestamp), operationScope: crypto.randomUUID() }, timestamp)
        const rememberedEntries: ConversationEntry[] = [...contextEntries,
          { id: `user-${crypto.randomUUID()}`, role: 'user', text: input },
          { id: `memory-${crypto.randomUUID()}`, role: 'assistant', status: 'completed', segments: [{ kind: 'text', id: 'memory:1', text: reply }],
            meta: { completedAt: timestamp } },
        ]
        persistLocalTask({ ...existingTask, id: taskId, source: existingTask?.source ?? 'DESKTOP', name: existingTask?.name ?? input.slice(0, 60),
          status: 'COMPLETED', createdAt: existingTask?.createdAt ?? timestamp, updatedAt: timestamp, projection, entries: rememberedEntries, sessionId: '' })
        if (isCurrent()) {
          selectCurrentLocalTaskId(taskId)
          setEntries(rememberedEntries)
          setHarnessSessionId('')
          taskProjectionRef.current = projection
          setTaskProjection(projection)
        }
        return
      }
      let taskDirectories = queuedTask ? await restoreLocalDirectories((queuedTask.localDirectories ?? []).flatMap((directory) => directory.path ? [directory.path] : [])) : localDirectories
      if (queuedTask && taskDirectories.length < (queuedTask.localDirectories?.length ?? 0)) { reportInputError('排队任务的工作目录不可用，请恢复原目录后继续，或移除该消息并在新任务中重新发送。'); return }
      const taskSessionId = queuedTask ? queuedTask.sessionId ?? '' : forcedSessionId ?? harnessSessionId
      let resetSessionForDirectoryChange = false
      const standardDirectories = standardLocalDirectories(input)
      if (standardDirectories.length > 0) {
        if (isCurrent()) setLocalFileError('')
        try {
          const authorizations = await authorizeStandardLocalDirectories(standardDirectories)
          const additions = authorizations.filter((next) => !taskDirectories.some((item) => item.id === next.id))
          taskDirectories = [...taskDirectories, ...additions]
          if (isCurrent()) setLocalDirectories(taskDirectories)
          if (additions.length > 0) {
            resetSessionForDirectoryChange = true
            if (isCurrent()) setHarnessSessionId('')
          }
        } catch (error) {
          reportInputError(error instanceof Error ? error.message : String(error))
          return
        }
      }
      const now = new Date().toISOString()
      const taskConnectorIds = queuedTask?.capabilitySnapshot?.connectors.map((connector) => connector.id) ?? selectedTaskConnectorIds
      if (taskConnectorIds.some((id) => !runtimeConnectors.some((item) => item.id === id && item.enabled && item.status === 'ready'))) { reportInputError('选中的连接器尚未就绪，请重新配置或从当前任务移除。'); return }
      const currentInvocations = selectedInvocations(input, availableInvocations)
      const selected = queuedTask
        ? requestedSelections
          ? requestedSelections.flatMap((selection) => availableInvocations.find((item) => sameCapabilitySelection(item.selection, selection)) ?? [])
          : []
        : currentInvocations
      const retainedSnapshot = existingTask?.capabilitySnapshot
      const choicesUnchanged = retainedSnapshot
        && sameValues(requestedTokens, existingTask.invocationTokens ?? [])
        && sameValues(taskConnectorIds, retainedSnapshot.requestedConnectorIds)
        && sameValues(selectedKnowledgeBaseRefs, retainedSnapshot.requestedKnowledgeBaseRefs)
      const baseCapabilitySnapshot = queuedTask?.capabilitySnapshot ?? (choicesUnchanged ? retainedSnapshot : resolveCapabilitySnapshot({
        expertKits,
        skills: skillViews,
        selections: selected.map((item) => item.selection),
        connectors: runtimeConnectors,
        selectedConnectorIds: taskConnectorIds,
        knowledgeBaseRefs: selectedKnowledgeBaseRefs,
        availableKnowledgeBaseRefs: knowledgeBases.map((item) => item.reference),
        createdAt: now,
      }))
      let capabilitySnapshot: import('./types').CapabilitySnapshot
      try {
        capabilitySnapshot = reconcileConnectorSnapshot(baseCapabilitySnapshot, runtimeConnectors, enabledConnectorIds)
      } catch (reason) {
        reportInputError(`任务尚未启动，连接器状态已变化：${reason instanceof Error ? reason.message : String(reason)}`)
        return
      }
      const { rootSessionId, harnessPrompt, pendingEntries, runningProjection, runningTask } = prepareTaskTurn({
        taskId, input, now, existingTask, sessionId: taskSessionId, model: taskModel, reasoningEffort: taskReasoningEffort, executionMode: taskExecutionMode,
        scheduleId: existingTask?.scheduleId, scheduleRunId: existingTask?.scheduleRunId,
        directories: taskDirectories, directoriesChanged: resetSessionForDirectoryChange,
        capabilities: capabilitySnapshot, invocations: selected, invocationTokens: queuedTask?.invocationTokens,
        entries: contextEntries, projection: contextProjection, attachments: messageAttachments, queuedItemId,
      })
      const previousSnapshot = currentCapabilitySnapshot
      // Session history is owned by the official Harness Conversation source.
      // The product shell may start before the browser bundle is available
      // (for example during a cold Tauri boot), so failure to mount it is
      // surfaced through diagnostics rather than silently creating another
      // history source.
      const streaming: StreamingTaskState = {
        phase: 'preparing',
        sessionId: rootSessionId,
        projection: runningProjection,
        projectionSeq: -1,
        projectionSeqByKey: {},
        entries: pendingEntries,
        task: runningTask,
        cancellationRequested: false,
      }
      streamingTasksRef.current.set(taskId, streaming)
      setRunningTaskIds((current) => current.includes(taskId) ? current : [...current, taskId])
      setLocalTasks((current) => [runningTask, ...current.filter((item) => item.id !== runningTask.id)]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
      if (isCurrent()) {
        setLocalFileError('')
        setCurrentCapabilitySnapshot(capabilitySnapshot)
        selectCurrentLocalTaskId(taskId)
        setHarnessSessionId(rootSessionId)
        setEntries(pendingEntries)
        taskProjectionRef.current = runningProjection
        setTaskProjection(runningProjection)
        if (!queuedTask) { setPrompt(joinComposerPrompt(selected.map((item) => item.token), '')); setPendingAttachments([]) }
      }
      const rollbackPendingStart = (message: string) => {
        window.clearTimeout(streaming.stopFallback)
        if (streamingTasksRef.current.get(taskId) === streaming) streamingTasksRef.current.delete(taskId)
        setRunningTaskIds((current) => current.filter((id) => id !== taskId))
        setLocalTasks((current) => existingTask
          ? [existingTask, ...current.filter((item) => item.id !== taskId)].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          : current.filter((item) => item.id !== taskId))
        if (isCurrent()) {
          selectCurrentLocalTaskId(contextTaskId)
          setHarnessSessionId(taskSessionId)
          setEntries(contextEntries)
          taskProjectionRef.current = contextProjection
          setTaskProjection(contextProjection)
          setCurrentCapabilitySnapshot(previousSnapshot)
          if (!queuedTask) { setPrompt(rawInput); setPendingAttachments(messageAttachments) }
        }
        reportInputError(message)
      }
      try {
        if (capabilitySnapshot.knowledgeBaseRefs.length > 0) {
          const currentBases = await loadKnowledgeBases(bootstrap.endpoints.knowledge, user.userId, user.teamId, sessionToken)
          assertKnowledgeBaseRefsAvailable(capabilitySnapshot, currentBases.map((item) => item.reference))
        }
      } catch (reason) {
        rollbackPendingStart(`任务尚未启动，知识库校验失败：${reason instanceof Error ? reason.message : String(reason)}`)
        return
      }
      try {
        await persistTaskHistory(user.userId, runningTask)
      } catch (reason) {
        rollbackPendingStart(`任务尚未启动，本地记录保存失败：${reason instanceof Error ? reason.message : String(reason)}`)
        return
      }
      try {
        await accepted?.()
      } catch (reason) {
        if (existingTask) await persistTaskHistory(user.userId, existingTask).catch(() => undefined)
        rollbackPendingStart(`任务尚未启动：${reason instanceof Error ? reason.message : String(reason)}`)
        return false
      }
      if (isCurrent()) {
        if (!queuedTask) { try { await saveTaskDraft(user.userId, contextTaskId || creationDraftKeyRef.current) } catch { /* Current task keeps the submitted content. */ } }
      }
      if (streaming.cancellationRequested) {
        const completedAt = new Date().toISOString()
        streaming.projection = taskProjectionFailed(streaming.projection, createHarnessFailure({ code: 'XY-CANCELED', category: 'unknown', title: '任务已停止', message: '本轮已停止', infrastructure: false, retryable: false }), true, completedAt)
        streaming.entries = settleOpenTurn(streaming.entries, 'canceled', completedAt, { model: taskModel, reasoningEffort: taskReasoningEffort })
        const canceledTask = { ...runningTask, status: 'CANCELED' as const, updatedAt: completedAt, projection: streaming.projection, entries: streaming.entries }
        if (currentLocalTaskIdRef.current === taskId) {
          taskProjectionRef.current = streaming.projection
          setTaskProjection(streaming.projection)
          setEntries(streaming.entries)
        }
        persistLocalTask(canceledTask)
        streamingTasksRef.current.delete(taskId)
        setRunningTaskIds((current) => current.filter((id) => id !== taskId))
        return 'canceled'
      }
      streaming.phase = 'running'
      let executionSessionId = rootSessionId
      try {
        const result = await runHarnessWithRecovery({
          operationScope: runningProjection.operationScope!,
          taskId,
          prompt: harnessPrompt,
          capabilitySnapshot: capabilitySnapshotForExecution(capabilitySnapshot, runtimeConnectors, connectorSecrets, enabledConnectorIds),
          executionMode: taskExecutionMode,
          allowShell,
          allowLsp,
          allowExternalAgents,
          allowHooks,
          employeeId: user!.userId,
          teamId: user!.teamId,
          sessionId: rootSessionId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: localScheduleNamespace(),
          model: taskModel,
          reasoningEffort: taskReasoningEffort,
          modelApiKey: bootstrap.modelApiKey,
          sessionToken,
          localFileRootIds: taskDirectories.map((directory) => directory.id),
          attachments: messageAttachments,
        }, {
          getProjection: () => streaming.projection,
          isCanceled: () => streaming.cancellationRequested,
          onRetry: (sessionId, failure) => {
            executionSessionId = sessionId
            streaming.sessionId = sessionId
            const attempt = (streaming.projection.retry?.attempt ?? 0) + 1
            const now = new Date().toISOString()
            streaming.projection = {
              ...taskProjectionRunning(streaming.projection, now),
              activity: `正在恢复执行（第 ${attempt + 1} 次尝试）`,
              retry: { attempt: attempt + 1, code: failure.code, title: failure.title, detail: failure.message.slice(0, 500) },
            }
            streaming.projectionSeq = -1
            streaming.projectionSeqByKey = {}
            // The retried turn starts from a clean assistant turn; the user
            // turn stays exactly as sent.
            streaming.entries = resetOpenTurn(streaming.entries, new Date().toISOString())
            if (currentLocalTaskIdRef.current === taskId) {
              setHarnessSessionId(sessionId)
              taskProjectionRef.current = streaming.projection
              setTaskProjection(streaming.projection)
              setEntries(streaming.entries)
            }
            persistLocalTask({ ...runningTask, sessionId, updatedAt: streaming.projection.updatedAt, projection: streaming.projection, entries: streaming.entries })
          },
        })
        if (streaming.cancellationRequested) throw createHarnessFailure({ code: 'XY-CANCELED', category: 'unknown', title: '任务已停止', message: '本轮已停止', infrastructure: false, retryable: false })
        // An interrupted turn settled with its partial receipts: keep what it
        // produced, mark it stopped, and let the employee continue.
        if (result.interrupted) throw createHarnessFailure({ code: 'XY-CANCELED', category: 'unknown', title: '任务已停止', message: '本轮已停止', infrastructure: false, retryable: false })
        // A completed official turn may legitimately end without final text
        // (for example after file edits or plan delivery).
        // The projection bridge is asynchronous. A turn can finish before its
        // last wire updates arrive, so reconcile with the durable session log.
        const inspection = await inspectHarnessSession(user!.userId, result.sessionId).catch(() => undefined)
        if (inspection?.projection && inspection.sessionId === result.sessionId) {
          streaming.projection = { ...streaming.projection, ...inspection.projection }
        }
        const completedAt = new Date().toISOString()
        streaming.projection = taskProjectionCompleted(streaming.projection, completedAt)
        const completedProjection = streaming.projection
        streaming.entries = ensureFinalText(settleOpenTurn(streaming.entries, 'completed', completedAt, {
          model: taskModel, reasoningEffort: taskReasoningEffort,
        }), result.finalResponse)
        const completedEntries = streaming.entries
        if (currentLocalTaskIdRef.current === taskId) {
          setHarnessSessionId(result.sessionId)
          taskProjectionRef.current = completedProjection
          setTaskProjection(completedProjection)
          setEntries(completedEntries)
        }
        persistLocalTask({ ...runningTask, status: 'COMPLETED', updatedAt: new Date().toISOString(),
          sessionId: result.sessionId, projection: completedProjection, entries: completedEntries })
        if (!queuedTask) void learnCompletedTask(user.userId, bootstrap.endpoints.memoryProfile ?? '/api/v1/memory-profile', sessionToken, input, taskId)
          .catch((error) => notify(`任务已完成，自动记忆未写入：${error instanceof Error ? error.message : String(error)}`, 'error'))
        void reportTaskAudit({
          sessionToken,
          employeeId: user!.userId,
          endpoint: bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events',
          outcome: 'SUCCEEDED',
          taskId,
        })
        return true
      } catch (error) {
        void taskQueue.pause(taskId)
        const failure = classifyHarnessFailure(error)
        const message = failure.message
        const canceled = streaming.cancellationRequested
        const completedAt = new Date().toISOString()
        streaming.projection = taskProjectionFailed(streaming.projection, failure, canceled, completedAt)
        const failedProjection = streaming.projection
        // The failure rides the turn's meta instead of being pasted into the
        // reply text; the transcript keeps whatever the turn produced.
        streaming.entries = settleOpenTurn(streaming.entries, canceled ? 'canceled' : 'failed', completedAt, {
          model: taskModel, reasoningEffort: taskReasoningEffort,
          ...(canceled ? {} : { failure: { kind: failure.category, message: `${failure.title}：${message}（错误编号：${failure.code}）` } }),
        })
        const failedEntries = streaming.entries
        if (currentLocalTaskIdRef.current === taskId) {
          taskProjectionRef.current = failedProjection
          setTaskProjection(failedProjection)
          setEntries(failedEntries)
        }
        persistLocalTask({ ...runningTask, status: canceled ? 'CANCELED' : 'FAILED', updatedAt: new Date().toISOString(), sessionId: executionSessionId, projection: failedProjection, entries: failedEntries })
        const infrastructureFailure = failure.infrastructure
        if (!canceled && infrastructureFailure) {
          reportInfrastructureFailure(message)
        }
        if (canceled || infrastructureFailure) await shutdownHarness(taskId).catch(() => undefined)
        void reportTaskAudit({
          sessionToken,
          employeeId: user!.userId,
          endpoint: bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events',
          outcome: canceled ? 'CANCELED' : 'FAILED',
          taskId,
        })
        return canceled ? 'canceled' : false
      } finally {
        window.clearTimeout(streaming.stopFallback)
        streamingTasksRef.current.delete(taskId)
        setRunningTaskIds((current) => current.filter((id) => id !== taskId))
      }
    } catch (error) {
      reportInputError(`消息未能发送：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally { taskStartLocks.current.delete(lockKey) }
  }

  const cancelCurrentTask = async () => {
    const taskId = currentLocalTaskIdRef.current
    const streaming = streamingTasksRef.current.get(taskId)
    if (!streaming || streaming.cancellationRequested) return
    void taskQueue.pause(taskId)
    streaming.cancellationRequested = true
    streaming.projection = { ...streaming.projection, activity: '正在停止', updatedAt: new Date().toISOString() }
    setLocalTasks((current) => current.map((task) => task.id === taskId
      ? { ...task, projection: streaming.projection, updatedAt: streaming.projection.updatedAt }
      : task))
    if (currentLocalTaskIdRef.current === taskId) {
      taskProjectionRef.current = streaming.projection
      setTaskProjection(streaming.projection)
    }
    if (streaming.phase === 'preparing') {
      const completedAt = new Date().toISOString()
      streaming.projection = taskProjectionFailed(streaming.projection, createHarnessFailure({ code: 'XY-CANCELED', category: 'unknown', title: '任务已停止', message: '本轮已停止', infrastructure: false, retryable: false }), true, completedAt)
      streaming.entries = settleOpenTurn(streaming.entries, 'canceled', completedAt)
      setRunningTaskIds((current) => current.filter((id) => id !== taskId))
      setLocalTasks((current) => current.map((task) => task.id === taskId
        ? { ...task, status: 'CANCELED', projection: streaming.projection, entries: streaming.entries, updatedAt: completedAt }
        : task))
      if (currentLocalTaskIdRef.current === taskId) {
        taskProjectionRef.current = streaming.projection
        setTaskProjection(streaming.projection)
        setEntries(streaming.entries)
      }
      return
    }
    // Do not leave the composer locked if the native cancellation command or
    // the Harness process stops responding. A late Harness event is ignored
    // after this state is removed from the live-task map.
    streaming.stopFallback = window.setTimeout(() => {
      if (streamingTasksRef.current.get(taskId) !== streaming || !streaming.cancellationRequested) return
      const completedAt = new Date().toISOString()
      streaming.projection = taskProjectionFailed(streaming.projection, createHarnessFailure({ code: 'XY-CANCELED', category: 'unknown', title: '任务已停止', message: '本轮已停止', infrastructure: false, retryable: false }), true, completedAt)
      streaming.entries = settleOpenTurn(streaming.entries, 'canceled', completedAt)
      const canceledTask = streaming.task
        ? { ...streaming.task, status: 'CANCELED' as const, updatedAt: completedAt, projection: streaming.projection, entries: streaming.entries }
        : undefined
      if (currentLocalTaskIdRef.current === taskId) {
        taskProjectionRef.current = streaming.projection
        setTaskProjection(streaming.projection)
        setEntries(streaming.entries)
      }
      if (canceledTask) persistLocalTask(canceledTask)
      void shutdownHarness(taskId).catch(() => undefined)
      streamingTasksRef.current.delete(taskId)
      setRunningTaskIds((current) => current.filter((id) => id !== taskId))
    }, 1_500)
    // Kill the isolated Harness process immediately. The run loop still settles
    // the transcript and durable task record, but the UI no longer waits for a
    // model or connector to acknowledge a graceful interrupt.
    void cancelHarness(taskId).catch((reason) => {
      if (streamingTasksRef.current.get(taskId) !== streaming) return
      streaming.cancellationRequested = false
      streaming.projection = { ...streaming.projection, activity: '停止失败，可重试', updatedAt: new Date().toISOString() }
      setLocalTasks((current) => current.map((task) => task.id === taskId
        ? { ...task, projection: streaming.projection, updatedAt: streaming.projection.updatedAt }
        : task))
      if (currentLocalTaskIdRef.current === taskId) {
        taskProjectionRef.current = streaming.projection
        setTaskProjection(streaming.projection)
        setLocalFileError(reason instanceof Error ? reason.message : String(reason))
      }
    })
  }

  /**
   * Re-run the last turn on a session forked before its prompt: the new turn
   * keeps the earlier conversation but replaces the answer being regenerated.
   */
  const regenerateLastTurn = async () => {
    const taskId = currentLocalTaskIdRef.current
    if (!taskId || currentTaskRunning) return
    const lastUserIndex = entries.findLastIndex((entry) => entry.role === 'user')
    const lastUser = entries[lastUserIndex]
    if (!lastUser || lastUser.role !== 'user' || lastUserIndex === entries.length - 1) return
    setLocalFileError('')
    const existingTask = localTasks.find((task) => task.id === taskId)
    const truncated = entries.slice(0, lastUserIndex)
    const base: LocalTaskRun = existingTask ?? {
      id: taskId, source: 'DESKTOP', name: lastUser.text.slice(0, 60), status: 'COMPLETED',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), projection: taskProjectionRef.current, entries: truncated,
    }
    let sessionId: string
    try {
      sessionId = await forkHarness(taskId)
    } catch {
      // A log cut by a crash has no balanced prefix to fork. Rebuild the
      // session and replay the earlier conversation rather than dropping the
      // regenerate action.
      sessionId = ''
    }
    setEntries(truncated)
    setHarnessSessionId(sessionId)
    try {
      await executeTask(lastUser.text, lastUser.attachments ?? [], {
        ...base, sessionId, entries: truncated, projection: taskProjectionRef.current, updatedAt: new Date().toISOString(),
      })
    } catch (reason) {
      setLocalFileError(`重新生成失败：${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }

  /** Load the most recent user turn back into the composer for editing. */
  const editLastUserTurn = () => {
    const previous = [...entries].reverse().find((entry) => entry.role === 'user')
    if (!previous) return
    setPrompt(previous.text)
    setPendingAttachments(previous.attachments ?? [])
    focusComposer()
  }

  const registerBundledConnectors = async (installed: InstalledExpertKit) => {
    if (!installed.bundledConnectors) return
    const personal = user ? loadPersonalConnectors(user.userId) : []
    const failures = await persistBundledConnectors(
      installed.bundledConnectors,
      [...connectors, ...personal].map((connector) => connector.id),
      (connector) => persistPersonalConnector(connector, true),
    )
    if (failures.length) throw new Error(failures.join('；'))
  }

  const installKit = async (kit: ExpertKitView) => {
    if (!bootstrap || !user || kit.installState !== 'available') return
    setInstallingKitId(kit.id)
    setExpertKitError('')
    try {
      const download = await createExpertKitDownload(
        bootstrap.endpoints.expertKits,
        kit.id,
        user.userId,
        sessionToken,
      )
      if (download.version !== kit.version || download.sha256 !== kit.sha256) {
        throw new Error('专家套件目录在安装期间发生变化，请刷新后重试')
      }
      const installed = await installExtension(download, 'expert-kit')
      let warning: string | undefined
      try {
        await registerBundledConnectors(installed)
      } catch (error) {
        warning = `套件已安装，连接器需要处理：${error instanceof Error ? error.message : String(error)}`
      }
      await refreshInstalledKits()
      if (warning) setExpertKitError(warning)
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setInstallingKitId('')
    }
  }

  const refreshInstalledKits = async () => {
    await refreshCatalogInstalled()
    void sendDeviceHeartbeat()
  }

  const installSkill = async (skill: SkillView) => {
    if (!bootstrap || !user || skill.installState !== 'available') return
    setInstallingSkillId(skill.id)
    setExpertKitError('')
    try {
      const download = await createSkillDownload(bootstrap.endpoints.skills, skill.id, user.userId, sessionToken)
      if (download.version !== skill.version || download.sha256 !== skill.sha256) {
        throw new Error('技能目录在安装期间发生变化，请刷新后重试')
      }
      await installExtension(download, 'skill')
      await refreshInstalledKits()
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setInstallingSkillId('')
    }
  }

  const installLocalExtension = async (kind: 'expert-kit' | 'skill', input: 'archive' | 'directory' = 'archive', path?: string) => {
    if (localExtensionInstallLock.current) throw new Error('已有扩展正在安装，请稍后重试')
    localExtensionInstallLock.current = true
    setDeveloperKitBusy(true)
    setExpertKitError('')
    try {
      const installed = await installDeveloperExtension(kind, input, path)
      if (!installed) {
        if (path) throw new Error('安装未完成，请重试')
        return
      }
      let warning: string | undefined
      if (installed.bundledConnectors) {
        try {
          await registerBundledConnectors(installed)
        } catch (error) {
          warning = `套件已安装，连接器需要处理：${error instanceof Error ? error.message : String(error)}`
          setExpertKitError(warning)
        }
      }
      await refreshInstalledKits()
      if (kind === 'expert-kit') setActiveExpertKitId(installed.manifest.id)
      else setActiveSkillId(installed.manifest.id)
      return { warning }
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
      if (path) throw error
    } finally {
      localExtensionInstallLock.current = false
      setDeveloperKitBusy(false)
    }
  }

  const customizeLocalExpertKit = async (kit: ExpertKitView | SkillView, kind: 'expert-kit' | 'skill' = 'expert-kit') => {
    try {
      const path = await customizeExpertKit(kit.id, kit.installed?.manifest.version ?? kit.version, kind)
      if (path) {
        setActiveExpertKitId('')
        setActiveSkillId('')
        const cleared = startNewTask(extensionCustomizationPrompt(kit.name, path, kind))
        const restoreId = taskContextRestoreIdRef.current
        await cleared
        if (restoreId !== taskContextRestoreIdRef.current) return
        try {
          const authorization = await authorizeDroppedPaths([path])
          if (restoreId === taskContextRestoreIdRef.current) setLocalDirectories(authorization.directories)
        } catch (error) { setLocalFileError(`副本已创建，请手动选择工作目录：${error instanceof Error ? error.message : String(error)}`) }
        notify('定制副本已创建，可以在对话中描述调整要求。')
      }
    } catch (error) { setExpertKitError(error instanceof Error ? error.message : String(error)) }
  }

  const exportLocalExpertKit = async (kit: ExpertKitView | SkillView, kind: 'expert-kit' | 'skill' = 'expert-kit') => {
    try {
      const path = await exportExpertKit(kit.id, kit.installed?.manifest.version ?? kit.version, kind)
      if (path) notify(`专家套件已导出：\n${path}`)
    } catch (error) { setExpertKitError(error instanceof Error ? error.message : String(error)) }
  }

  const removeLocalAcceptanceKit = async (kit: ExpertKitView) => {
    if (!kit.localOnly || developerKitBusy) return
    if (runningTaskIds.length > 0) {
      setExpertKitError('请等待正在运行的任务完成后再卸载专家套件。')
      return
    }
    setDeveloperKitBusy(true)
    setExpertKitError('')
    try {
      await Promise.all([shutdownHarness(), stopLocalImRuntime()])
      await removeDeveloperExpertKit(kit.id, kit.version)
      setActiveExpertKitId('')
      await refreshInstalledKits()
      if (localImContext) await startLocalIm(localImContext).catch(() => undefined)
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeveloperKitBusy(false)
    }
  }

  const removeCatalogArtifact = async (kind: 'expert-kit' | 'skill', id: string) => {
    if (removingCatalogId) return
    if (runningTaskIds.length > 0) {
      setExpertKitError('请等待正在运行的任务完成后再卸载扩展。')
      return
    }
    const label = kind === 'skill' ? '技能' : '专家套件'
    const local = (kind === 'skill' ? skillViews : expertKits).find((item) => item.id === id)?.installed
    const developerOwned = local?.source === 'developer'
    if (!await confirmAction({
      title: `卸载${label}？`,
      message: developerOwned ? '将移除当前本地创作版本，历史任务记录不会删除。' : '将移除所有本地正式版本，历史任务记录不会删除。',
      confirmLabel: '卸载',
      danger: true,
    })) return
    setRemovingCatalogId(id)
    setExpertKitError('')
    try {
      await Promise.all([shutdownHarness(), stopLocalImRuntime()])
      if (developerOwned) await removeDeveloperExtension(kind, id, local.manifest.version)
      else await removeCatalogExtension(id, kind)
      setHarnessSessionId('')
      setActiveExpertKitId('')
      setActiveSkillId('')
      await refreshInstalledKits()
      if (localImContext) await startLocalIm(localImContext).catch(() => undefined)
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemovingCatalogId('')
    }
  }

  const selectModel = (model: string) => {
    if (model !== activeModel && currentLocalTaskId) {
      // The host restarts on the new model and resumes the same session, so
      // the conversation continues instead of being replayed as text.
      void shutdownHarness(currentLocalTaskId)
    }
    setSelectedModel(model)
    setReasoningSelection({ model, effort: loadReasoningEffort(user?.userId ?? '', model) })
    setModelMenuOpen(false)
    if (user && !saveSelectedModel(user.userId, model)) notify('模型选择未能保存，本次选择仍有效；下次启动可能恢复默认模型。', 'error')
  }

  const memorySaved = async () => {
    // Memory is injected per turn, so the session keeps its history.
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {dragActive && <div className="file-drop-overlay"><FolderOpen size={34} /><strong>松开即可添加到当前任务</strong><span>文件只会在本次任务授权的目录内使用</span></div>}
      <DesktopSidebar
        channelOwner={user?.userId}
        onOpenChannel={(key) => { setImConversationKey(key); setPage('im') }}
        activeTaskId={currentLocalTaskId}
        collapsed={sidebarCollapsed}
        onCloseSearch={() => { setTaskSearchOpen(false); setTaskQuery('') }}
        onFeedback={submitDesktopFeedback}
        onLogout={logoutWithCleanup}
        onNewTask={newTask}
        onOpenTask={(task) => { setActiveExpertKitId(''); setActiveSkillId(''); openLocalTask(task) }}
        onArchiveTask={(task, archived) => {
          if (task.status === 'RUNNING') return
          if (archived) void taskQueue.pause(task.id)
          const next = { ...task, archivedAt: archived ? new Date().toISOString() : undefined, updatedAt: new Date().toISOString() }
          persistLocalTask(next)
          if (archived && currentLocalTaskIdRef.current === task.id) newTask()
        }}
        onDeleteTask={(task) => {
          if (!user || task.status === 'RUNNING') return
          void confirmAction({ title: '删除这个任务？', message: `“${task.name}”的本地对话和执行记录将被删除。`, confirmLabel: '删除', danger: true })
            .then(async (confirmed) => {
              if (!confirmed) return
              await removeTaskHistory(user.userId, task.id)
              taskPersistence.forget(task.id)
              await taskQueue.clear(task.id)
              setLocalTasks((current) => current.filter((item) => item.id !== task.id))
              if (currentLocalTaskIdRef.current === task.id) newTask()
            }).catch((reason) => setLocalFileError(reason instanceof Error ? reason.message : String(reason)))
        }}
        onRenameTask={(task, name) => {
          const normalized = name.trim().slice(0, 120)
          if (!normalized || normalized === task.name) return
          persistLocalTask({ ...task, name: normalized, updatedAt: new Date().toISOString() })
        }}
        onPage={(next) => {
          setActiveExpertKitId(''); setActiveSkillId('')
          setExtensionFilter('market'); setExtensionCategory('all'); setExtensionQuery('')
          if (next === 'packs' || next === 'skills') {
            setCapabilityKind(next === 'packs' ? 'packs' : 'skills')
            setPage('skills')
          } else setPage(next)
        }}
        onTaskQuery={setTaskQuery}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        onToggleSearch={() => { setTaskSearchOpen((value) => !value); setTaskQuery('') }}
        page={page === 'skills' && capabilityKind === 'packs' ? 'packs' : page}
        taskQuery={taskQuery}
        taskSearchInputRef={taskSearchInputRef}
        taskSearchOpen={taskSearchOpen}
        tasks={localTasks}
        user={user ?? undefined}
        visibleTasks={visibleLocalTasks}
        historyMore={historyPages.more && (Boolean(taskQuery.trim()) || localTasks.length >= 200)}
        historyBusy={historyPages.busy}
        historyError={historyPages.error}
        onLoadHistory={() => void historyPages.load()}
      />

      <main className={`workspace${(taskPersistence.failures.length || draftSaveError) && page === 'chat' ? ' with-save-warning' : ''}`} ref={workspaceRef}>
        {(taskPersistence.failures.length > 0 || draftSaveError) && <section className="task-save-warning" role="alert"><div><strong>{taskPersistence.failures.length ? `${taskPersistence.failures.length} 个任务尚未保存` : '当前草稿尚未保存'}</strong><p>当前内容仍在内存中，请勿退出应用。切换页面不会清除此提示。</p><details><summary>查看原因</summary>{draftSaveError && <p>{draftSaveError}</p>}{taskPersistence.failures.map((failure) => <p key={failure.task.id}>{failure.task.name}：{failure.detail}</p>)}</details></div><button type="button" disabled={!draftSaveError && taskPersistence.failures.every((failure) => failure.retrying)} onClick={() => { void saveCurrentDraft(); void taskPersistence.retry() }}>{!draftSaveError && taskPersistence.failures.every((failure) => failure.retrying) ? '正在保存…' : '重试保存'}</button></section>}
        {!activeExpertKit && (page === 'chat' && draftStateStatus !== 'ready' ? (
          <section className="task-context-loading" role="status">
            {draftStateStatus === 'failed' ? <><p>本机草稿暂时无法读取，原始数据未修改。</p><button type="button" onClick={() => { if (user) void initializeDraftState(user.userId) }}>重新读取</button></> : <p>正在恢复本机草稿…</p>}
          </section>
        ) : page === 'chat' ? (
          <ChatPage
            employeeId={user?.userId}
            sessionId={harnessSessionId}
            knowledgeContext={bootstrap && user ? { endpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge), employeeId: user.userId, teamId: user.teamId, sessionToken } : undefined}
            key={currentLocalTaskId || 'new-task'}
            taskId={currentLocalTaskId}
            fileChangesBusy={runningTaskIds.length > 0}
            onChangesUndone={(results) => {
              const task = localTasks.find((item) => item.id === currentLocalTaskId)
              if (!task) return
              const updatedChanges = task.projection.changes?.map((change) => ({ ...change, ...results.find((result) => result.id === change.id) }))
              const nextProjection = { ...task.projection, changes: updatedChanges ?? task.projection.changes }
              if (currentLocalTaskIdRef.current === task.id) {
                setTaskProjection(nextProjection)
                taskProjectionRef.current = nextProjection
              }
              void shutdownHarness(task.id)
              persistLocalTask({ ...task, projection: nextProjection, updatedAt: new Date().toISOString() })
            }}
            activeModel={activeModel}
            executionMode={executionMode}
            onExecutionModeChange={setExecutionMode}
            reasoningEffort={activeReasoningEffort}
            onReasoningEffortChange={(effort) => {
              setReasoningSelection({ model: activeModel, effort })
              if (user && !saveReasoningEffort(user.userId, activeModel, effort)) notify('思考强度未能保存，本次选择仍有效。', 'error')
            }}
            queue={taskQueue.queues[currentLocalTaskId]}
            queueError={taskQueue.error}
            onRemoveQueued={(id) => { void taskQueue.remove(currentLocalTaskId, id) }}
            onEditQueued={(id, text) => { void taskQueue.edit(currentLocalTaskId, id, text) }}
            onResumeQueue={() => { void taskQueue.resume(currentLocalTaskId) }}
            onPauseQueue={() => { void taskQueue.pause(currentLocalTaskId) }}
            capabilitySnapshot={currentCapabilitySnapshot}
            composerRef={composerRef}
            currentTaskRunning={currentTaskRunning}
            harnessHealth={harnessHealth}
            harnessHealthDetail={harnessHealthDetail}
            harnessRunning={currentTaskRunning}
            knowledgeBases={knowledgeBases}
            localDirectories={localDirectories}
            pendingAttachments={pendingAttachments}
            localFileError={localFileError}
            messageListRef={messageListRef}
            entries={entries}
            creationKind={creationKind}
            invocations={extensionInvocations(expertKits, skillViews)}
            composerConnectors={runtimeConnectors}
            selectedConnectorIds={selectedTaskConnectorIds}
            onToggleTaskConnector={(id) => {
              setSelectedTaskConnectorIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
              setCurrentCapabilitySnapshot(undefined); setHarnessSessionId('')
            }}
            onBrowseCapability={(kind) => {
              setPage(kind === 'connector' ? 'connectors' : kind === 'knowledge' ? 'knowledge' : 'skills')
              if (kind === 'expert-kit' || kind === 'skill') setCapabilityKind(kind === 'expert-kit' ? 'packs' : 'skills')
            }}
            recentDirectories={recentDirectories}
            sessionReferences={localTasks.filter((task) => task.id !== currentLocalTaskId && task.sessionId).map((task) => ({ sessionId: task.sessionId!, label: task.name, updatedAt: task.updatedAt }))}
            onSelectRecentDirectory={(path) => void addLocalDirectory(path)}
            onPasteFiles={pasteFiles}
            pastingAttachments={pastingAttachments}
            modelMenuOpen={modelMenuOpen}
            modelPickerRef={modelPickerRef}
            models={availableModels(bootstrap?.models ?? [])}
            onAddKnowledge={addKnowledgeContext}
            onAddLocalDirectory={() => void addLocalDirectory()}
            onAddLocalFiles={() => void addLocalFiles()}
            onApprovalDecision={async (approvalId, decision) => {
              const taskId = currentLocalTaskIdRef.current
              if (!taskId) throw new Error('当前任务不可用，请重新打开任务。')
              const accepted = await respondHarnessApproval(taskId, approvalId, decision)
              if (!accepted) throw new Error('该操作确认已失效，请重新执行任务。')
            }}
            onQuestionAnswer={async (questionId, answers) => {
              const taskId = currentLocalTaskIdRef.current
              if (!taskId) throw new Error('当前任务不可用，请重新打开任务。')
              const accepted = await respondHarnessQuestion(taskId, questionId, answers)
              if (!accepted) throw new Error('该问题已失效，请重新执行任务。')
            }}
            onCancel={() => void cancelCurrentTask()}
            onContinueCreation={(instructions) => {
              if (!creationKind) return
              setAuthoringInstructions(instructions)
              setAuthoringKind(creationKind)
            }}
            onEditTurn={editLastUserTurn}
            onRegenerateTurn={() => { void regenerateLastTurn() }}
            onPrompt={setPrompt}
            onOfficialPrompt={(value, sessionId, mode = 'queue', attachments = [], requestId) => {
              if (currentTaskRunning && mode === 'steer') {
                if (attachments.length) { setLocalFileError('运行中的任务暂不支持用附件插话，请等待当前轮完成。'); return }
                void steerRunningTask(value)
                return
              }
              if (currentTaskRunning && mode === 'queue') {
                if (attachments.length) { setLocalFileError('排队消息暂不支持附件，请等待当前轮完成。'); return }
                void taskQueue.enqueue(currentLocalTaskId, value, requestId)
                return
              }
              void executeTask(value, attachments, undefined, undefined, undefined, sessionId)
            }}
            onOfficialRename={(sessionId, title) => {
              const task = localTasks.find((item) => item.sessionId === sessionId)
              if (task) persistLocalTask({ ...task, name: title, updatedAt: new Date().toISOString() })
            }}
            onOfficialQueueUpdate={(sessionId, itemId, action) => {
              const task = localTasks.find((item) => item.sessionId === sessionId)
              if (!task) return
              if (action.kind === 'remove') void taskQueue.remove(task.id, itemId)
              else if (action.kind === 'edit') void taskQueue.edit(task.id, itemId, action.text)
              else if (action.kind === 'steer' && currentLocalTaskId === task.id) {
                const queued = taskQueue.queues[task.id]?.items.find((item) => item.id === itemId)
                if (queued) void steerRunningTask(queued.text)
              }
            }}
            onReconnect={() => setConnectionAttempt((value) => value + 1)}
            onRecoverHarness={recoverHarness}
            onRemoveKnowledge={removeKnowledgeContext}
            onRemoveLocalDirectory={(id) => void removeLocalDirectory(id)}
            onRemoveAttachment={(id) => setPendingAttachments((current) => current.filter((item) => item.id !== id))}
            onSelectModel={selectModel}
            onSubmit={(event) => void submit(event)}
            onResumeInterrupted={() => {
              if (prompt.trim() || pendingAttachments.length || currentTaskRunning || taskContextRestoring) return
              const tokens = localTasks.find((task) => task.id === currentLocalTaskId)?.invocationTokens ?? []
              void executeTask([...tokens, TASK_RESUME_PROMPT].join('\n'), [])
            }}
            onToggleModelMenu={() => setModelMenuOpen((value) => !value)}
            prompt={prompt}
            runtimeStatus={runtimeStatus}
            selectedKnowledgeBaseRefs={selectedKnowledgeBaseRefs}
            taskProjection={taskProjection}
            taskContextRestoring={taskContextRestoring}
          />
        ) : (
          <section className="capability-page" inert={Boolean(activeSkill)} key={`${page}-${capabilityKind}`}>
            {page !== 'schedules' && <div className="capability-page-heading"><div>
            <h1>{page === 'skills' ? capabilityKind === 'packs' ? '专家套件' : '技能' : extensionNav.find((item) => item.id === page)?.label ?? ({ settings: '桌面设置', schedules: '定时任务', im: 'IM 频道' } as Record<string, string>)[page]}</h1>
            <p>{page === 'skills'
                ? capabilityKind === 'packs' ? '面向岗位与行业的完整工作方案，在对话中输入 / 即可调用。' : '安装与管理技能，在对话中扩展小胤的能力。'
                  : page === 'connectors'
                    ? '连接外部应用、日历与服务，让你的工作流更顺畅。'
                  : page === 'knowledge'
                    ? '集中管理公司资料，搜索内容，并让小胤在回答中引用原文。'
                  : page === 'im'
                    ? '连接公司 IM，在私聊和群聊中交办任务，随时查看处理进度。'
                  : page === 'settings'
                    ? '管理阅读偏好、个人记忆、附件存储和本地执行权限。'
                  : '这里将由控制中心下发公司自己的能力配置。'}</p></div>{(page === 'skills' || page === 'connectors') && <ExtensionPageActions
              loading={expertKitsLoading}
              packageKind={capabilityKind === 'packs' ? 'expert-kit' : 'skill'}
              connectorIds={connectors.map((item) => item.id)}
              onCreate={() => {
                if (page === 'skills') createWithXiaoyin(capabilityKind === 'packs' ? 'expert-kit' : 'skill')
                else {
                  setEditingConnector(undefined)
                  setAuthoringInstructions('')
                  setAuthoringKind('connector')
                }
              }}
              onImportConnector={(connector) => persistPersonalConnector(connector, true)}
              onQuery={setExtensionQuery}
              onRefresh={refreshEnterpriseCatalog}
              onUpload={() => setUploadKind(capabilityKind === 'packs' ? 'expert-kit' : 'skill')}
              page={page}
              query={extensionQuery}
            />}</div>}
            {page === 'settings' && user && <DesktopSettingsPage
              sessionToken={sessionToken}
              companyName={user.companyName}
              department={user.department}
              displayName={user.displayName}
              employeeId={user.userId}
              memoryAvailable={Boolean(bootstrap)}
              memoryEndpoint={bootstrap?.endpoints.memoryProfile ?? '/api/v1/memory-profile'}
              onMemorySaved={memorySaved}
              onOpenMemoryTask={(id) => void openStoredTask(id)}
              position={user.position}
              harnessCapabilities={harnessHostHealth?.capabilities}
              harnessHealth={harnessHealth}
              harnessHealthDetail={harnessHealthDetail}
              harnessRuntime={harnessHostHealth?.runtime}
              harnessVersion={harnessHostHealth?.version}
              onCheckHarness={recoverHarness}
              onCheckModelProvider={bootstrap ? () => checkHarnessProvider({ litellmBaseUrl: bootstrap.endpoints.litellm, model: activeModel, modelApiKey: bootstrap.modelApiKey }) : undefined}
              allowShell={allowShell}
              onAllowShellChange={(value) => updateRuntimePreference(value, (next) => saveHarnessShellEnabled(runtimePreferenceOwner, next), setAllowShell)}
              allowLsp={allowLsp}
              onAllowLspChange={(value) => updateRuntimePreference(value, (next) => saveHarnessLspEnabled(runtimePreferenceOwner, next), setAllowLsp)}
              allowExternalAgents={allowExternalAgents}
              onAllowExternalAgentsChange={(value) => updateRuntimePreference(value, (next) => saveHarnessExternalAgentsEnabled(runtimePreferenceOwner, next), setAllowExternalAgents)}
              allowHooks={allowHooks}
              onAllowHooksChange={(value) => updateRuntimePreference(value, (next) => saveHarnessHooksEnabled(runtimePreferenceOwner, next), setAllowHooks)}
            />}
            {page === 'skills' && <CapabilityCatalogPage onChanged={refreshInstalledKits} onUseSkill={(id) => startNewTask(`/skill:${id} `)} kind={capabilityKind} onCreate={() => createWithXiaoyin(capabilityKind === 'packs' ? 'expert-kit' : 'skill')} category={extensionCategory} error={[enterpriseCatalogError, expertKitError].filter(Boolean).join('；')} expertKits={expertKits} filter={extensionFilter} installingKitId={installingKitId} loading={expertKitsLoading} onCategory={setExtensionCategory} onFilter={(value) => { setExtensionFilter(value); setExtensionCategory('all') }} onOpenExpertKit={setActiveExpertKitId} onOpenSkill={setActiveSkillId} skills={skillViews} visibleExpertKits={visibleExpertKits} visibleSkills={visibleSkillViews} />}
            {page === 'connectors' && <>
              <ConnectorsPage
                employeeId={user?.userId}
                catalog={connectors}
                catalogError={enterpriseCatalogError}
                loading={expertKitsLoading}
                runtime={runtimeConnectors}
                syncError={expertKitError}
                query={extensionQuery}
                onToggle={toggleConnector}
                personalIds={user ? loadPersonalConnectors(user.userId).map((item) => item.id) : []}
                onEdit={(connector) => { setEditingConnector(connector); setAuthoringKind('connector'); setAuthoringInstructions('') }}
                onDelete={async (id) => {
                  const personal = user && loadPersonalConnectors(user.userId).find((item) => item.id === id)
                  if (!personal) throw new Error('只能删除个人连接器')
                  if (!await confirmAction({ title: `删除 ${personal.name}？`, message: '将移除本机配置并关闭该连接器。之后可重新导入。', confirmLabel: '删除', danger: true })) return
                  await removePersonalConnector(id)
                  notify('个人连接器已删除')
                }}
                secrets={connectorSecrets}
                onSaveSecrets={async (connectorId, values) => {
                  if (!user) throw new Error('请先登录')
                  setConnectorSecrets(await saveConnectorSecrets(user.userId, connectorId, values))
                  setCurrentCapabilitySnapshot(undefined)
                  setHarnessSessionId('')
                }}
                onDiagnose={async (connectorId) => {
                  const connector = runtimeConnectors.find((item) => item.id === connectorId)
                  if (!connector || !connectorDiagnosticsAvailable()) return undefined
                  const [result] = await diagnoseConnectors({ employeeId: user?.userId ?? '', sessionToken, connectors: [{ ...connector, enabled: true }] })
                  return result
                }}
                onReauthorizeErp={openDingTalkLogin}
              />
            </>}
            {page === 'knowledge' && bootstrap && user && <KnowledgeBasePage key={`${user.userId}:${bootstrap.endpoints.knowledge}`}
              onChanged={refreshEnterpriseCatalog}
              sessionToken={sessionToken}
              employeeId={user.userId}
              teamId={user.teamId}
              endpoint={bootstrap.endpoints.knowledge}
            />}
            {page === 'schedules' && user && <ScheduledTasksPage
              key={user.userId}
              models={availableModels(bootstrap?.models ?? [])}
              onCreateWithXiaoyin={bootstrap ? () => createWithXiaoyin('schedule') : undefined}
              local={localSchedules}
              onOpenLocalTask={(id) => { void openStoredTask(id) }}
            />}
            {page === 'im' && bootstrap && user && localImContext && <ImChannelsPage
              key={user.userId}
              selectedConversationKey={imConversationKey}
              onSelectConversation={setImConversationKey}
              sessionToken={sessionToken}
              employeeId={user.userId}
              teamId={user.teamId}
              capabilitySnapshot={localImContext.capabilitySnapshot}
              litellmBaseUrl={bootstrap.endpoints.litellm}
              knowledgeEndpoint={resolveServerEndpoint(bootstrap.endpoints.knowledge)}
              scheduleEndpoint={localScheduleNamespace()}
              model={activeModel}
              modelApiKey={bootstrap.modelApiKey}
              allowShell={localImContext.allowShell}
              allowLsp={localImContext.allowLsp}
              allowExternalAgents={localImContext.allowExternalAgents}
              allowHooks={localImContext.allowHooks}
              localTasks={localTasks}
            />}
          </section>
        ))}
      {activeExpertKit && <ExpertKitDetailsModal
        onChanged={refreshInstalledKits}
        kit={activeExpertKit}
        skills={skills}
        connectors={runtimeConnectors}
        knowledgeBases={knowledgeBases}
        installing={installingKitId === activeExpertKit.id}
        removing={(developerKitBusy && activeExpertKit.localOnly) || removingCatalogId === activeExpertKit.id}
        onClose={() => setActiveExpertKitId('')}
        onInstall={() => void installKit(activeExpertKit)}
        onRemove={activeExpertKit.localOnly
          ? () => void removeLocalAcceptanceKit(activeExpertKit)
          : activeExpertKit.installed ? () => void removeCatalogArtifact('expert-kit', activeExpertKit.id) : undefined}
        onSchedule={() => { setActiveExpertKitId(''); setPage('schedules') }}
        onLoadReadme={bootstrap && user ? (id) => loadExpertKitReadme(bootstrap.endpoints.expertKits, id, user.userId, sessionToken) : undefined}
        onUse={activeExpertKit.installed?.enabled !== false && activeExpertKit.installState === 'installed' ? (command) => { setActiveExpertKitId(''); startNewTask(`/kit:${activeExpertKit.id}${command ? `:${command}` : ''} `) } : undefined}
        onConfigureConnectors={() => { setActiveExpertKitId(''); setExtensionQuery(''); setPage('connectors') }}
        onConfigureKnowledge={() => { setActiveExpertKitId(''); setPage('knowledge') }}
        onToggleConnector={(connector, enabled) => {
          if (enabled && (connector.authMode === 'oauth' || connector.status === 'needs-configuration')) {
            setActiveExpertKitId('')
            setExtensionQuery(connector.name)
            setPage('connectors')
            return
          }
          toggleConnector(connector.id, enabled)
        }}
        onCustomize={activeExpertKit.installState === 'installed' ? () => void customizeLocalExpertKit(activeExpertKit) : undefined}
        onExport={activeExpertKit.installState === 'installed' ? () => void exportLocalExpertKit(activeExpertKit) : undefined}
      />}
      {activeSkill && <SkillDetailsModal
        onChanged={refreshInstalledKits}
        skill={activeSkill}
        connectors={connectors}
        knowledgeBases={knowledgeBases}
        installing={installingSkillId === activeSkill.id}
        removing={removingCatalogId === activeSkill.id}
        onClose={() => setActiveSkillId('')}
        onInstall={() => void installSkill(activeSkill)}
        onUse={activeSkill.installed?.enabled !== false && activeSkill.installState === 'installed' ? () => { setActiveSkillId(''); startNewTask(`/skill:${activeSkill.id} `) } : undefined}
        onCustomize={activeSkill.installed ? () => void customizeLocalExpertKit(activeSkill, 'skill') : undefined}
        onExport={activeSkill.installed ? () => void exportLocalExpertKit(activeSkill, 'skill') : undefined}
        onRemove={activeSkill.installed ? () => void removeCatalogArtifact('skill', activeSkill.id) : undefined}
      />}
      </main>
      {uploadKind && <ExtensionUploadDialog kind={uploadKind} onClose={() => setUploadKind(undefined)} onInstall={(path) => installLocalExtension(uploadKind, 'archive', path)} />}
      {authoringKind === 'connector' && user && <McpConnectorDialog initial={editingConnector ? { ...editingConnector, ...connectorSecrets[editingConnector.id] } : undefined} existingIds={connectors.map((item) => item.id)} onClose={() => { setAuthoringKind(undefined); setEditingConnector(undefined) }} onSave={(connector) => persistPersonalConnector(connector, !editingConnector)} />}
      {authoringKind && authoringKind !== 'connector' && user && <ExtensionAuthoringModal
        sessionToken={sessionToken}
        connectors={connectors}
        connectorSecrets={connectorSecrets}
        employeeId={user.userId}
        initialKind={authoringKind}
        initialInstructions={authoringInstructions}
        initialConnector={editingConnector}
        onClose={() => { setAuthoringKind(undefined); setAuthoringInstructions(''); setEditingConnector(undefined) }}
        onPreviewRunningChange={() => undefined}
        previewConfig={runtimeStatus === 'ready' && bootstrap ? {
          employeeId: user.userId,
          teamId: user.teamId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: localScheduleNamespace(),
          connectors: runtimeConnectors,
          model: activeModel,
          modelApiKey: bootstrap.modelApiKey,
          sessionToken,
          localFileRootIds: localDirectories.map((directory) => directory.id),
          allowShell,
          allowLsp,
          allowExternalAgents,
          allowHooks,
        } : undefined}
        previewUnavailableReason={runtimeStatus !== 'ready' ? '企业服务尚未连接，暂时不能试运行。' : undefined}
        skills={skillViews}
        onChanged={async (change) => {
          if (change.type === 'connector-upsert') {
            await persistPersonalConnector({ ...change.connector, ...change.secrets })
            notify('连接器配置已保存')
          } else if (change.type === 'connector-delete') {
            await removePersonalConnector(change.id)
          } else await refreshInstalledKits()
        }}
      />}
      {confirmationDialog}
      {memoryCommands.dialog}
      {toast}
    </div>
  )
}
