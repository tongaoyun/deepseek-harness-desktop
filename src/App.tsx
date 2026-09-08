import { CircleStop, FolderOpen, ShieldCheck } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  createExpertKitDownload,
  createSkillDownload,
  resolveServerEndpoint,
  localScheduleNamespace,
  submitFeedback,
} from './api'
import { ErpAuthScreen } from './ErpAuthScreen'
import { ExpertKitDetailsModal } from './ExpertKitDetailsModal'
import { SkillDetailsModal } from './SkillDetailsModal'
import {
  customizeExpertKit,
  exportExpertKit,
  installDeveloperExtension,
  installExtension,
  removeCatalogExtension,
  removeBrokenExtension,
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
  clearLocalDirectories,
  classifyHarnessFailure,
  connectorDiagnosticsAvailable,
  createTaskMonitor,
  diagnoseConnectors,
  restoreLocalDirectories,
  respondHarnessApproval,
  revokeLocalDirectory,
  shutdownHarness,
  type AuthorizedLocalDirectory,
} from './harness'
import type {
  ConnectorCatalogEntry,
  LocalTaskAttachment,
} from './types'
import { useEnterpriseSession } from './useEnterpriseSession'
import { ScheduledTasksPage } from './ScheduledTasksPage'
import { ImChannelsPage } from './ImChannelsPage'
import { loadTaskHistory, loadTaskById, removeTaskHistory } from './taskHistory'
import { useTaskPersistence } from './useTaskPersistence'
import { useHistoryPages } from './useHistoryPages'
import { useTaskCheckpoints } from './useTaskCheckpoints'
import { useLocalSchedules } from './useLocalSchedules'
import { useLocalScheduleTools } from './useLocalScheduleTools'
import { attachmentSelectionError } from './attachmentLimits'
import { restoredTaskSessionId } from './harnessSession'
import { prepareTaskTurn } from './taskTurn'
import { startLocalIm, stopLocalImRuntime } from './localIm'
import type { LocalTaskRun, TaskMessage, TaskMonitorState } from './types'
import { parseMemoryCommand, learnCompletedTask } from './memory'
import { useMemoryCommands } from './useMemoryCommands'
import { useMemorySync } from './useMemorySync'
import { modelStorageKey, resolveSelectedModel } from './modelSelection'
import { needsLocalDirectoryAuthorization, standardLocalDirectories } from './localFileIntent'
import { creationPrompt, type XiaoyinCreationKind } from './creationPrompts'
import { McpConnectorDialog } from './McpConnectorDialog'
import { ExtensionUploadDialog } from './ExtensionUploadDialog'
import { extensionInvocations, selectedInvocation } from './extensionInvocations'
import { parseConnectorImport } from './connectorImport'
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
import type { SkillView } from './skills'
import { allowedExtensionArtifacts } from './extensionPolicy'
import { createCapabilitySnapshot } from './capabilitySnapshot'
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
import { retryingTaskMonitor, runHarnessWithRecovery } from './taskRecovery'
import { useHarnessHealth } from './useHarnessHealth'
import { useDeviceHeartbeat } from './useDeviceHeartbeat'
import { inspectDeviceHeartbeatContext } from './deviceHeartbeat'
import { reportTaskAudit } from './taskAudit'
import { useDesktopDrop } from './useDesktopDrop'
import { useApplyDesktopPreferences } from './desktopPreferences'
import { useLocalImSync } from './useLocalImSync'
import { useHarnessNotifications, type StreamingTaskState } from './useHarnessNotifications'
import { useTaskQueue, type QueuedPrompt } from './useTaskQueue'
import { parseTaskOutcome, taskOutcomeLabel, unverifiedTaskOutcome, type TaskOutcome } from './taskOutcome'
import { draftRootPaths, readTaskDraft, recentWorkDirectories, rememberWorkDirectory, saveTaskDraft, type TaskDraft } from './taskDrafts'
import { joinComposerPrompt, splitComposerPrompt } from './composerInput'
import './styles.css'

const extensionNav = [
  { id: 'skills', label: '技能与套件' },
  { id: 'connectors', label: '连接器' },
  { id: 'knowledge', label: '知识库' },
]

export default function App() {
  useApplyDesktopPreferences()
  const { confirm: confirmAction, dialog: confirmationDialog, notify, toast } = useDesktopDialog()
  const { accessToken, authorizing, error: authError, logout, reopen, state: authState, user } = useEnterpriseSession()
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const { bootstrap, runtimeStatus, error: configurationError } = useEnterpriseBootstrap(authState === 'authenticated' ? user?.userId : undefined, accessToken, connectionAttempt)
  const memoryCommands = useMemoryCommands(confirmAction)
  useMemorySync(bootstrap ? user?.userId : undefined, bootstrap?.endpoints.memoryProfile ?? '/api/v1/memory-profile', accessToken,
    () => notify('记忆存在跨设备修改冲突，请到设置 → 记忆选择版本。本机内容已保留。', 'error'))
  const [prompt, setPrompt] = useState('')
  const [page, setPage] = useState('chat')
  const [imConversationKey, setImConversationKey] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [messages, setMessages] = useState<TaskMessage[]>([])
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
    cacheSavedAt: catalogCacheSavedAt,
    connectors,
    expertKitCatalog,
    expertKits,
    knowledgeBases,
    loading: expertKitsLoading,
    refresh: refreshEnterpriseCatalog,
    refreshInstalled: refreshCatalogInstalled,
    replaceConnectors,
    skills,
    skillViews,
    syncIssues: extensionSyncIssues,
    syncedAt: extensionSyncedAt,
  } = useEnterpriseCatalog({ accessToken, bootstrap, enabledConnectorIds, user })
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
  const {
    health: harnessHealth,
    detail: harnessHealthDetail,
    recover: recoverHarness,
    reportInfrastructureFailure,
  } = useHarnessHealth(authState === 'authenticated')
  const [taskMonitor, setTaskMonitor] = useState<TaskMonitorState>(createTaskMonitor)
  const taskMonitorRef = useRef<TaskMonitorState>(taskMonitor)
  const [localDirectories, setLocalDirectories] = useState<AuthorizedLocalDirectory[]>([])
  const [pendingAttachments, setPendingAttachments] = useState<LocalTaskAttachment[]>([])
  const attachmentImportRef = useRef(false)
  const attachmentViewRef = useRef({ pendingAttachments, localDirectories, page })
  attachmentViewRef.current = { pendingAttachments, localDirectories, page }
  const [localFileError, setLocalFileError] = useState('')
  const [draftSaveError, setDraftSaveError] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
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
  const allowedArtifacts = useMemo(
    () => allowedExtensionArtifacts(expertKitCatalog, skills),
    [expertKitCatalog, skills],
  )
  const runtimeConnectors = useMemo(() => buildRuntimeConnectorCatalog(
    connectors, bootstrap?.endpoints.erpMcp ?? '', enabledConnectorIds, connectorSecrets,
  ), [bootstrap?.endpoints.erpMcp, connectorSecrets, connectors, enabledConnectorIds])
  const activeModel = resolveSelectedModel(bootstrap?.models ?? [], selectedModel)
  const localImContext = useMemo(() => bootstrap && user ? {
    employeeId: user.userId,
    teamId: user.teamId,
    litellmBaseUrl: bootstrap.endpoints.litellm,
    knowledgeEndpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge),
    scheduleEndpoint: localScheduleNamespace(),
    connectors: runtimeConnectors,
    allowedArtifacts,
    model: activeModel,
    modelApiKey: bootstrap.modelApiKey,
    accessToken,
  } : undefined, [accessToken, activeModel, allowedArtifacts, bootstrap, runtimeConnectors, user])
  const selectCurrentLocalTaskId = (id: string) => {
    currentLocalTaskIdRef.current = id
    setCurrentLocalTaskId(id)
  }
  const taskStartLocks = useRef(new Set<string>())
  const currentTaskRunning = Boolean(currentLocalTaskId && runningTaskIds.includes(currentLocalTaskId))
  const taskQueue = useTaskQueue({
    owner: user?.userId, ready: authState === 'authenticated' && runtimeStatus === 'ready' && harnessHealth === 'ready',
    tasks: localTasks, runningIds: runningTaskIds, run: runQueued,
  })
  const localSchedules = useLocalSchedules(user && bootstrap ? `${user.userId}:${localScheduleNamespace()}` : undefined,
    connectorDiagnosticsAvailable() && authState === 'authenticated' && runtimeStatus === 'ready' && harnessHealth === 'ready' && runningTaskIds.length < 3,
    async (schedule, taskId) => {
      if (schedule.model && !bootstrap?.models.includes(schedule.model)) return { notStarted: '计划指定的模型已不可用，请编辑计划重新选择模型；计划已暂停' }
      const directories = [...schedule.directories, ...(schedule.attachments ?? []).flatMap((file) => file.rootPath ? [{ id: file.rootId, name: file.rootName, path: file.rootPath }] : [])]
        .filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index)
      if (!directories.length && needsLocalDirectoryAuthorization(schedule.prompt) && !standardLocalDirectories(schedule.prompt).length) {
        return { notStarted: '本轮未启动：该计划需要工作目录，请编辑计划选择目录后再执行；计划已暂停' }
      }
      const now = new Date().toISOString()
      const task: LocalTaskRun = { id: taskId, source: 'DESKTOP', name: schedule.name, status: 'COMPLETED', createdAt: now, updatedAt: now,
        ...schedule.taskContext, localDirectories: directories, model: schedule.model || activeModel, messages: [], monitor: createTaskMonitor(now) }
      let started = false
      try {
        return await executeTask(schedule.prompt, schedule.attachments ?? [], task, () => { started = true }) ?? { notStarted: '本轮未启动，请检查工作目录、模型和能力配置后再执行；计划已暂停' }
      } catch (error) {
        if (!started) return { notStarted: `本轮未启动：${error instanceof Error ? error.message : String(error)}` }
        throw error
      }
    })
  useLocalScheduleTools(user && bootstrap ? `${user.userId}:${localScheduleNamespace()}` : undefined, localSchedules, localTasks, runningTaskIds)
  const dragActive = useDesktopDrop({
    enabled: authState === 'authenticated' && page === 'chat' && connectorDiagnosticsAvailable(),
    running: currentTaskRunning || taskContextRestoring || pastingAttachments,
    onPaths: (paths) => importTaskAttachments(() => authorizeDroppedPaths(paths)),
    onError: setLocalFileError,
  })
  const sendDeviceHeartbeat = useDeviceHeartbeat({
    accessToken,
    authenticated: authState === 'authenticated',
    bootstrap,
    employeeId: user?.userId,
    expertKits: expertKitCatalog,
    harnessHealth,
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
      setMessages(task.messages)
      setHarnessSessionId(task.sessionId ?? '')
      taskMonitorRef.current = task.monitor
      setTaskMonitor(task.monitor)
    },
  })
  useHarnessNotifications({
    currentTaskIdRef: currentLocalTaskIdRef,
    streamingTasksRef,
    onTaskUpdate: (taskId, monitor, taskMessages) => setLocalTasks((current) => current.map((task) => task.id === taskId
      ? { ...task, updatedAt: monitor.updatedAt, monitor, messages: taskMessages }
      : task)),
    onCurrentUpdate: (monitor, taskMessages) => {
      taskMonitorRef.current = monitor
      setTaskMonitor(monitor)
      if (taskMessages) setMessages(taskMessages)
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
      readTaskDraft(user.userId, currentLocalTaskIdRef.current || creationDraftKeyRef.current)?.model || window.localStorage.getItem(modelStorageKey(user.userId)),
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
      .then((tasks) => { if (!disposed) setLocalTasks((current) => {
        const known = new Set(current.map((task) => task.id))
        return [...current, ...tasks.filter((task) => !known.has(task.id))].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      }) })
      .catch((reason) => { if (!disposed) setLocalFileError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true }
  }, [authState, user])

  useEffect(() => {
    if (authState === 'authenticated') return
    setLocalDirectories([])
    setPendingAttachments([])
    void Promise.all([clearLocalDirectories(), shutdownHarness(), stopLocalImRuntime()])
  }, [authState])

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
    if (!modelMenuOpen) return
    const dismiss = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelMenuOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [modelMenuOpen])

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [page, activeExpertKitId, activeSkillId])

  const visibleExpertKits = useMemo(
    () => expertKits.filter((item) => extensionMatches(item, extensionQuery, extensionFilter, extensionCategory)),
    [expertKits, extensionCategory, extensionFilter, extensionQuery],
  )
  const visibleSkillViews = useMemo(
    () => skillViews.filter((item) => extensionMatches(item, extensionQuery, extensionFilter, extensionCategory)),
    [extensionCategory, extensionFilter, extensionQuery, skillViews],
  )

  useEffect(() => {
    if (authState !== 'authenticated' || !user) { draftOwnerRef.current = ''; draftPausedRef.current = true; return }
    if (draftOwnerRef.current === user.userId) return
    draftOwnerRef.current = user.userId
    creationDraftKeyRef.current = ''
    setCreationKind(undefined)
    setRecentDirectories(recentWorkDirectories(user.userId))
    void restoreDraftContext(readTaskDraft(user.userId, ''))
  }, [authState, user?.userId])
  useEffect(() => { saveCurrentDraft() }, [user?.userId, currentLocalTaskId, prompt, pendingAttachments, localDirectories, selectedKnowledgeBaseRefs, selectedTaskConnectorIds, activeModel, taskContextRestoring])
  useEffect(() => { setDraftSaveError('') }, [user?.userId])
  useEffect(() => {
    if (!draftSaveError) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [draftSaveError])

  if (authState !== 'authenticated') {
    return <ErpAuthScreen authorizing={authorizing} checking={authState === 'checking'} error={authError} onReopen={() => void reopen()} />
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
    setConnectorSecrets(await saveConnectorSecrets(user.userId, connector.id, connectorSecretValues(connector)))
    savePersonalConnector(user.userId, template)
    replaceConnectors((current) => [template, ...current.filter((item) => item.id !== connector.id)])
    if (!existing) toggleConnector(connector.id, true)
    setCurrentCapabilitySnapshot(undefined)
    setHarnessSessionId('')
  }

  const removePersonalConnector = async (id: string) => {
    if (!user) throw new Error('请先登录')
    setConnectorSecrets(await deleteConnectorSecrets(user.userId, id))
    deletePersonalConnector(user.userId, id)
    replaceConnectors((current) => current.filter((item) => item.id !== id))
    toggleConnector(id, false)
  }

  const visibleLocalTasks = taskQuery.trim()
    ? localTasks.filter((task) => {
      const query = taskQuery.trim().toLocaleLowerCase()
      return historyPages.ids.includes(task.id) || task.name.toLocaleLowerCase().includes(query)
        || task.messages.some((message) => message.text.toLocaleLowerCase().includes(query))
    })
    : localTasks
  const focusComposer = () => window.requestAnimationFrame(() => composerRef.current?.focus())
  const setTaskMonitorActivity = (activity: string) => {
    const next = { ...taskMonitorRef.current, activity, updatedAt: new Date().toISOString() }
    taskMonitorRef.current = next
    setTaskMonitor(next)
  }
  const startNewTask = (initialPrompt = '', nextCreationKind?: 'skill' | 'expert-kit', draftKind?: XiaoyinCreationKind) => {
    if (!saveCurrentDraft()) return Promise.resolve()
    creationDraftKeyRef.current = draftKind ? `creation:${draftKind}` : ''
    const saved = user ? readTaskDraft(user.userId, creationDraftKeyRef.current) : undefined
    setActiveExpertKitId('')
    setActiveSkillId('')
    taskContextRestoreIdRef.current += 1
    setTaskContextRestoring(false)
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setMessages([])
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
    setSelectedKnowledgeBaseRefs([])
    selectCurrentLocalTaskId('')
    setCreationKind(nextCreationKind)
    setPendingAttachments([])
    const monitor = createTaskMonitor()
    taskMonitorRef.current = monitor
    setTaskMonitor(monitor)
    setLocalDirectories([])
    setLocalFileError('')
    focusComposer()
    let draft = saved
    if (initialPrompt && (!draftKind || !saved?.prompt.trim())) {
      const initial = splitComposerPrompt(initialPrompt)
      const existing = splitComposerPrompt(saved?.prompt ?? '').text
      const nextPrompt = initial.token ? joinComposerPrompt(initial.token, initial.text || existing) : [initialPrompt, existing].filter(Boolean).join('\n\n')
      draft = { ...emptyDraft(), ...saved, prompt: nextPrompt }
    }
    return restoreDraftContext(draft)
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
  const openLocalTask = (task: LocalTaskRun) => {
    storedTaskOpenRef.current++
    if (!saveCurrentDraft()) return
    const streaming = streamingTasksRef.current.get(task.id)
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setMessages(streaming?.messages ?? task.messages.map((message) => ({ ...message, pending: false })))
    selectCurrentLocalTaskId(task.id)
    setCreationKind(undefined)
    setCurrentCapabilitySnapshot(task.capabilitySnapshot)
    taskMonitorRef.current = streaming?.monitor ?? task.monitor
    setTaskMonitor(streaming?.monitor ?? task.monitor)
    const draft = user ? readTaskDraft(user.userId, task.id) : undefined
    setHarnessSessionId(restoredTaskSessionId(task, draft))
    void restoreDraftContext(draft ?? { ...emptyDraft(), prompt: joinComposerPrompt(task.invocationToken ?? '', ''), directories: task.localDirectories ?? [], knowledgeRefs: task.capabilitySnapshot?.knowledgeBaseRefs ?? [], connectorIds: task.composerConnectorIds ?? [], model: task.model ?? activeModel })
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
  function emptyDraft(): TaskDraft { return { prompt: '', attachments: [], directories: [], knowledgeRefs: [], connectorIds: [], model: activeModel, updatedAt: Date.now() } }
  function saveCurrentDraft() {
    if (!user || draftOwnerRef.current !== user.userId || draftPausedRef.current) return true
    try { saveTaskDraft(user.userId, currentLocalTaskId || creationDraftKeyRef.current, { prompt, attachments: pendingAttachments, directories: localDirectories, knowledgeRefs: selectedKnowledgeBaseRefs, connectorIds: selectedTaskConnectorIds, model: activeModel, updatedAt: Date.now() }); setDraftSaveError(''); return true }
    catch { setDraftSaveError('草稿保存失败，请检查本机存储空间。当前输入已保留；保存成功前不能切换到其他对话。'); return false }
  }
  async function restoreDraftContext(saved?: TaskDraft) {
    const generation = ++taskContextRestoreIdRef.current
    draftPausedRef.current = true
    const draft = saved ?? emptyDraft()
    setPrompt(draft.prompt); setPendingAttachments(draft.attachments); setLocalDirectories(draft.directories)
    setSelectedKnowledgeBaseRefs(draft.knowledgeRefs); setSelectedTaskConnectorIds(draft.connectorIds)
    setSelectedModel(bootstrap ? resolveSelectedModel(bootstrap.models, draft.model) : draft.model)
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
      if (user) { rememberWorkDirectory(user.userId, authorization); setRecentDirectories(recentWorkDirectories(user.userId)) }
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
    await clearLocalDirectories()
    await Promise.all([shutdownHarness(), stopLocalImRuntime()])
    setLocalDirectories([])
    await logout()
  }

  const submitDesktopFeedback = async (message: string, category: 'BUG' | 'SUGGESTION' | 'QUESTION' | 'OTHER', images?: File[]) => {
    if (!bootstrap || !user) throw new Error('企业服务尚未连接')
    const device = await inspectDeviceHeartbeatContext().catch(() => undefined)
    await submitFeedback(user.userId, accessToken, message, {
      category,
      desktopVersion: device?.desktopVersion,
      deviceId: device?.deviceId,
      taskId: currentLocalTaskIdRef.current || undefined,
    }, images)
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (attachmentImportRef.current || pastingAttachments || taskContextRestoring) return
    const currentQueue = taskQueue.queues[currentLocalTaskId]
    if (currentTaskRunning || (currentQueue?.items.length && !currentQueue.paused)) {
      if (!splitComposerPrompt(prompt).text.trim()) return
      if (pendingAttachments.length) { setLocalFileError('排队暂支持文字，请在当前轮完成后添加附件。'); return }
      if (taskQueue.enqueue(currentLocalTaskId, prompt)) setPrompt('')
      return
    }
    await executeTask(prompt, pendingAttachments)
  }

  async function runQueued(task: LocalTaskRun, item: QueuedPrompt, accepted: () => void) {
    if (!bootstrap || !user || runtimeStatus !== 'ready') return 'blocked' as const
    try { return await executeTask(item.text, [], task, accepted) === true ? 'completed' as const : 'failed' as const }
    catch (reason) { notify(reason instanceof Error ? reason.message : String(reason), 'error'); return 'blocked' as const }
  }

  async function executeTask(rawInput: string, messageAttachments: LocalTaskAttachment[], queuedTask?: LocalTaskRun, accepted?: () => void): Promise<boolean | 'canceled' | { outcome: TaskOutcome } | undefined> {
    const input = rawInput.trim() || (messageAttachments.length > 0 ? '请查看并处理这些附件。' : '')
    if (!input || !bootstrap || !user || runtimeStatus !== 'ready') return
    const contextTaskId = queuedTask?.id ?? currentLocalTaskId
    const lockKey = contextTaskId || 'new-task'
    if (taskStartLocks.current.has(lockKey) || streamingTasksRef.current.has(contextTaskId)) return
    taskStartLocks.current.add(lockKey)
    const contextGeneration = taskContextRestoreIdRef.current
    const isCurrent = () => currentLocalTaskIdRef.current === contextTaskId && (Boolean(queuedTask) || contextGeneration === taskContextRestoreIdRef.current)
    const reportInputError = (message: string) => { if (isCurrent()) setLocalFileError(message); else notify(message, 'error') }
    const contextMessages = queuedTask?.messages ?? messages
    const contextMonitor = queuedTask?.monitor ?? taskMonitorRef.current
    const taskModel = resolveSelectedModel(bootstrap.models, queuedTask ? queuedTask.model : activeModel)
    try {
      if (!taskModel) { reportInputError('当前没有可用模型，请在控制中心配置模型后重试。'); return }
      const attachmentError = attachmentSelectionError(messageAttachments)
      if (attachmentError) { reportInputError(attachmentError); return }
      if ((/^\/(?:kit|skill):/u.test(input) && !selectedInvocation(input, extensionInvocations(expertKits, skillViews)))
        || (queuedTask?.invocationToken && !extensionInvocations(expertKits, skillViews).some((item) => item.token === queuedTask.invocationToken))) {
        reportInputError('该技能、套件或命令尚未安装或已不可用，请输入 / 重新选择。')
        return
      }
      if (!queuedTask && taskContextRestoring) {
        setLocalFileError('正在恢复该任务的工作目录，请稍候。')
        return
      }
      const memoryCommand = !queuedTask && messageAttachments.length === 0 ? parseMemoryCommand(input) : undefined
      if (memoryCommand) {
        const taskId = contextTaskId || crypto.randomUUID()
        const existingTask = localTasks.find((task) => task.id === taskId)
        setPrompt('')
        let reply = '未更改长期记忆。'
        try {
          reply = await memoryCommands.run(memoryCommand, user.userId, bootstrap.endpoints.memoryProfile ?? '/api/v1/memory-profile', accessToken, taskId)
        } catch (error) {
          reply = `记忆未更改：${error instanceof Error ? error.message : String(error)}`
        }
        const rememberedMessages: TaskMessage[] = [...contextMessages, { role: 'user', text: input }, { role: 'assistant', text: reply }]
        const timestamp = new Date().toISOString()
        const monitor: TaskMonitorState = { ...createTaskMonitor(timestamp), status: 'completed', activity: '记忆处理完成' }
        persistLocalTask({ ...existingTask, id: taskId, source: existingTask?.source ?? 'DESKTOP', name: existingTask?.name ?? input.slice(0, 60),
          status: 'COMPLETED', createdAt: existingTask?.createdAt ?? timestamp, updatedAt: timestamp, monitor, messages: rememberedMessages, sessionId: '' })
        if (isCurrent()) {
          selectCurrentLocalTaskId(taskId)
          setMessages(rememberedMessages)
          setHarnessSessionId('')
          taskMonitorRef.current = monitor
          setTaskMonitor(monitor)
        }
        return
      }
      let taskDirectories = queuedTask ? await restoreLocalDirectories((queuedTask.localDirectories ?? []).flatMap((directory) => directory.path ? [directory.path] : [])) : localDirectories
      if (queuedTask && taskDirectories.length < (queuedTask.localDirectories?.length ?? 0)) { reportInputError('排队任务的工作目录不可用，请恢复原目录后继续，或移除该消息并在新任务中重新发送。'); return }
      const taskSessionId = queuedTask ? queuedTask.sessionId ?? '' : harnessSessionId
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
      } else if (taskDirectories.length === 0 && needsLocalDirectoryAuthorization(input)) {
        reportInputError('请先在输入框下方选择工作目录，任务内容已保留。')
        return
      }
      const now = new Date().toISOString()
      const taskConnectorIds = queuedTask?.composerConnectorIds ?? (queuedTask ? [] : selectedTaskConnectorIds)
      if (taskConnectorIds.some((id) => !runtimeConnectors.some((item) => item.id === id && item.enabled && item.status === 'ready'))) { reportInputError('选中的连接器尚未就绪，请重新配置或从当前任务移除。'); return }
      const taskConnectors = runtimeConnectors.filter((item) => item.enabled && item.status === 'ready'
        && (!taskConnectorIds.length || taskConnectorIds.includes(item.id)))
      const capabilitySnapshot = createCapabilitySnapshot(expertKits, skillViews, taskConnectors,
        queuedTask ? queuedTask.capabilitySnapshot?.knowledgeBaseRefs ?? [] : selectedKnowledgeBaseRefs, now)
      if (isCurrent()) setCurrentCapabilitySnapshot(capabilitySnapshot)
      const taskId = contextTaskId || crypto.randomUUID()
      const existingTask = queuedTask ?? localTasks.find((task) => task.id === taskId)
      const invocations = extensionInvocations(expertKits, skillViews)
      const currentInvocation = selectedInvocation(input, invocations)
      const invocation = currentInvocation ?? (queuedTask?.invocationToken ? invocations.find((item) => item.token === queuedTask.invocationToken) : undefined)
      const { rootSessionId, harnessPrompt, pendingMessages, runningMonitor, runningTask } = prepareTaskTurn({
        taskId, input, now, existingTask, sessionId: taskSessionId, model: taskModel,
        directories: taskDirectories, directoriesChanged: resetSessionForDirectoryChange,
        connectorIds: taskConnectorIds, capabilities: capabilitySnapshot, invocation,
        messages: contextMessages, monitor: contextMonitor, attachments: messageAttachments,
      })
      accepted?.()
      if (isCurrent()) {
        if (!queuedTask) { try { saveTaskDraft(user.userId, contextTaskId || creationDraftKeyRef.current) } catch { /* Current task keeps the submitted content. */ } }
        selectCurrentLocalTaskId(taskId)
        setHarnessSessionId(rootSessionId)
        setMessages(pendingMessages)
        if (!queuedTask) { setPrompt(joinComposerPrompt(invocation?.token ?? '', '')); setPendingAttachments([]) }
      }
      persistLocalTask(runningTask)
      const streaming: StreamingTaskState = {
        monitor: runningMonitor,
        messages: pendingMessages,
        responseKey: '',
        cancellationRequested: false,
      }
      streamingTasksRef.current.set(taskId, streaming)
      setRunningTaskIds((current) => current.includes(taskId) ? current : [...current, taskId])
      if (currentLocalTaskIdRef.current === taskId) {
        taskMonitorRef.current = runningMonitor
        setTaskMonitor(runningMonitor)
      }
      let executionSessionId = rootSessionId
      try {
        const result = await runHarnessWithRecovery({
          taskId,
          prompt: harnessPrompt,
          selectedExtension: invocation ? { kind: invocation.kind, id: invocation.id } : undefined,
          executionMode: 'agent',
          employeeId: user!.userId,
          teamId: user!.teamId,
          sessionId: rootSessionId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: localScheduleNamespace(),
          connectors: taskConnectors,
          allowedArtifacts: capabilitySnapshot.extensions,
          knowledgeBaseRefs: capabilitySnapshot.knowledgeBaseRefs,
          model: taskModel,
          modelApiKey: bootstrap.modelApiKey,
          accessToken,
          localFileRootIds: taskDirectories.map((directory) => directory.id),
          attachments: messageAttachments,
        }, {
          getMonitor: () => streaming.monitor,
          isCanceled: () => streaming.cancellationRequested,
          onRetry: (sessionId) => {
            executionSessionId = sessionId
            const retryMonitor = retryingTaskMonitor(streaming.monitor)
            streaming.monitor = retryMonitor
            streaming.responseKey = ''
            streaming.messages = streaming.messages.map((message, index) => index === streaming.messages.length - 1
              ? { ...message, text: '', pending: true }
              : message)
            if (currentLocalTaskIdRef.current === taskId) {
              setHarnessSessionId(sessionId)
              taskMonitorRef.current = retryMonitor
              setTaskMonitor(retryMonitor)
              setMessages(streaming.messages)
            }
            persistLocalTask({ ...runningTask, sessionId, updatedAt: new Date().toISOString(), monitor: retryMonitor, messages: streaming.messages })
          },
        })
        if (streaming.cancellationRequested) throw new Error('本轮已停止')
        if (!result.finalResponse.trim()) throw new Error('模型本轮没有返回可显示文本，请重试')
        const outcome = parseTaskOutcome(result.outcome) ?? unverifiedTaskOutcome()
        const goalCompleted = outcome.status === 'completed'
        if (!goalCompleted) taskQueue.pause(taskId)
        const completedAt = new Date().toISOString()
        const completedMonitor: TaskMonitorState = {
          ...streaming.monitor, outcome, status: 'completed', activity: taskOutcomeLabel(outcome), updatedAt: completedAt,
          completedAt,
        }
        const completedMessages = streaming.messages.map((message, index) => index === streaming.messages.length - 1
          ? { role: 'assistant', text: result.finalResponse, monitor: completedMonitor }
          : message) as TaskMessage[]
        if (currentLocalTaskIdRef.current === taskId) {
          setHarnessSessionId(result.sessionId)
          taskMonitorRef.current = completedMonitor
          setTaskMonitor(completedMonitor)
          setMessages(completedMessages)
        }
        persistLocalTask({ ...runningTask, status: 'COMPLETED', updatedAt: new Date().toISOString(),
          sessionId: result.sessionId, monitor: completedMonitor, messages: completedMessages })
        if (!queuedTask && goalCompleted) void learnCompletedTask(user.userId, bootstrap.endpoints.memoryProfile ?? '/api/v1/memory-profile', accessToken, input, taskId)
          .then((saved) => { if (saved) notify(`已记住这条明确偏好。${saved.syncPending ? '暂未同步到云端。' : '可在设置 → 记忆中修改或删除。'}`, 'success') })
          .catch((error) => notify(`任务已完成，自动记忆未写入：${error instanceof Error ? error.message : String(error)}`, 'error'))
        void reportTaskAudit({
          accessToken,
          employeeId: user!.userId,
          endpoint: bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events',
          outcome: goalCompleted ? 'SUCCEEDED' : 'FAILED',
          taskOutcome: outcome,
          taskId,
        })
        return goalCompleted ? true : { outcome }
      } catch (error) {
        taskQueue.pause(taskId)
        const failure = classifyHarnessFailure(error)
        const message = failure.message
        const canceled = streaming.cancellationRequested
        const completedAt = new Date().toISOString()
        const failedMonitor: TaskMonitorState = {
          ...streaming.monitor,
          steps: streaming.monitor.steps.map((step) => step.status === 'running' ? { ...step, status: canceled ? 'canceled' : 'failed', completedAt } : step),
          timeline: streaming.monitor.timeline?.map((entry) => entry.status === 'running' ? { ...entry, status: canceled ? 'canceled' : 'failed', completedAt } : entry),
          subagents: streaming.monitor.subagents?.map((agent) => agent.status === 'running' ? { ...agent, status: canceled ? 'canceled' : 'failed', completedAt } : agent),
          status: canceled ? 'canceled' : 'failed',
          activity: canceled ? '已停止' : '任务执行失败',
          updatedAt: completedAt,
          completedAt,
          failure: canceled ? undefined : { code: failure.code, category: failure.category, detail: message.slice(0, 500) },
        }
        const failedMessages = streaming.messages.map((item, index) => index === streaming.messages.length - 1
          ? { role: 'assistant', text: canceled ? item.text : [item.text.trim(), `${failure.title}：${message}\n\n错误编号：${failure.code}`].filter(Boolean).join('\n\n---\n\n'), monitor: failedMonitor }
          : item) as TaskMessage[]
        if (currentLocalTaskIdRef.current === taskId) {
          taskMonitorRef.current = failedMonitor
          setTaskMonitor(failedMonitor)
          setMessages(failedMessages)
        }
        persistLocalTask({ ...runningTask, status: canceled ? 'CANCELED' : 'FAILED', updatedAt: new Date().toISOString(), sessionId: executionSessionId, monitor: failedMonitor, messages: failedMessages })
        const infrastructureFailure = failure.infrastructure
        if (!canceled && infrastructureFailure) {
          reportInfrastructureFailure(message)
        }
        if (canceled || infrastructureFailure) await shutdownHarness(taskId).catch(() => undefined)
        void reportTaskAudit({
          accessToken,
          employeeId: user!.userId,
          endpoint: bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events',
          outcome: canceled ? 'CANCELED' : 'FAILED',
          taskId,
        })
        return canceled ? 'canceled' : false
      } finally {
        streamingTasksRef.current.delete(taskId)
        setRunningTaskIds((current) => current.filter((id) => id !== taskId))
      }
    } finally { taskStartLocks.current.delete(lockKey) }
  }

  const cancelCurrentTask = async () => {
    const taskId = currentLocalTaskIdRef.current
    const streaming = streamingTasksRef.current.get(taskId)
    if (!streaming || streaming.cancellationRequested) return
    taskQueue.pause(taskId)
    streaming.cancellationRequested = true
    streaming.monitor = { ...streaming.monitor, activity: '正在停止', updatedAt: new Date().toISOString() }
    setTaskMonitorActivity('正在停止')
    try {
      // A missing native run can mean it just finished or recovery is between runs.
      // Keep the intent: completion/recovery must not overwrite or restart it.
      await cancelHarness(taskId)
    } catch (reason) {
      if (streamingTasksRef.current.get(taskId) !== streaming) return
      streaming.cancellationRequested = false
      streaming.monitor = { ...streaming.monitor, activity: '停止失败，可重试' }
      if (currentLocalTaskIdRef.current === taskId) {
        setTaskMonitorActivity('停止失败，可重试')
        setLocalFileError(reason instanceof Error ? reason.message : String(reason))
      }
    }
  }

  const prepareRetry = () => {
    const previous = [...messages].reverse().find((message) => message.role === 'user')
    if (!previous) return
    setPrompt(previous.text)
    setPendingAttachments(previous.attachments ?? [])
    focusComposer()
  }

  const installKit = async (kit: ExpertKitView) => {
    if (!bootstrap || !user || kit.installState === 'installed') return
    setInstallingKitId(kit.id)
    setExpertKitError('')
    try {
      const download = await createExpertKitDownload(
        bootstrap.endpoints.expertKits,
        kit.id,
        user.userId,
        accessToken,
      )
      if (download.version !== kit.version || download.sha256 !== kit.sha256) {
        throw new Error('专家套件目录在安装期间发生变化，请刷新后重试')
      }
      await installExtension(download, 'expert-kit')
      await refreshInstalledKits()
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

  const cleanBrokenExtension = async (coordinate: string) => {
    if (!await confirmAction({
      title: '移除损坏扩展？',
      message: `${coordinate}\n\n只会删除这个无法加载的本地版本，之后可以重新安装。`,
      confirmLabel: '移除',
      danger: true,
    })) return
    try {
      await removeBrokenExtension(coordinate)
      await refreshInstalledKits()
      notify('损坏扩展已移除，可以重新安装。')
    } catch (reason) {
      setExpertKitError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const installSkill = async (skill: SkillView) => {
    if (!bootstrap || !user || skill.installState === 'installed') return
    setInstallingSkillId(skill.id)
    setExpertKitError('')
    try {
      const download = await createSkillDownload(bootstrap.endpoints.skills, skill.id, user.userId, accessToken)
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
          const failures: string[] = []
          for (const item of parseConnectorImport(JSON.stringify(installed.bundledConnectors))) {
            if (!item.connector) { failures.push(`${item.name}：${item.error}`); continue }
            const connector = item.connector
            if (!connectors.some((existing) => existing.id === connector.id)
              && !(user && loadPersonalConnectors(user.userId).some((existing) => existing.id === connector.id))) {
              try { await persistPersonalConnector(connector, true) }
              catch (error) { failures.push(`${item.name}：${error instanceof Error ? error.message : String(error)}`) }
            }
          }
          if (failures.length) throw new Error(failures.join('；'))
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
        const cleared = startNewTask(`请帮我定制「${kit.name}」。副本目录：${path}\n先询问我要调整的岗位、工作流程或输出要求，再修改该目录中的文件，保留辅助资源。完成后提醒我从${kind === 'skill' ? '技能' : '专家套件'}页面的“添加 → 上传”窗口选择本地文件夹，再点击“安装”。`)
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
      if (bootstrap && user) {
        await startLocalIm({
          employeeId: user.userId,
          teamId: user.teamId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: localScheduleNamespace(),
          connectors: runtimeConnectors,
          allowedArtifacts,
          model: activeModel,
          modelApiKey: bootstrap.modelApiKey,
          accessToken,
        }).catch(() => undefined)
      }
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
      if (bootstrap && user) {
        await startLocalIm({
          employeeId: user.userId,
          teamId: user.teamId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: localScheduleNamespace(),
          connectors: runtimeConnectors,
          allowedArtifacts,
          model: activeModel,
          modelApiKey: bootstrap.modelApiKey,
          accessToken,
        }).catch(() => undefined)
      }
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemovingCatalogId('')
    }
  }

  const selectModel = (model: string) => {
    if (model !== activeModel && currentLocalTaskId) {
      setHarnessSessionId('')
      void shutdownHarness(currentLocalTaskId)
    }
    setSelectedModel(model)
    setModelMenuOpen(false)
    if (user) window.localStorage.setItem(modelStorageKey(user.userId), model)
  }

  const memorySaved = async () => {
    setHarnessSessionId('')
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
          if (archived) taskQueue.pause(task.id)
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
              taskQueue.clear(task.id)
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
        {(taskPersistence.failures.length > 0 || draftSaveError) && <section className="task-save-warning" role="alert"><div><strong>{taskPersistence.failures.length ? `${taskPersistence.failures.length} 个任务尚未保存` : '当前草稿尚未保存'}</strong><p>当前内容仍在内存中，请勿退出应用。切换页面不会清除此提示。</p><details><summary>查看原因</summary>{draftSaveError && <p>{draftSaveError}</p>}{taskPersistence.failures.map((failure) => <p key={failure.task.id}>{failure.task.name}：{failure.detail}</p>)}</details></div><button type="button" disabled={!draftSaveError && taskPersistence.failures.every((failure) => failure.retrying)} onClick={() => { saveCurrentDraft(); void taskPersistence.retry() }}>{!draftSaveError && taskPersistence.failures.every((failure) => failure.retrying) ? '正在保存…' : '重试保存'}</button></section>}
        {!activeExpertKit && !activeSkill && (page === 'chat' ? (
          <ChatPage
            knowledgeContext={bootstrap && user ? { endpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge), employeeId: user.userId, teamId: user.teamId, accessToken } : undefined}
            key={currentLocalTaskId || 'new-task'}
            taskId={currentLocalTaskId}
            fileChangesBusy={runningTaskIds.length > 0}
            onChangesUndone={(messageIndex, results) => {
              const task = localTasks.find((item) => item.id === currentLocalTaskId)
              if (!task) return
              const nextMessages = task.messages.map((message, index) => index !== messageIndex || !message.monitor ? message : {
                ...message, monitor: { ...message.monitor, changes: message.monitor.changes?.map((change) => ({ ...change, ...results.find((result) => result.id === change.id) })) },
              })
              const nextMonitor = nextMessages.at(-1)?.monitor ?? task.monitor
              if (currentLocalTaskIdRef.current === task.id) {
                setMessages(nextMessages)
                setHarnessSessionId('')
                if (nextMonitor) { setTaskMonitor(nextMonitor); taskMonitorRef.current = nextMonitor }
              }
              void shutdownHarness(task.id)
              persistLocalTask({ ...task, sessionId: undefined, messages: nextMessages, monitor: nextMonitor, updatedAt: new Date().toISOString() })
            }}
            activeModel={activeModel}
            queue={taskQueue.queues[currentLocalTaskId]}
            queueError={taskQueue.error}
            onRemoveQueued={(id) => { taskQueue.remove(currentLocalTaskId, id) }}
            onEditQueued={(id, text) => { taskQueue.edit(currentLocalTaskId, id, text) }}
            onResumeQueue={() => { taskQueue.resume(currentLocalTaskId) }}
            onPauseQueue={() => { taskQueue.pause(currentLocalTaskId) }}
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
            messages={messages}
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
            onSelectRecentDirectory={(path) => void addLocalDirectory(path)}
            onPasteFiles={pasteFiles}
            pastingAttachments={pastingAttachments}
            modelMenuOpen={modelMenuOpen}
            modelPickerRef={modelPickerRef}
            models={bootstrap?.models ?? []}
            onAddKnowledge={addKnowledgeContext}
            onAddLocalDirectory={() => void addLocalDirectory()}
            onAddLocalFiles={() => void addLocalFiles()}
            onApprovalDecision={async (approvalId, decision) => {
              const taskId = currentLocalTaskIdRef.current
              if (!taskId) throw new Error('当前任务不可用，请重新打开任务。')
              const accepted = await respondHarnessApproval(taskId, approvalId, decision)
              if (!accepted) throw new Error('该操作确认已失效，请重新执行任务。')
            }}
            onCancel={() => void cancelCurrentTask()}
            onContinueCreation={(instructions) => {
              if (!creationKind) return
              setAuthoringInstructions(instructions)
              setAuthoringKind(creationKind)
            }}
            onPrepareRetry={prepareRetry}
            onPrompt={setPrompt}
            onReconnect={() => setConnectionAttempt((value) => value + 1)}
            onRecoverHarness={recoverHarness}
            onRemoveKnowledge={removeKnowledgeContext}
            onRemoveLocalDirectory={(id) => void removeLocalDirectory(id)}
            onRemoveAttachment={(id) => setPendingAttachments((current) => current.filter((item) => item.id !== id))}
            onSelectModel={selectModel}
            onSubmit={(event) => void submit(event)}
            onToggleModelMenu={() => setModelMenuOpen((value) => !value)}
            prompt={prompt}
            runtimeStatus={runtimeStatus}
            selectedKnowledgeBaseRefs={selectedKnowledgeBaseRefs}
            taskMonitor={taskMonitor}
            taskContextRestoring={taskContextRestoring}
          />
        ) : (
          <section className="capability-page" key={`${page}-${capabilityKind}`}>
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
                    ? '调整阅读偏好，管理个人记忆、附件存储与应用更新。'
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
            {extensionSyncIssues.length > 0 && <div className="sync-diagnostics"><div><CircleStop size={17} /><span><strong>部分企业能力需要处理，其他能力仍可使用</strong><small>{extensionSyncedAt ? `最近检查 ${extensionSyncedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '刚刚完成检查'}</small></span><button onClick={refreshEnterpriseCatalog} type="button">重新检查</button></div><details><summary>查看 {extensionSyncIssues.length} 项详情</summary>{extensionSyncIssues.map((issue) => <p key={issue.key}><strong>{issue.label}</strong><span>{issue.message}</span>{issue.removable && <button onClick={() => void cleanBrokenExtension(issue.label)} type="button">移除损坏项</button>}</p>)}</details></div>}
            {catalogCacheSavedAt && extensionSyncIssues.some((issue) => !issue.key.startsWith('local-extension:')) && <div className="catalog-cache-state"><ShieldCheck size={15} /><span>当前使用本机缓存，可继续执行 · {new Date(catalogCacheSavedAt).toLocaleString('zh-CN', { hour12: false })}</span></div>}
            {page === 'settings' && bootstrap && user && <DesktopSettingsPage
              accessToken={accessToken}
              companyName={user.companyName}
              department={user.department}
              displayName={user.displayName}
              employeeId={user.userId}
              memoryEndpoint={bootstrap.endpoints.memoryProfile ?? '/api/v1/memory-profile'}
              onMemorySaved={memorySaved}
              onOpenMemoryTask={(id) => void openStoredTask(id)}
              position={user.position}
            />}
            {page === 'skills' && <CapabilityCatalogPage onChanged={refreshInstalledKits} onUseSkill={(id) => startNewTask(`/skill:${id} `)} kind={capabilityKind} onCreate={() => createWithXiaoyin(capabilityKind === 'packs' ? 'expert-kit' : 'skill')} category={extensionCategory} error={expertKitError} expertKits={expertKits} filter={extensionFilter} installingKitId={installingKitId} loading={expertKitsLoading} onCategory={setExtensionCategory} onFilter={(value) => { setExtensionFilter(value); setExtensionCategory('all') }} onOpenExpertKit={setActiveExpertKitId} onOpenSkill={setActiveSkillId} skills={skillViews} visibleExpertKits={visibleExpertKits} visibleSkills={visibleSkillViews} />}
            {page === 'connectors' && <>
              <ConnectorsPage
                catalog={connectors}
                catalogError={expertKitError}
                loading={expertKitsLoading}
                runtime={runtimeConnectors}
                syncError=""
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
                  const [result] = await diagnoseConnectors({ accessToken, connectors: [{ ...connector, enabled: true }] })
                  return result
                }}
              />
            </>}
            {page === 'knowledge' && bootstrap && user && <KnowledgeBasePage key={`${user.userId}:${bootstrap.endpoints.knowledge}`}
              onChanged={refreshEnterpriseCatalog}
              accessToken={accessToken}
              employeeId={user.userId}
              teamId={user.teamId}
              endpoint={bootstrap.endpoints.knowledge}
            />}
            {page === 'schedules' && bootstrap && user && <ScheduledTasksPage
              key={user.userId}
              models={bootstrap.models}
              onCreateWithXiaoyin={() => createWithXiaoyin('schedule')}
              local={localSchedules}
              onOpenLocalTask={(id) => { void openStoredTask(id) }}
            />}
            {page === 'im' && bootstrap && user && <ImChannelsPage
              key={user.userId}
              selectedConversationKey={imConversationKey}
              onSelectConversation={setImConversationKey}
              accessToken={accessToken}
              employeeId={user.userId}
              teamId={user.teamId}
              connectors={runtimeConnectors}
              allowedArtifacts={allowedArtifacts}
              litellmBaseUrl={bootstrap.endpoints.litellm}
              knowledgeEndpoint={resolveServerEndpoint(bootstrap.endpoints.knowledge)}
              scheduleEndpoint={localScheduleNamespace()}
              model={activeModel}
              modelApiKey={bootstrap.modelApiKey}
              localTasks={localTasks}
            />}
          </section>
        ))}
      {activeExpertKit && <ExpertKitDetailsModal
        onChanged={refreshInstalledKits}
        kit={activeExpertKit}
        skills={skills}
        connectors={connectors}
        knowledgeBases={knowledgeBases}
        installing={installingKitId === activeExpertKit.id}
        removing={(developerKitBusy && activeExpertKit.localOnly) || removingCatalogId === activeExpertKit.id}
        onClose={() => setActiveExpertKitId('')}
        onInstall={() => void installKit(activeExpertKit)}
        onRemove={activeExpertKit.localOnly
          ? () => void removeLocalAcceptanceKit(activeExpertKit)
          : activeExpertKit.installed ? () => void removeCatalogArtifact('expert-kit', activeExpertKit.id) : undefined}
        onSchedule={() => { setActiveExpertKitId(''); setPage('schedules') }}
        onUse={activeExpertKit.installed?.enabled !== false && ['installed', 'update'].includes(activeExpertKit.installState) ? (command) => { setActiveExpertKitId(''); startNewTask(`/kit:${activeExpertKit.id}${command ? `:${command}` : ''} `) } : undefined}
        onConfigureConnectors={() => { setActiveExpertKitId(''); setExtensionQuery(''); setPage('connectors') }}
        onCustomize={['installed', 'update'].includes(activeExpertKit.installState) ? () => void customizeLocalExpertKit(activeExpertKit) : undefined}
        onExport={['installed', 'update'].includes(activeExpertKit.installState) ? () => void exportLocalExpertKit(activeExpertKit) : undefined}
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
        onUse={activeSkill.installed?.enabled !== false && ['installed', 'update'].includes(activeSkill.installState) ? () => { setActiveSkillId(''); startNewTask(`/skill:${activeSkill.id} `) } : undefined}
        onCustomize={activeSkill.installed ? () => void customizeLocalExpertKit(activeSkill, 'skill') : undefined}
        onExport={activeSkill.installed ? () => void exportLocalExpertKit(activeSkill, 'skill') : undefined}
        onRemove={activeSkill.installed ? () => void removeCatalogArtifact('skill', activeSkill.id) : undefined}
      />}
      </main>
      {uploadKind && <ExtensionUploadDialog kind={uploadKind} onClose={() => setUploadKind(undefined)} onInstall={(path) => installLocalExtension(uploadKind, 'archive', path)} />}
      {authoringKind === 'connector' && user && <McpConnectorDialog initial={editingConnector ? { ...editingConnector, ...connectorSecrets[editingConnector.id] } : undefined} existingIds={connectors.map((item) => item.id)} onClose={() => { setAuthoringKind(undefined); setEditingConnector(undefined) }} onSave={(connector) => persistPersonalConnector(connector, !editingConnector)} />}
      {authoringKind && authoringKind !== 'connector' && user && <ExtensionAuthoringModal
        accessToken={accessToken}
        connectors={connectors}
        connectorSecrets={connectorSecrets}
        employeeId={user.userId}
        initialKind={authoringKind}
        initialInstructions={authoringInstructions}
        initialConnector={editingConnector}
        onClose={() => { setAuthoringKind(undefined); setAuthoringInstructions(''); setEditingConnector(undefined) }}
        onPreviewRunningChange={() => undefined}
        previewConfig={runningTaskIds.length < 3 && runtimeStatus === 'ready' && bootstrap ? {
          employeeId: user.userId,
          teamId: user.teamId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveServerEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: localScheduleNamespace(),
          connectors: runtimeConnectors,
          allowedArtifacts,
          model: activeModel,
          modelApiKey: bootstrap.modelApiKey,
          accessToken,
          localFileRootIds: localDirectories.map((directory) => directory.id),
        } : undefined}
        previewUnavailableReason={runningTaskIds.length >= 3 ? '已有 3 个本地任务并行运行，请等待一个任务完成后再试运行。' : runtimeStatus !== 'ready' ? '企业服务尚未连接，暂时不能试运行。' : undefined}
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
