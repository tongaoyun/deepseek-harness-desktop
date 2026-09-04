import {
  BookOpenCheck,
  Boxes,
  CircleStop,
  FolderOpen,
  PlugZap,
  ShieldCheck,
  WandSparkles,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  createExpertKitDownload,
  createSkillDownload,
  loadBootstrap,
  resolveControlPlaneEndpoint,
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
  type ExpertKitView,
} from './expertKits'
import {
  authorizeLocalDirectory,
  authorizeLocalFiles,
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
  BootstrapResponse,
  LocalTaskAttachment,
  RuntimeStatus,
} from './types'
import { useEnterpriseSession } from './useEnterpriseSession'
import { ScheduledTasksPage } from './ScheduledTasksPage'
import { ImChannelsPage } from './ImChannelsPage'
import { loadTaskHistory, persistTaskHistory, removeTaskHistory } from './taskHistory'
import { resolveHarnessSessionId } from './harnessSession'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import { startLocalIm, stopLocalImRuntime } from './localIm'
import type { LocalTaskRun, TaskMessage, TaskMonitorState } from './types'
import { memoryInstruction, rememberInstruction } from './memory'
import { modelStorageKey, resolveSelectedModel } from './modelSelection'
import { needsLocalDirectoryAuthorization, standardLocalDirectories } from './localFileIntent'
import { creationPrompt, type XiaoyinCreationKind } from './creationPrompts'
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
import { connectorsForSnapshot, createCapabilitySnapshot } from './capabilitySnapshot'
import { DesktopSidebar } from './DesktopSidebar'
import { ChatPage } from './ChatPage'
import { extensionMatches, type ExtensionFilter } from './ExtensionToolbar'
import type { ExtensionCategoryFilter } from './extensionCategories'
import { ExpertCatalogPage, SkillCatalogPage } from './ExtensionCatalogPages'
import { ExtensionAuthoringModal } from './ExtensionAuthoringModal'
import { savePersonalConnector, type ExtensionKind } from './extensionSubmissions'
import { ExtensionPageActions } from './ExtensionPageActions'
import { useEnterpriseCatalog } from './useEnterpriseCatalog'
import { useDesktopDialog } from './DesktopDialog'
import { retryingTaskMonitor, runHarnessWithRecovery } from './taskRecovery'
import { useHarnessHealth } from './useHarnessHealth'
import { useDeviceHeartbeat } from './useDeviceHeartbeat'
import { reportTaskAudit } from './taskAudit'
import { useDesktopDrop } from './useDesktopDrop'
import { useLocalImSync } from './useLocalImSync'
import { useHarnessNotifications, type StreamingTaskState } from './useHarnessNotifications'
import './styles.css'

const extensionNav = [
  { id: 'experts', label: '专家套件', icon: Boxes },
  { id: 'skills', label: '技能', icon: WandSparkles },
  { id: 'connectors', label: '连接器', icon: PlugZap },
  { id: 'knowledge', label: '知识库', icon: BookOpenCheck },
]

export default function App() {
  const { confirm: confirmAction, dialog: confirmationDialog, notify, toast } = useDesktopDialog()
  const { accessToken, authorizing, error: authError, logout, reopen, state: authState, user } = useEnterpriseSession()
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>()
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>('connecting')
  const [prompt, setPrompt] = useState('')
  const [page, setPage] = useState('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [messages, setMessages] = useState<TaskMessage[]>([])
  const [localTasks, setLocalTasks] = useState<LocalTaskRun[]>([])
  const [currentLocalTaskId, setCurrentLocalTaskId] = useState('')
  const [authoringKind, setAuthoringKind] = useState<ExtensionKind>()
  const [authoringInstructions, setAuthoringInstructions] = useState('')
  const [creationKind, setCreationKind] = useState<'expert-kit' | 'skill'>()
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
  const [installingKitId, setInstallingKitId] = useState('')
  const [installingSkillId, setInstallingSkillId] = useState('')
  const [removingCatalogId, setRemovingCatalogId] = useState('')
  const [activeExpertKitId, setActiveExpertKitId] = useState('')
  const [activeSkillId, setActiveSkillId] = useState('')
  const [selectedExpertKitId, setSelectedExpertKitId] = useState('')
  const [harnessSessionId, setHarnessSessionId] = useState('')
  const [currentCapabilitySnapshot, setCurrentCapabilitySnapshot] = useState<import('./types').CapabilitySnapshot>()
  const [selectedKnowledgeBaseRefs, setSelectedKnowledgeBaseRefs] = useState<string[]>([])
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
  const [localFileError, setLocalFileError] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [taskSearchOpen, setTaskSearchOpen] = useState(false)
  const [taskQuery, setTaskQuery] = useState('')
  const [connectionAttempt, setConnectionAttempt] = useState(0)
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
  const taskContextRestoreIdRef = useRef(0)
  const enabledConnectorIdsRef = useRef<string[]>([])
  const allowedArtifacts = useMemo(
    () => allowedExtensionArtifacts(expertKitCatalog, skills),
    [expertKitCatalog, skills],
  )
  const runtimeConnectors = useMemo(() => buildRuntimeConnectorCatalog(
    connectors, bootstrap?.endpoints.erpMcp ?? '', enabledConnectorIds, connectorSecrets,
  ), [bootstrap?.endpoints.erpMcp, connectorSecrets, connectors, enabledConnectorIds])
  const activeModel = selectedModel || bootstrap?.models[0] || 'deepseek-v4-flash'
  const localImContext = useMemo(() => bootstrap && user ? {
    employeeId: user.userId,
    teamId: user.teamId,
    litellmBaseUrl: bootstrap.endpoints.litellm,
    knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
    scheduleEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.schedules),
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
  const currentTaskRunning = Boolean(currentLocalTaskId && runningTaskIds.includes(currentLocalTaskId))
  const dragActive = useDesktopDrop({
    enabled: authState === 'authenticated' && connectorDiagnosticsAvailable(),
    running: currentTaskRunning,
    onAuthorized: ({ directories, attachments }) => {
      setLocalDirectories((current) => [...current, ...directories.filter((next) => !current.some((item) => item.id === next.id))])
      setPendingAttachments((current) => [...current, ...attachments.filter((next) => !current.some((item) => item.id === next.id))].slice(0, 16))
      setHarnessSessionId('')
      focusComposer()
    },
    onError: setLocalFileError,
  })
  const sendDeviceHeartbeat = useDeviceHeartbeat({
    accessToken,
    authenticated: authState === 'authenticated',
    bootstrap,
    employeeId: user?.userId,
    expertKits: expertKitCatalog,
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

  useEffect(() => {
    if (!['experts', 'skills', 'connectors'].includes(page)) return
    setExtensionQuery('')
    setExtensionFilter('market')
    setExtensionCategory('all')
  }, [page])

  useEffect(() => {
    if (authState !== 'authenticated' || !user) return
    const controller = new AbortController()
    setRuntimeStatus('connecting')
    loadBootstrap(user.userId, accessToken, controller.signal)
      .then((value) => { setBootstrap(value); setRuntimeStatus('ready') })
      .catch(() => setRuntimeStatus('offline'))
    return () => controller.abort()
  }, [accessToken, authState, connectionAttempt, user])

  useEffect(() => {
    if (!bootstrap || !user) return
    setSelectedModel(resolveSelectedModel(
      bootstrap.models,
      window.localStorage.getItem(modelStorageKey(user.userId)),
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
      setLocalTasks([])
      selectCurrentLocalTaskId('')
      return
    }
    let disposed = false
    void loadTaskHistory(user.userId)
      .then((tasks) => { if (!disposed) setLocalTasks(tasks) })
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
  }, [])

  useEffect(() => {
    if (!modelMenuOpen) return
    const dismiss = (event: MouseEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelMenuOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [modelMenuOpen])

  useEffect(() => {
    const textarea = composerRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.max(83, Math.min(textarea.scrollHeight, 180))}px`
  }, [prompt])

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [page])

  const visibleExpertKits = useMemo(
    () => expertKits.filter((item) => extensionMatches(item, extensionQuery, extensionFilter, extensionCategory)),
    [expertKits, extensionCategory, extensionFilter, extensionQuery],
  )
  const visibleSkillViews = useMemo(
    () => skillViews.filter((item) => extensionMatches(item, extensionQuery, extensionFilter, extensionCategory)),
    [extensionCategory, extensionFilter, extensionQuery, skillViews],
  )

  if (authState !== 'authenticated') {
    return <ErpAuthScreen authorizing={authorizing} checking={authState === 'checking'} error={authError} onReopen={() => void reopen()} />
  }

  const selectedExpertKit = expertKits.find((kit) => kit.id === selectedExpertKitId
    && (kit.installState === 'installed' || kit.installState === 'update'))
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
  const visibleLocalTasks = taskQuery.trim()
    ? localTasks.filter((task) => {
      const query = taskQuery.trim().toLocaleLowerCase()
      return task.name.toLocaleLowerCase().includes(query)
        || task.messages.some((message) => message.text.toLocaleLowerCase().includes(query))
    })
    : localTasks
  const focusComposer = () => window.requestAnimationFrame(() => composerRef.current?.focus())
  const setTaskMonitorActivity = (activity: string) => {
    const next = { ...taskMonitorRef.current, activity, updatedAt: new Date().toISOString() }
    taskMonitorRef.current = next
    setTaskMonitor(next)
  }
  const startNewTask = (initialPrompt = '', nextCreationKind?: 'expert-kit' | 'skill') => {
    taskContextRestoreIdRef.current += 1
    setTaskContextRestoring(false)
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setMessages([])
    setPrompt(initialPrompt)
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
    setSelectedKnowledgeBaseRefs([])
    setSelectedExpertKitId('')
    selectCurrentLocalTaskId('')
    setCreationKind(nextCreationKind)
    setPendingAttachments([])
    const monitor = createTaskMonitor()
    taskMonitorRef.current = monitor
    setTaskMonitor(monitor)
    setLocalDirectories([])
    setLocalFileError('')
    void clearLocalDirectories()
    focusComposer()
  }
  const newTask = () => startNewTask()
  const createWithXiaoyin = (kind: XiaoyinCreationKind) => startNewTask(
    creationPrompt(kind), kind === 'schedule' ? undefined : kind,
  )
  const persistLocalTask = (task: LocalTaskRun) => {
    if (!user) return
    setLocalTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 200))
    void persistTaskHistory(user.userId, task)
      .catch((reason) => setLocalFileError(reason instanceof Error ? reason.message : String(reason)))
  }
  const openLocalTask = (task: LocalTaskRun) => {
    const restoreId = taskContextRestoreIdRef.current + 1
    const streaming = streamingTasksRef.current.get(task.id)
    taskContextRestoreIdRef.current = restoreId
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setMessages(streaming?.messages ?? task.messages.map((message) => ({ ...message, pending: false })))
    selectCurrentLocalTaskId(task.id)
    setCreationKind(undefined)
    setHarnessSessionId(task.sessionId ?? '')
    setCurrentCapabilitySnapshot(task.capabilitySnapshot)
    setSelectedKnowledgeBaseRefs(task.capabilitySnapshot?.knowledgeBaseRefs ?? [])
    setSelectedExpertKitId(task.expertKitId ?? '')
    setSelectedModel(resolveSelectedModel(bootstrap?.models ?? [], task.model ?? selectedModel))
    setPrompt('')
    setPendingAttachments([])
    taskMonitorRef.current = streaming?.monitor ?? task.monitor
    setTaskMonitor(streaming?.monitor ?? task.monitor)
    setLocalDirectories([])
    setLocalFileError('')
    const paths = (task.localDirectories ?? []).flatMap((directory) => directory.path ? [directory.path] : [])
    setTaskContextRestoring(paths.length > 0)
    void clearLocalDirectories().then(async () => {
      if (paths.length === 0) return
      try {
        const restored = await restoreLocalDirectories(paths)
        if (taskContextRestoreIdRef.current !== restoreId) return
        setLocalDirectories(restored)
        if (restored.length < paths.length) setLocalFileError('部分历史工作目录已移动或不可用，请重新添加。')
      } catch (reason) {
        if (taskContextRestoreIdRef.current !== restoreId) return
        setLocalFileError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (taskContextRestoreIdRef.current === restoreId) setTaskContextRestoring(false)
    })
    focusComposer()
  }
  const addLocalDirectory = async () => {
    setLocalFileError('')
    try {
      const authorization = await authorizeLocalDirectory()
      if (!authorization) return
      setLocalDirectories((current) => current.some((item) => item.id === authorization.id)
        ? current
        : [...current, authorization])
      setHarnessSessionId('')
    } catch (error) {
      setLocalFileError(error instanceof Error ? error.message : String(error))
    }
  }
  const addLocalFiles = async () => {
    setLocalFileError('')
    try {
      const { attachments } = await authorizeLocalFiles()
      setPendingAttachments((current) => [
        ...current,
        ...attachments.filter((next) => !current.some((item) => item.id === next.id)),
      ].slice(0, 16))
      focusComposer()
    } catch (error) {
      setLocalFileError(error instanceof Error ? error.message : String(error))
    }
  }
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

  const submitDesktopFeedback = async (message: string) => {
    if (!bootstrap || !user) throw new Error('企业服务尚未连接')
    await submitFeedback(user.userId, accessToken, message.slice(0, 400))
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const messageAttachments = pendingAttachments
    const input = prompt.trim() || (messageAttachments.length > 0 ? '请查看并处理这些附件。' : '')
    if (!input || !bootstrap || runtimeStatus !== 'ready' || currentTaskRunning) return
    if (taskContextRestoring) {
      setLocalFileError('正在恢复该任务的工作目录，请稍候。')
      return
    }
    const remembered = messageAttachments.length === 0 ? memoryInstruction(input) : undefined
    if (remembered) {
      setPrompt('')
      if (!await confirmAction({ title: '保存为长期记忆？', message: remembered, confirmLabel: '保存' })) {
        setMessages((current) => [...current, { role: 'user', text: input }, { role: 'assistant', text: '未保存到长期记忆。' }])
        return
      }
      try {
        await rememberInstruction(user!.userId, bootstrap.endpoints.memoryProfile ?? '/api/v1/memory-profile', accessToken, remembered)
        const rememberedMessages: TaskMessage[] = [{ role: 'user', text: input }, { role: 'assistant', text: `已记住：${remembered}` }]
        const timestamp = new Date().toISOString()
        const monitor: TaskMonitorState = { ...createTaskMonitor(timestamp), status: 'completed', activity: '记忆已保存' }
        const task: LocalTaskRun = { id: crypto.randomUUID(), source: 'DESKTOP', name: input.slice(0, 60),
          status: 'COMPLETED', createdAt: timestamp, updatedAt: timestamp, monitor, messages: rememberedMessages }
        setMessages(rememberedMessages)
        taskMonitorRef.current = monitor
        setTaskMonitor(monitor)
        persistLocalTask(task)
      } catch (error) {
        setMessages([{ role: 'user', text: input }, { role: 'assistant', text: `记忆失败：${error instanceof Error ? error.message : String(error)}` }])
      }
      return
    }
    let taskDirectories = localDirectories
    const taskSessionId = harnessSessionId
    let resetSessionForDirectoryChange = false
    const standardDirectories = standardLocalDirectories(input)
    if (standardDirectories.length > 0) {
      setLocalFileError('')
      try {
        const authorizations = await authorizeStandardLocalDirectories(standardDirectories)
        const additions = authorizations.filter((next) => !taskDirectories.some((item) => item.id === next.id))
        taskDirectories = [...taskDirectories, ...additions]
        setLocalDirectories(taskDirectories)
        if (additions.length > 0) {
          resetSessionForDirectoryChange = true
          setHarnessSessionId('')
        }
      } catch (error) {
        setLocalFileError(error instanceof Error ? error.message : String(error))
        return
      }
    } else if (taskDirectories.length === 0 && needsLocalDirectoryAuthorization(input)) {
      setLocalFileError('请先在输入框下方选择工作目录，任务内容已保留。')
      return
    }
    const now = new Date().toISOString()
    const capabilitySnapshot = currentCapabilitySnapshot
      ?? createCapabilitySnapshot(expertKits, skillViews, runtimeConnectors, selectedKnowledgeBaseRefs, now)
    if (!currentCapabilitySnapshot) setCurrentCapabilitySnapshot(capabilitySnapshot)
    const taskId = currentLocalTaskId || crypto.randomUUID()
    const existingTask = localTasks.find((task) => task.id === taskId)
    const sessionWasExplicitlyInvalidated = !taskSessionId && Boolean(existingTask?.sessionId)
    const mustStartFreshSession = resetSessionForDirectoryChange
      || sessionWasExplicitlyInvalidated
      || taskMonitorRef.current.status === 'failed'
    const rootSessionId = resolveHarnessSessionId(
      taskSessionId,
      existingTask?.sessionId,
      mustStartFreshSession,
      () => `session-${crypto.randomUUID().replaceAll('-', '')}`,
    )
    const harnessPrompt = harnessPromptWithConversationReplay(input, messages, mustStartFreshSession)
    const pendingMessages: TaskMessage[] = [...messages, { role: 'user', text: input, ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}) },
      { role: 'assistant', text: '', pending: true }]
    const runningMonitor: TaskMonitorState = {
      ...createTaskMonitor(now),
      status: 'running',
      activity: '正在启动本地 Agent',
      updatedAt: now,
      startedAt: now,
    }
    const runningTask: LocalTaskRun = {
      id: taskId,
      source: 'DESKTOP',
      name: existingTask?.name ?? input.slice(0, 60),
      status: 'RUNNING',
      createdAt: existingTask?.createdAt ?? now,
      updatedAt: now,
      sessionId: rootSessionId,
      expertKitId: selectedExpertKit?.id,
      model: activeModel,
      localDirectories: taskDirectories,
      capabilitySnapshot,
      monitor: runningMonitor,
      messages: pendingMessages,
    }
    selectCurrentLocalTaskId(taskId)
    setHarnessSessionId(rootSessionId)
    setMessages(pendingMessages)
    persistLocalTask(runningTask)
    setPrompt('')
    setPendingAttachments([])
    const streaming: StreamingTaskState = {
      monitor: runningMonitor,
      messages: pendingMessages,
      responseKey: '',
      cancellationRequested: false,
    }
    streamingTasksRef.current.set(taskId, streaming)
    setRunningTaskIds((current) => current.includes(taskId) ? current : [...current, taskId])
    taskMonitorRef.current = runningMonitor
    setTaskMonitor(runningMonitor)
    let executionSessionId = rootSessionId
    try {
      const result = await runHarnessWithRecovery({
        taskId,
        prompt: harnessPrompt,
        employeeId: user!.userId,
        teamId: user!.teamId,
        sessionId: rootSessionId,
        ...(selectedExpertKit
          ? { selectedExtension: { kind: 'expert-kit' as const, id: selectedExpertKit.id } }
          : {}),
        litellmBaseUrl: bootstrap.endpoints.litellm,
        knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
        scheduleEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.schedules),
        connectors: connectorsForSnapshot(capabilitySnapshot, connectorSecrets, enabledConnectorIdsRef.current),
        allowedArtifacts: capabilitySnapshot.extensions,
        knowledgeBaseRefs: capabilitySnapshot.knowledgeBaseRefs,
        model: activeModel,
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
      if (!result.finalResponse.trim()) throw new Error('模型本轮没有返回可显示文本，请重试')
      const completedAt = new Date().toISOString()
      const completedMonitor: TaskMonitorState = {
        ...streaming.monitor, status: 'completed', activity: '任务已完成', updatedAt: completedAt,
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
      await reportTaskAudit({
        accessToken,
        employeeId: user!.userId,
        endpoint: bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events',
        outcome: 'SUCCEEDED',
        taskId,
      })
    } catch (error) {
      const failure = classifyHarnessFailure(error)
      const message = failure.message
      const canceled = streaming.cancellationRequested
      const completedAt = new Date().toISOString()
      const failedMonitor: TaskMonitorState = {
        ...streaming.monitor,
        status: canceled ? 'canceled' : 'failed',
        activity: canceled ? '任务已取消' : '任务执行失败',
        updatedAt: completedAt,
        completedAt,
        failure: { code: failure.code, category: failure.category, detail: message.slice(0, 500) },
      }
      const failedMessages = streaming.messages.map((item, index) => index === streaming.messages.length - 1
        ? { role: 'assistant', text: canceled ? '任务已取消，可修改要求后重新执行。' : `${failure.title}：${message}\n\n错误编号：${failure.code}`, monitor: failedMonitor }
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
      if (canceled || infrastructureFailure) void shutdownHarness(taskId)
      await reportTaskAudit({
        accessToken,
        employeeId: user!.userId,
        endpoint: bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events',
        outcome: 'FAILED',
        taskId,
      })
    } finally {
      streamingTasksRef.current.delete(taskId)
      setRunningTaskIds((current) => current.filter((id) => id !== taskId))
    }
  }

  const cancelCurrentTask = async () => {
    const taskId = currentLocalTaskIdRef.current
    const streaming = streamingTasksRef.current.get(taskId)
    if (!streaming || streaming.cancellationRequested) return
    streaming.cancellationRequested = true
    setTaskMonitorActivity('正在取消当前任务')
    try {
      const canceled = await cancelHarness(taskId)
      if (!canceled) {
        streaming.cancellationRequested = false
        setTaskMonitorActivity('当前任务即将完成，暂时无法取消')
      }
    } catch (reason) {
      streaming.cancellationRequested = false
      setTaskMonitorActivity('取消失败，任务仍在执行')
      setLocalFileError(reason instanceof Error ? reason.message : String(reason))
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
        throw new Error('Skill 目录在安装期间发生变化，请刷新后重试')
      }
      await installExtension(download, 'skill')
      await refreshInstalledKits()
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setInstallingSkillId('')
    }
  }

  const installLocalExtension = async (kind: 'expert-kit' | 'skill') => {
    if (developerKitBusy) return
    setDeveloperKitBusy(true)
    setExpertKitError('')
    try {
      const installed = await installDeveloperExtension(kind)
      if (!installed) return
      await refreshInstalledKits()
      if (kind === 'expert-kit') setActiveExpertKitId(installed.manifest.id)
      else setActiveSkillId(installed.manifest.id)
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeveloperKitBusy(false)
    }
  }

  const customizeLocalExpertKit = async (kit: ExpertKitView) => {
    try {
      const path = await customizeExpertKit(kit.id, kit.installed?.manifest.version ?? kit.version)
      if (path) notify(`定制副本已创建：\n${path}`)
    } catch (error) { setExpertKitError(error instanceof Error ? error.message : String(error)) }
  }

  const exportLocalExpertKit = async (kit: ExpertKitView) => {
    try {
      const path = await exportExpertKit(kit.id, kit.installed?.manifest.version ?? kit.version)
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
      if (selectedExpertKitId === kit.id) {
        setSelectedExpertKitId('')
        setHarnessSessionId('')
      }
      await removeDeveloperExpertKit(kit.id, kit.version)
      setActiveExpertKitId('')
      await refreshInstalledKits()
      if (bootstrap && user) {
        await startLocalIm({
          employeeId: user.userId,
          teamId: user.teamId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.schedules),
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
    const label = kind === 'skill' ? 'Skill' : '专家套件'
    if (!await confirmAction({
      title: `卸载${label}？`,
      message: `将移除所有本地正式版本，历史任务记录不会删除。`,
      confirmLabel: '卸载',
      danger: true,
    })) return
    setRemovingCatalogId(id)
    setExpertKitError('')
    try {
      await Promise.all([shutdownHarness(), stopLocalImRuntime()])
      await removeCatalogExtension(id, kind)
      if (selectedExpertKitId === id) setSelectedExpertKitId('')
      setHarnessSessionId('')
      setActiveExpertKitId('')
      setActiveSkillId('')
      await refreshInstalledKits()
      if (bootstrap && user) {
        await startLocalIm({
          employeeId: user.userId,
          teamId: user.teamId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.schedules),
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

  const useExpertKit = (kit: ExpertKitView) => {
    if (!['installed', 'update'].includes(kit.installState)) return
    if (messages.length > 0) {
      setMessages([])
      selectCurrentLocalTaskId('')
      setSelectedKnowledgeBaseRefs([])
    }
    setSelectedExpertKitId(kit.id)
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
    setPage('chat')
    setPrompt('')
    setActiveExpertKitId('')
    focusComposer()
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

  const selectChatCapability = (id: string) => {
    const kit = expertKits.find((item) => item.id === id && ['installed', 'update'].includes(item.installState))
    if (kit) {
      setSelectedExpertKitId(kit.id)
      setHarnessSessionId('')
      setCurrentCapabilitySnapshot(undefined)
      if (currentLocalTaskId) void shutdownHarness(currentLocalTaskId)
      focusComposer()
      return
    }
    setSelectedExpertKitId('')
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
    if (currentLocalTaskId) void shutdownHarness(currentLocalTaskId)
    focusComposer()
  }

  const memorySaved = async () => {
    setHarnessSessionId('')
    await stopLocalImRuntime()
    if (bootstrap) {
      await startLocalIm({
        employeeId: user!.userId,
        teamId: user!.teamId,
        litellmBaseUrl: bootstrap.endpoints.litellm,
        knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
        scheduleEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.schedules),
        connectors: runtimeConnectors,
        allowedArtifacts,
        model: activeModel,
        modelApiKey: bootstrap.modelApiKey,
        accessToken,
      }).catch(() => undefined)
    }
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {dragActive && <div className="file-drop-overlay"><FolderOpen size={34} /><strong>松开即可添加到当前任务</strong><span>文件只会在本次任务授权的目录内使用</span></div>}
      <DesktopSidebar
        collapsed={sidebarCollapsed}
        onCloseSearch={() => { setTaskSearchOpen(false); setTaskQuery('') }}
        onFeedback={submitDesktopFeedback}
        onLogout={logoutWithCleanup}
        onNewTask={newTask}
        onOpenTask={openLocalTask}
        onArchiveTask={(task, archived) => {
          if (task.status === 'RUNNING') return
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
              setLocalTasks((current) => current.filter((item) => item.id !== task.id))
              if (currentLocalTaskIdRef.current === task.id) newTask()
            }).catch((reason) => setLocalFileError(reason instanceof Error ? reason.message : String(reason)))
        }}
        onRenameTask={(task, name) => {
          const normalized = name.trim().slice(0, 120)
          if (!normalized || normalized === task.name) return
          persistLocalTask({ ...task, name: normalized, updatedAt: new Date().toISOString() })
        }}
        onPage={setPage}
        onTaskQuery={setTaskQuery}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        onToggleSearch={() => { setTaskSearchOpen((value) => !value); setTaskQuery('') }}
        page={page}
        taskQuery={taskQuery}
        taskSearchInputRef={taskSearchInputRef}
        taskSearchOpen={taskSearchOpen}
        tasks={localTasks}
        user={user ?? undefined}
        visibleTasks={visibleLocalTasks}
      />

      <main className="workspace" ref={workspaceRef}>
        {page === 'chat' ? (
          <ChatPage
            activeModel={activeModel}
            capabilityOptions={expertKits.filter((item) => ['installed', 'update'].includes(item.installState)).map((item) => ({ id: item.id, name: item.name, summary: item.summary }))}
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
            modelMenuOpen={modelMenuOpen}
            modelPickerRef={modelPickerRef}
            models={bootstrap?.models ?? []}
            onAddKnowledge={addKnowledgeContext}
            onAddLocalDirectory={() => void addLocalDirectory()}
            onAddLocalFiles={() => void addLocalFiles()}
            onApprovalDecision={(approvalId, decision) => {
              const taskId = currentLocalTaskIdRef.current
              if (!taskId) return
              void respondHarnessApproval(taskId, approvalId, decision).then((accepted) => {
                if (!accepted) setLocalFileError('该操作确认已失效，请重新执行任务。')
              }).catch((reason) => setLocalFileError(reason instanceof Error ? reason.message : String(reason)))
            }}
            onBrowseExpertKits={() => setPage('experts')}
            onCancel={() => void cancelCurrentTask()}
            onContinueCreation={(instructions) => {
              if (!creationKind) return
              setAuthoringInstructions(instructions)
              setAuthoringKind(creationKind)
            }}
            onSelectCapability={selectChatCapability}
            onPrepareRetry={prepareRetry}
            onPrompt={(value) => { setPrompt(value); focusComposer() }}
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
            selectedCapabilityId={selectedExpertKit?.id ?? ''}
            selectedCapabilityName={selectedExpertKit?.name ?? '专家套件'}
            selectedKnowledgeBaseRefs={selectedKnowledgeBaseRefs}
            taskMonitor={taskMonitor}
            taskContextRestoring={taskContextRestoring}
          />
        ) : (
          <section className="capability-page">
            {page !== 'schedules' && <div className="capability-page-heading"><div>
            <h1>{extensionNav.find((item) => item.id === page)?.label ?? ({ settings: '桌面设置', schedules: '定时任务', im: 'IM 频道' } as Record<string, string>)[page]}</h1>
            <p>{page === 'experts'
              ? '专家套件提供面向角色或行业的完整工作方式，可在新任务的工作模式菜单中选择。'
              : page === 'skills'
                ? '安装后的技能由小胤根据任务自动调用，无需在聊天中手动选择。'
                  : page === 'connectors'
                    ? '连接外部应用、日历与服务，让你的工作流更顺畅。'
                  : page === 'knowledge'
                    ? '集中管理公司资料，搜索内容，并让小胤在回答中引用原文。'
                  : page === 'im'
                    ? '把钉钉等公司消息入口连接到本机小胤 Harness，集中查看连接和处理状态。'
                  : page === 'settings'
                    ? '管理企业身份、个人记忆、快捷键与应用更新。'
                    : '这里将由控制中心下发公司自己的能力配置。'}</p></div>{(page === 'experts' || page === 'skills' || page === 'connectors') && <ExtensionPageActions
              loading={expertKitsLoading}
              onCreate={() => {
                if (page === 'experts' || page === 'skills') createWithXiaoyin(page === 'experts' ? 'expert-kit' : 'skill')
                else {
                  setAuthoringInstructions('')
                  setAuthoringKind('connector')
                }
              }}
              onImportConnector={(connector) => {
                if (!user) return
                void (async () => {
                  const values = connectorSecretValues(connector)
                  const template = connectorSecretTemplate(connector)
                  savePersonalConnector(user.userId, connector)
                  setConnectorSecrets(await saveConnectorSecrets(user.userId, connector.id, values))
                  const next = [template, ...connectors.filter((item) => item.id !== connector.id)]
                  replaceConnectors(next)
                  setEnabledConnectorIds((current) => saveEnabledConnectorIds(user.userId, [...new Set([...current, connector.id])]))
                })().catch((reason) => setLocalFileError(reason instanceof Error ? reason.message : String(reason)))
              }}
              onQuery={setExtensionQuery}
              onRefresh={refreshEnterpriseCatalog}
              onUpload={() => void installLocalExtension(page === 'skills' ? 'skill' : 'expert-kit')}
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
              position={user.position}
            />}
            {page === 'experts' && <ExpertCatalogPage all={expertKits} category={extensionCategory} error={expertKitError} filter={extensionFilter} installingId={installingKitId} loading={expertKitsLoading} onCategory={setExtensionCategory} onFilter={setExtensionFilter} onOpen={setActiveExpertKitId} visible={visibleExpertKits} />}
            {page === 'skills' && <SkillCatalogPage all={skillViews} category={extensionCategory} error={expertKitError} filter={extensionFilter} loading={expertKitsLoading} onCategory={setExtensionCategory} onFilter={setExtensionFilter} onOpen={setActiveSkillId} visible={visibleSkillViews} />}
            {page === 'connectors' && <>
              <ConnectorsPage
                catalog={connectors}
                catalogError={expertKitError}
                loading={expertKitsLoading}
                runtime={runtimeConnectors}
                syncError=""
                query={extensionQuery}
                onToggle={toggleConnector}
                secrets={connectorSecrets}
                onSaveSecrets={(connectorId, values) => {
                  if (!user) return
                  void saveConnectorSecrets(user.userId, connectorId, values)
                    .then(setConnectorSecrets)
                    .catch((reason) => setLocalFileError(reason instanceof Error ? reason.message : String(reason)))
                }}
                onDiagnose={async (connectorId) => {
                  const connector = runtimeConnectors.find((item) => item.id === connectorId)
                  if (!connector || !connectorDiagnosticsAvailable()) return undefined
                  const hydrated = connectorsForSnapshot({
                    createdAt: new Date().toISOString(), extensions: [], knowledgeBaseRefs: [],
                    connectors: [{ ...connector, enabled: true }],
                  }, connectorSecrets)
                  const [result] = await diagnoseConnectors({ accessToken, connectors: hydrated })
                  return result
                }}
              />
            </>}
            {page === 'knowledge' && bootstrap && user && <KnowledgeBasePage
              accessToken={accessToken}
              employeeId={user.userId}
              teamId={user.teamId}
              endpoint={bootstrap.endpoints.knowledge}
            />}
            {page === 'schedules' && bootstrap && user && <ScheduledTasksPage
              accessToken={accessToken}
              employeeId={user.userId}
              endpoint={bootstrap.endpoints.schedules}
              onCreateWithXiaoyin={() => createWithXiaoyin('schedule')}
            />}
            {page === 'im' && bootstrap && user && <ImChannelsPage
              accessToken={accessToken}
              employeeId={user.userId}
              teamId={user.teamId}
              connectors={runtimeConnectors}
              allowedArtifacts={allowedArtifacts}
              litellmBaseUrl={bootstrap.endpoints.litellm}
              knowledgeEndpoint={resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge)}
              scheduleEndpoint={resolveControlPlaneEndpoint(bootstrap.endpoints.schedules)}
              model={activeModel}
              modelApiKey={bootstrap.modelApiKey}
              localTasks={localTasks}
            />}
          </section>
        )}
      </main>
      {authoringKind && user && <ExtensionAuthoringModal
        accessToken={accessToken}
        connectors={connectors}
        connectorSecrets={connectorSecrets}
        employeeId={user.userId}
        initialKind={authoringKind}
        initialInstructions={authoringInstructions}
        onClose={() => { setAuthoringKind(undefined); setAuthoringInstructions('') }}
        onPreviewRunningChange={() => undefined}
        previewConfig={runningTaskIds.length < 3 && runtimeStatus === 'ready' && bootstrap ? {
          employeeId: user.userId,
          teamId: user.teamId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
          scheduleEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.schedules),
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
            const connector = change.connector
            setConnectorSecrets(await saveConnectorSecrets(user.userId, connector.id, change.secrets))
            const next = [connector, ...connectors.filter((item) => item.id !== connector.id)]
            replaceConnectors(next)
            setEnabledConnectorIds((current) => {
              const enabled = saveEnabledConnectorIds(user.userId, [...current, connector.id])
              enabledConnectorIdsRef.current = enabled
              return enabled
            })
          } else if (change.type === 'connector-delete') {
            setConnectorSecrets(await deleteConnectorSecrets(user.userId, change.id))
            const next = connectors.filter((item) => item.id !== change.id)
            replaceConnectors(next)
            setEnabledConnectorIds((current) => {
              const enabled = saveEnabledConnectorIds(user.userId, current.filter((id) => id !== change.id))
              enabledConnectorIdsRef.current = enabled
              return enabled
            })
          } else await refreshInstalledKits()
        }}
      />}
      {activeExpertKit && <ExpertKitDetailsModal
        kit={activeExpertKit}
        skills={skills}
        connectors={connectors}
        knowledgeBases={knowledgeBases}
        installing={installingKitId === activeExpertKit.id}
        removing={(developerKitBusy && activeExpertKit.localOnly) || removingCatalogId === activeExpertKit.id}
        selected={selectedExpertKitId === activeExpertKit.id}
        onClose={() => setActiveExpertKitId('')}
        onInstall={() => void installKit(activeExpertKit)}
        onRemove={activeExpertKit.localOnly
          ? () => void removeLocalAcceptanceKit(activeExpertKit)
          : activeExpertKit.installed ? () => void removeCatalogArtifact('expert-kit', activeExpertKit.id) : undefined}
        onSchedule={() => { setActiveExpertKitId(''); setPage('schedules') }}
        onUse={() => useExpertKit(activeExpertKit)}
        onCustomize={['installed', 'update'].includes(activeExpertKit.installState) ? () => void customizeLocalExpertKit(activeExpertKit) : undefined}
        onExport={['installed', 'update'].includes(activeExpertKit.installState) ? () => void exportLocalExpertKit(activeExpertKit) : undefined}
      />}
      {activeSkill && <SkillDetailsModal
        skill={activeSkill}
        connectors={connectors}
        knowledgeBases={knowledgeBases}
        installing={installingSkillId === activeSkill.id}
        removing={removingCatalogId === activeSkill.id}
        onClose={() => setActiveSkillId('')}
        onInstall={() => void installSkill(activeSkill)}
        onRemove={activeSkill.installed ? () => void removeCatalogArtifact('skill', activeSkill.id) : undefined}
      />}
      {confirmationDialog}
      {toast}
    </div>
  )
}
