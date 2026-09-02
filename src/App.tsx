import {
  Bell,
  BookOpenCheck,
  Bot,
  Boxes,
  CalendarClock,
  ChevronDown,
  CirclePlus,
  CircleStop,
  FolderOpen,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PackagePlus,
  Plus,
  PlugZap,
  Search,
  ScrollText,
  Send,
  ShieldCheck,
  Sparkles,
  SquareCheckBig,
  Store,
  WandSparkles,
  X,
} from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { lazy, Suspense, type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  createExpertKitDownload,
  createSkillDownload,
  loadBootstrap,
  loadCloudTaskRuns,
  loadConnectors,
  loadExpertKits,
  loadKnowledgeBases,
  loadSkills,
  resolveControlPlaneEndpoint,
  submitAuditEvent,
  submitFeedback,
  submitDeviceHeartbeat,
} from './api'
import { AccountMenu } from './AccountMenu'
import { ErpAuthScreen } from './ErpAuthScreen'
import { ExpertKitDetailsModal } from './ExpertKitDetailsModal'
import { SkillDetailsModal } from './SkillDetailsModal'
import {
  developerExpertKitInstallEnabled,
  installDeveloperExpertKit,
  installExpertKit,
  listInstalledExpertKits,
  mergeExpertKits,
  removeCatalogExtension,
  removeDeveloperExpertKit,
  type ExpertKitView,
} from './expertKits'
import {
  authorizeLocalDirectory,
  authorizeDroppedPaths,
  applyHarnessNotification,
  cancelHarness,
  clearLocalDirectories,
  connectorDiagnosticsAvailable,
  harnessActivityLabel,
  listenHarnessNotifications,
  probeHarnessHost,
  revokeLocalDirectory,
  runHarness,
  shutdownHarness,
  type AuthorizedLocalDirectory,
} from './harness'
import { ExecutionTrace } from './ExecutionTrace'
import type {
  BootstrapResponse,
  ConnectorCatalogEntry,
  ExpertKitCatalogEntry,
  KnowledgeBaseEntry,
  CloudTaskRun,
  InstalledExpertKit,
  RuntimeStatus,
  SkillCatalogEntry,
} from './types'
import { useEnterpriseSession } from './useEnterpriseSession'
import { XiaoyinMascot } from './XiaoyinMascot'
import { ScheduledTasksPage } from './ScheduledTasksPage'
import { TaskCenterPage } from './TaskCenterPage'
import { ImChannelsPage } from './ImChannelsPage'
import { loadTaskHistory, persistTaskHistory } from './taskHistory'
import { startLocalIm, stopLocalImRuntime } from './localIm'
import type { LocalTaskRun, TaskExecutionStep, TaskMessage } from './types'
import { memoryInstruction, rememberInstruction } from './memory'
import { modelDisplayName, modelStorageKey, resolveSelectedModel } from './modelSelection'
import { buildInvocationOptions, filterInvocationOptions, type InvocationOption } from './invocations'
import { buildRuntimeConnectorCatalog } from './connectors'
import { KnowledgeBasePage } from './KnowledgeBasePage'
import { DesktopSettingsPage } from './DesktopSettingsPage'
import { AuditEventsPage } from './AuditEventsPage'
import { ConnectorsPage } from './ConnectorsPage'
import { mergeSkills, type SkillView } from './skills'
import { allowedExtensionArtifacts } from './extensionPolicy'
import { cacheAge, loadEnterpriseCatalogCache, saveEnterpriseCatalogCache } from './enterpriseCache'
import { inspectDeviceCapabilities } from './deviceCapabilities'
import './styles.css'

const extensionNav = [
  { id: 'experts', label: '专家套件', icon: Boxes },
  { id: 'skills', label: '技能', icon: WandSparkles },
  { id: 'connectors', label: '连接器', icon: PlugZap },
  { id: 'knowledge', label: '知识库', icon: BookOpenCheck },
]

const RichMessage = lazy(() => import('./RichMessage').then((module) => ({ default: module.RichMessage })))

const starterTasks = [
  { icon: SquareCheckBig, title: '订单异常诊断', detail: '定位履约风险与待办', prompt: '分析昨天的订单异常，并给出处理优先级' },
  { icon: Boxes, title: '库存风险分析', detail: '识别缺货与滞销商品', prompt: '分析本周库存风险，列出需要补货的商品' },
  { icon: Store, title: 'Listing 优化', detail: '生成更专业的商品内容', prompt: '帮我优化这个商品的 Listing 内容' },
]

interface ExtensionSyncIssue {
  key: string
  label: string
  message: string
}

type HarnessHealth = 'checking' | 'ready' | 'degraded'
type ExtensionFilter = 'all' | 'installed' | 'available' | 'attention'

export default function App() {
  const { accessToken, error: authError, logout, reopen, state: authState, user } = useEnterpriseSession()
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>()
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus>('connecting')
  const [prompt, setPrompt] = useState('')
  const [page, setPage] = useState('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [messages, setMessages] = useState<TaskMessage[]>([])
  const [localTasks, setLocalTasks] = useState<LocalTaskRun[]>([])
  const [currentLocalTaskId, setCurrentLocalTaskId] = useState('')
  const [expertKits, setExpertKits] = useState<ExpertKitView[]>([])
  const [expertKitCatalog, setExpertKitCatalog] = useState<ExpertKitCatalogEntry[]>([])
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [skillViews, setSkillViews] = useState<SkillView[]>([])
  const [connectors, setConnectors] = useState<ConnectorCatalogEntry[]>([])
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseEntry[]>([])
  const [expertKitsLoading, setExpertKitsLoading] = useState(false)
  const [expertKitError, setExpertKitError] = useState('')
  const [extensionSyncIssues, setExtensionSyncIssues] = useState<ExtensionSyncIssue[]>([])
  const [extensionSyncAttempt, setExtensionSyncAttempt] = useState(0)
  const [extensionSyncedAt, setExtensionSyncedAt] = useState<Date>()
  const [catalogCacheSavedAt, setCatalogCacheSavedAt] = useState('')
  const [catalogCacheStale, setCatalogCacheStale] = useState(false)
  const [developerKitMode, setDeveloperKitMode] = useState(false)
  const [developerKitBusy, setDeveloperKitBusy] = useState(false)
  const [installingKitId, setInstallingKitId] = useState('')
  const [installingSkillId, setInstallingSkillId] = useState('')
  const [removingCatalogId, setRemovingCatalogId] = useState('')
  const [activeExpertKitId, setActiveExpertKitId] = useState('')
  const [activeSkillId, setActiveSkillId] = useState('')
  const [selectedExpertKitId, setSelectedExpertKitId] = useState('')
  const [selectedSkillId, setSelectedSkillId] = useState('')
  const [harnessSessionId, setHarnessSessionId] = useState('')
  const [harnessRunning, setHarnessRunning] = useState(false)
  const [harnessActivity, setHarnessActivity] = useState('')
  const [harnessHealth, setHarnessHealth] = useState<HarnessHealth>('checking')
  const [harnessHealthDetail, setHarnessHealthDetail] = useState('正在检查本地 Agent')
  const [harnessHealthAttempt, setHarnessHealthAttempt] = useState(0)
  const [localImError, setLocalImError] = useState('')
  const [failedCloudRuns, setFailedCloudRuns] = useState<CloudTaskRun[]>([])
  const [harnessSteps, setHarnessSteps] = useState<TaskExecutionStep[]>([])
  const harnessStepsRef = useRef<TaskExecutionStep[]>([])
  const [localDirectories, setLocalDirectories] = useState<AuthorizedLocalDirectory[]>([])
  const [localFileError, setLocalFileError] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [taskSearchOpen, setTaskSearchOpen] = useState(false)
  const [taskQuery, setTaskQuery] = useState('')
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [extensionQuery, setExtensionQuery] = useState('')
  const [extensionFilter, setExtensionFilter] = useState<ExtensionFilter>('all')
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const taskSearchInputRef = useRef<HTMLInputElement>(null)
  const workspaceRef = useRef<HTMLElement>(null)
  const cancellationRequestedRef = useRef(false)
  const extensionCacheRef = useRef<{
    catalog: ExpertKitCatalogEntry[]
    installed: InstalledExpertKit[]
    skills: SkillCatalogEntry[]
    connectors: ConnectorCatalogEntry[]
    knowledge: KnowledgeBaseEntry[]
  }>({ catalog: [], installed: [], skills: [], connectors: [], knowledge: [] })
  const allowedArtifacts = useMemo(
    () => allowedExtensionArtifacts(expertKitCatalog, skills),
    [expertKitCatalog, skills],
  )

  useEffect(() => {
    void developerExpertKitInstallEnabled().then(setDeveloperKitMode).catch(() => undefined)
  }, [])

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
    if (authState !== 'authenticated' || !user) {
      setLocalTasks([])
      setCurrentLocalTaskId('')
      return
    }
    let disposed = false
    void loadTaskHistory(user.userId)
      .then((tasks) => { if (!disposed) setLocalTasks(tasks) })
      .catch((reason) => { if (!disposed) setLocalFileError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { disposed = true }
  }, [authState, user])

  useEffect(() => {
    if (authState !== 'authenticated' || !connectorDiagnosticsAvailable()) {
      setHarnessHealth('ready')
      setHarnessHealthDetail('本地 Agent 仅在桌面客户端启用')
      return
    }
    let disposed = false
    setHarnessHealth('checking')
    setHarnessHealthDetail('正在检查 Harness Host')
    void probeHarnessHost()
      .then((result) => {
        if (disposed) return
        const ready = result.status === 'ready'
        setHarnessHealth(ready ? 'ready' : 'degraded')
        setHarnessHealthDetail(ready ? `Harness Host 已就绪 · ${result.version}` : `Harness Host 状态异常：${result.status}`)
      })
      .catch((reason) => {
        if (disposed) return
        setHarnessHealth('degraded')
        setHarnessHealthDetail(reason instanceof Error ? reason.message : String(reason))
      })
    return () => { disposed = true }
  }, [authState, harnessHealthAttempt])

  useEffect(() => {
    if (!bootstrap || !user) return
    const controller = new AbortController()
    let syncing = false
    const syncExtensions = async (showLoading: boolean) => {
      if (syncing) return
      syncing = true
      if (showLoading) setExpertKitsLoading(true)
      setExtensionSyncIssues([])
      if (showLoading) {
        const cached = await loadEnterpriseCatalogCache(user.userId).catch(() => undefined)
        if (cached && extensionCacheRef.current.catalog.length === 0) {
          const age = cacheAge(cached.savedAt)
          extensionCacheRef.current = { ...extensionCacheRef.current, ...cached }
          setCatalogCacheSavedAt(cached.savedAt)
          setCatalogCacheStale(age.stale)
          setExpertKitCatalog(cached.catalog)
          setSkills(cached.skills)
          setConnectors(cached.connectors)
          setKnowledgeBases(cached.knowledge)
          setSkillViews(mergeSkills(cached.skills, extensionCacheRef.current.installed, cached.connectors, cached.knowledge))
          setExpertKits(mergeExpertKits(cached.catalog, extensionCacheRef.current.installed, cached.connectors, cached.knowledge))
        }
      }
      const [catalogResult, installedResult, skillsResult, connectorsResult, knowledgeResult] = await Promise.allSettled([
        loadExpertKits(bootstrap.endpoints.expertKits, user.userId, accessToken, controller.signal),
        listInstalledExpertKits(),
        loadSkills(bootstrap.endpoints.skills, user.userId, accessToken, controller.signal),
        loadConnectors(bootstrap.endpoints.connectors, user.userId, accessToken, controller.signal),
        loadKnowledgeBases(bootstrap.endpoints.knowledge, user.userId, user.teamId, accessToken, controller.signal),
      ])
      try {
        if (controller.signal.aborted) return
        const cache = extensionCacheRef.current
        if (catalogResult.status === 'fulfilled') cache.catalog = catalogResult.value
        if (installedResult.status === 'fulfilled') cache.installed = installedResult.value
        if (skillsResult.status === 'fulfilled') cache.skills = skillsResult.value
        if (connectorsResult.status === 'fulfilled') cache.connectors = connectorsResult.value
        if (knowledgeResult.status === 'fulfilled') cache.knowledge = knowledgeResult.value
        setExpertKitCatalog(cache.catalog)
        setSkills(cache.skills)
        setSkillViews(mergeSkills(cache.skills, cache.installed, cache.connectors, cache.knowledge))
        setConnectors(cache.connectors)
        setKnowledgeBases(cache.knowledge)
        setExpertKits(mergeExpertKits(cache.catalog, cache.installed, cache.connectors, cache.knowledge))
        const sources = [
          ['expert-kits', '专家套件目录', catalogResult],
          ['installed', '本机已安装能力', installedResult],
          ['skills', 'Skills 目录', skillsResult],
          ['connectors', '连接器目录', connectorsResult],
          ['knowledge', '知识库目录', knowledgeResult],
        ] as const
        const issues = sources.flatMap(([key, label, result]) => result.status === 'rejected'
          ? [{ key, label, message: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
          : [])
        setExtensionSyncIssues(issues)
        setExtensionSyncedAt(new Date())
        if ([catalogResult, skillsResult, connectorsResult, knowledgeResult].every((result) => result.status === 'fulfilled')) {
          const savedAt = new Date().toISOString()
          setCatalogCacheSavedAt(savedAt)
          setCatalogCacheStale(false)
          void saveEnterpriseCatalogCache(user.userId, {
            savedAt, catalog: cache.catalog, skills: cache.skills, connectors: cache.connectors, knowledge: cache.knowledge,
          }).catch(() => undefined)
        }
      } finally {
        syncing = false
        if (showLoading && !controller.signal.aborted) setExpertKitsLoading(false)
      }
    }
    void syncExtensions(true)
    const timer = window.setInterval(() => void syncExtensions(false), 60_000)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [accessToken, bootstrap, extensionSyncAttempt, user])

  useEffect(() => {
    if (authState !== 'authenticated' || !connectorDiagnosticsAvailable()) return
    let disposed = false
    let unlisten: () => void = () => undefined
    void getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (disposed) return
      if (event.payload.type === 'over') setDragActive(true)
      if (event.payload.type === 'leave') setDragActive(false)
      if (event.payload.type !== 'drop') return
      setDragActive(false)
      if (harnessRunning) {
        setLocalFileError('请先取消或等待当前任务完成，再拖入文件')
        return
      }
      const paths = event.payload.paths
      void authorizeDroppedPaths(paths).then(async (directories) => {
        setLocalDirectories((current) => [...current, ...directories.filter((next) => !current.some((item) => item.id === next.id))])
        setHarnessSessionId('')
        await shutdownHarness()
        const names = paths.map((path) => path.split(/[\\/]/).pop()).filter(Boolean)
        setPrompt((current) => `${current}${current.trim() ? '\n' : ''}请处理本地文件：${names.join('、')}`)
        focusComposer()
      }).catch((reason) => setLocalFileError(reason instanceof Error ? reason.message : String(reason)))
    }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose })
    return () => { disposed = true; unlisten() }
  }, [authState, harnessRunning])

  useEffect(() => {
    if (!bootstrap || !user || authState !== 'authenticated') return
    void startLocalIm({
      employeeId: user.userId,
      teamId: user.teamId,
      litellmBaseUrl: bootstrap.endpoints.litellm,
      knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
      connectors: buildRuntimeConnectorCatalog(connectors, bootstrap.endpoints.erpMcp),
      allowedArtifacts,
      model: selectedModel || bootstrap.models[0] || 'deepseek-v4-flash',
      modelApiKey: bootstrap.modelApiKey,
      accessToken,
    }).then((status) => setLocalImError(status.lastError ?? ''))
      .catch((reason) => setLocalImError(reason instanceof Error ? reason.message : String(reason)))
  }, [accessToken, allowedArtifacts, authState, bootstrap, connectors, selectedModel, user])

  useEffect(() => {
    let disposed = false
    let unlisten: () => void = () => undefined
    void listenHarnessNotifications((notification) => {
      if (!disposed) {
        setHarnessActivity(harnessActivityLabel(notification))
        setHarnessSteps((current) => {
          const next = applyHarnessNotification(current, notification)
          harnessStepsRef.current = next
          return next
        })
      }
    }).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    return () => { disposed = true; unlisten() }
  }, [])

  useEffect(() => {
    if (authState === 'authenticated') return
    setLocalDirectories([])
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
        setNotificationOpen(false)
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
    if (!notificationOpen) return
    const dismiss = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.notification-center')) setNotificationOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [notificationOpen])

  useEffect(() => {
    const textarea = composerRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.max(83, Math.min(textarea.scrollHeight, 180))}px`
  }, [prompt])

  useEffect(() => {
    const list = messageListRef.current
    if (!list) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    list.scrollTo({ top: list.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' })
  }, [harnessActivity, harnessSteps, messages])

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [page])

  useEffect(() => {
    if (authState !== 'authenticated' || runtimeStatus !== 'ready' || !bootstrap || !user) return
    let stopped = false
    const heartbeat = async () => {
      try {
        const probe = await inspectDeviceCapabilities()
        if (!stopped && /^\d+\.\d+\.\d+$/.test(probe.desktopVersion)) {
          await submitDeviceHeartbeat(bootstrap.endpoints.deviceCapabilities ?? '/api/v1/device-capabilities',
            user.userId, accessToken, probe)
        }
      } catch { /* heartbeat is best-effort and must not interrupt employee work */ }
    }
    void heartbeat()
    const timer = window.setInterval(() => void heartbeat(), 6 * 60 * 60 * 1000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [accessToken, authState, bootstrap, runtimeStatus, user])

  useEffect(() => {
    if (authState !== 'authenticated' || runtimeStatus !== 'ready' || !bootstrap || !user) return
    let stopped = false
    const refreshFailures = async () => {
      try {
        const values = await loadCloudTaskRuns(bootstrap.endpoints.taskRuns, user.userId, accessToken)
        const cutoff = Date.now() - 24 * 60 * 60 * 1_000
        if (!stopped) setFailedCloudRuns(values.filter((run) => run.status === 'FAILED' && Date.parse(run.startedAt) >= cutoff).slice(0, 5))
      } catch { /* the task center remains the source of truth when background polling is unavailable */ }
    }
    void refreshFailures()
    const timer = window.setInterval(() => void refreshFailures(), 60_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [accessToken, authState, bootstrap, runtimeStatus, user])

  const statusLabel = useMemo(() => ({
    connecting: '正在连接企业服务',
    ready: '企业服务已连接',
    offline: '企业服务暂不可用',
  })[runtimeStatus], [runtimeStatus])
  const visibleExpertKits = useMemo(
    () => expertKits.filter((item) => extensionMatches(item, extensionQuery, extensionFilter)),
    [expertKits, extensionFilter, extensionQuery],
  )
  const visibleSkillViews = useMemo(
    () => skillViews.filter((item) => extensionMatches(item, extensionQuery, extensionFilter)),
    [extensionFilter, extensionQuery, skillViews],
  )

  if (authState !== 'authenticated') {
    return <ErpAuthScreen checking={authState === 'checking'} error={authError} onReopen={() => void reopen()} />
  }

  const selectedExpertKit = expertKits.find((kit) => kit.id === selectedExpertKitId && kit.installState === 'installed')
  const selectedSkill = skillViews.find((skill) => skill.id === selectedSkillId && skill.installState === 'installed')
  const activeExpertKit = expertKits.find((kit) => kit.id === activeExpertKitId)
  const activeSkill = skillViews.find((skill) => skill.id === activeSkillId)
  const runtimeConnectors = buildRuntimeConnectorCatalog(connectors, bootstrap?.endpoints.erpMcp ?? '')
  const invocationOptions = buildInvocationOptions(expertKits, skillViews)
  const visibleInvocations = filterInvocationOptions(invocationOptions, prompt)
  const activeModel = selectedModel || bootstrap?.models[0] || 'deepseek-v4-flash'
  const selectedEnterpriseCapability = Boolean(selectedExpertKit || selectedSkill)
  const selectedCapabilityExecutable = !selectedEnterpriseCapability || !catalogCacheStale
  const activeLocalTasks = localTasks.filter((task) => !task.archivedAt)
  const visibleLocalTasks = taskQuery.trim()
    ? activeLocalTasks.filter((task) => task.name.toLocaleLowerCase().includes(taskQuery.trim().toLocaleLowerCase()))
    : activeLocalTasks
  const focusComposer = () => window.requestAnimationFrame(() => composerRef.current?.focus())
  const newTask = () => {
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setMessages([])
    setPrompt('')
    setHarnessSessionId('')
    setCurrentLocalTaskId('')
    setHarnessActivity('')
    harnessStepsRef.current = []
    setHarnessSteps([])
    setLocalDirectories([])
    setLocalFileError('')
    void Promise.all([clearLocalDirectories(), shutdownHarness()])
    focusComposer()
  }
  const persistLocalTask = (task: LocalTaskRun) => {
    if (!user) return
    setLocalTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 200))
    void persistTaskHistory(user.userId, task)
      .catch((reason) => setLocalFileError(reason instanceof Error ? reason.message : String(reason)))
  }
  const openLocalTask = (task: LocalTaskRun) => {
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setMessages(task.messages.map((message) => ({ ...message, pending: false })))
    setCurrentLocalTaskId(task.id)
    setHarnessSessionId(task.sessionId ?? '')
    setSelectedExpertKitId(task.expertKitId ?? '')
    setSelectedSkillId(task.skillId ?? '')
    setSelectedModel(resolveSelectedModel(bootstrap?.models ?? [], task.model ?? selectedModel))
    setPrompt('')
    setHarnessActivity('')
    harnessStepsRef.current = []
    setHarnessSteps([])
    setLocalDirectories([])
    setLocalFileError('')
    void Promise.all([clearLocalDirectories(), shutdownHarness()])
    focusComposer()
  }
  const archiveLocalTask = (task: LocalTaskRun, archived: boolean) => {
    persistLocalTask({ ...task, archivedAt: archived ? new Date().toISOString() : undefined, updatedAt: new Date().toISOString() })
    if (archived && currentLocalTaskId === task.id) newTask()
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
      await shutdownHarness()
    } catch (error) {
      setLocalFileError(error instanceof Error ? error.message : String(error))
    }
  }
  const removeLocalDirectory = async (id: string) => {
    setLocalFileError('')
    try {
      await revokeLocalDirectory(id)
      await shutdownHarness()
      setLocalDirectories((current) => current.filter((item) => item.id !== id))
      setHarnessSessionId('')
    } catch (error) {
      setLocalFileError(error instanceof Error ? error.message : String(error))
    }
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
    const input = prompt.trim()
    if (!input || !bootstrap || runtimeStatus !== 'ready' || harnessRunning || !selectedCapabilityExecutable) return
    const remembered = memoryInstruction(input)
    if (remembered) {
      setPrompt('')
      if (!window.confirm(`是否将以下内容保存为长期记忆？\n\n${remembered}`)) {
        setMessages((current) => [...current, { role: 'user', text: input }, { role: 'assistant', text: '未保存到长期记忆。' }])
        return
      }
      try {
        await rememberInstruction(user!.userId, bootstrap.endpoints.memoryProfile ?? '/api/v1/memory-profile', accessToken, remembered)
        const rememberedMessages: TaskMessage[] = [{ role: 'user', text: input }, { role: 'assistant', text: `已记住：${remembered}` }]
        const timestamp = new Date().toISOString()
        const task: LocalTaskRun = { id: crypto.randomUUID(), source: 'DESKTOP', name: input.slice(0, 60),
          status: 'COMPLETED', createdAt: timestamp, updatedAt: timestamp, messages: rememberedMessages }
        setMessages(rememberedMessages)
        persistLocalTask(task)
      } catch (error) {
        setMessages([{ role: 'user', text: input }, { role: 'assistant', text: `记忆失败：${error instanceof Error ? error.message : String(error)}` }])
      }
      return
    }
    const now = new Date().toISOString()
    const taskId = currentLocalTaskId || crypto.randomUUID()
    const existingTask = localTasks.find((task) => task.id === taskId)
    const pendingMessages: TaskMessage[] = [...messages, { role: 'user', text: input },
      { role: 'assistant', text: '正在分析任务…', pending: true }]
    const runningTask: LocalTaskRun = {
      id: taskId,
      source: 'DESKTOP',
      name: existingTask?.name ?? input.slice(0, 60),
      status: 'RUNNING',
      createdAt: existingTask?.createdAt ?? now,
      updatedAt: now,
      sessionId: harnessSessionId || existingTask?.sessionId,
      expertKitId: selectedExpertKit?.id,
      skillId: selectedSkill?.id,
      model: activeModel,
      messages: pendingMessages,
    }
    setCurrentLocalTaskId(taskId)
    setMessages(pendingMessages)
    persistLocalTask(runningTask)
    void submitAuditEvent(bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events', user!.userId, accessToken, {
      source: 'DESKTOP', category: 'AGENT', action: 'desktop.agent.run', outcome: 'STARTED',
      resourceType: 'desktop-task', resourceId: taskId,
      summary: [selectedExpertKit?.id, selectedSkill?.id, activeModel].filter(Boolean).join(' · '), occurredAt: now,
    }).catch(() => undefined)
    setPrompt('')
    setHarnessRunning(true)
    cancellationRequestedRef.current = false
    setHarnessActivity('正在启动本地 Agent')
    harnessStepsRef.current = []
    setHarnessSteps([])
    try {
      const result = await runHarness({
        prompt: input,
        employeeId: user!.userId,
        teamId: user!.teamId,
        ...(harnessSessionId ? { sessionId: harnessSessionId } : {}),
        ...(selectedExpertKit || selectedSkill ? { expertKitId: (selectedExpertKit ?? selectedSkill)!.id } : {}),
        litellmBaseUrl: bootstrap.endpoints.litellm,
        knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
        connectors: runtimeConnectors,
        allowedArtifacts,
        model: activeModel,
        modelApiKey: bootstrap.modelApiKey,
        accessToken,
        localFileRootIds: localDirectories.map((directory) => directory.id),
      })
      setHarnessSessionId(result.sessionId)
      const completedMessages = pendingMessages.map((message, index) => index === pendingMessages.length - 1
        ? { role: 'assistant', text: result.finalResponse || '任务已执行完成，但模型没有返回文本。',
          executionSteps: harnessStepsRef.current }
        : message) as TaskMessage[]
      setMessages(completedMessages)
      persistLocalTask({ ...runningTask, status: 'COMPLETED', updatedAt: new Date().toISOString(),
        sessionId: result.sessionId, messages: completedMessages })
      await reportTaskAudit('SUCCEEDED', taskId, harnessStepsRef.current)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const canceled = cancellationRequestedRef.current
      const failedMessages = pendingMessages.map((item, index) => index === pendingMessages.length - 1
        ? { role: 'assistant', text: canceled ? '任务已取消，可修改要求后重新执行。' : `执行失败：${message}`, executionSteps: harnessStepsRef.current }
        : item) as TaskMessage[]
      setMessages(failedMessages)
      persistLocalTask({ ...runningTask, status: canceled ? 'CANCELED' : 'FAILED', updatedAt: new Date().toISOString(), messages: failedMessages })
      if (!canceled) {
        setHarnessHealth('degraded')
        setHarnessHealthDetail(`Harness 执行异常：${message}`)
      }
      void shutdownHarness()
      await reportTaskAudit('FAILED', taskId, harnessStepsRef.current)
    } finally {
      setHarnessRunning(false)
      setHarnessActivity('')
      cancellationRequestedRef.current = false
    }
  }

  const cancelCurrentTask = async () => {
    if (!harnessRunning || cancellationRequestedRef.current) return
    cancellationRequestedRef.current = true
    setHarnessActivity('正在取消当前任务')
    try {
      const canceled = await cancelHarness()
      if (!canceled) {
        cancellationRequestedRef.current = false
        setHarnessActivity('当前任务即将完成，暂时无法取消')
      }
    } catch (reason) {
      cancellationRequestedRef.current = false
      setHarnessActivity('取消失败，任务仍在执行')
      setLocalFileError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const prepareRetry = () => {
    const previous = [...messages].reverse().find((message) => message.role === 'user')
    if (!previous) return
    setPrompt(previous.text)
    focusComposer()
  }

  const reportTaskAudit = async (
    outcome: 'SUCCEEDED' | 'FAILED',
    taskId: string,
    steps: TaskExecutionStep[],
  ) => {
    if (!bootstrap || !user) return
    const endpoint = bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events'
    const events = [{
      source: 'DESKTOP' as const, category: 'AGENT' as const, action: 'desktop.agent.run', outcome,
      resourceType: 'desktop-task', resourceId: taskId,
      summary: outcome === 'SUCCEEDED' ? '桌面 Agent 执行完成' : '桌面 Agent 执行失败',
    }, ...steps.filter((step) => ['tool', 'approval'].includes(step.kind) && step.toolName).map((step) => ({
      source: 'DESKTOP' as const, category: step.kind === 'approval' ? 'APPROVAL' as const : 'TOOL' as const,
      action: step.toolName!, outcome: step.status === 'failed'
        ? step.kind === 'approval' ? 'DENIED' as const : 'FAILED' as const
        : 'SUCCEEDED' as const,
      resourceType: 'desktop-task', resourceId: taskId,
      summary: step.label.slice(0, 500), occurredAt: step.completedAt ?? step.startedAt,
    }))]
    await Promise.allSettled(events.map((value) => submitAuditEvent(endpoint, user.userId, accessToken, value)))
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
      const installed = await installExpertKit(download)
      setExpertKits((current) => current.map((item) => item.id === kit.id
        ? { ...item, installed, installedVersion: installed.manifest.version, installState: 'installed' }
        : item))
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setInstallingKitId('')
    }
  }

  const refreshInstalledKits = async () => {
    const installed = await listInstalledExpertKits()
    extensionCacheRef.current.installed = installed
    setExpertKits(mergeExpertKits(expertKitCatalog, installed, connectors, knowledgeBases))
    setSkillViews(mergeSkills(skills, installed, connectors, knowledgeBases))
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
      await installExpertKit(download)
      await refreshInstalledKits()
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setInstallingSkillId('')
    }
  }

  const installLocalAcceptanceKit = async () => {
    if (developerKitBusy) return
    setDeveloperKitBusy(true)
    setExpertKitError('')
    try {
      const installed = await installDeveloperExpertKit()
      if (!installed) return
      await refreshInstalledKits()
      setActiveExpertKitId(installed.manifest.id)
    } catch (error) {
      setExpertKitError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeveloperKitBusy(false)
    }
  }

  const removeLocalAcceptanceKit = async (kit: ExpertKitView) => {
    if (!kit.localOnly || developerKitBusy) return
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
    const label = kind === 'skill' ? 'Skill' : '专家套件'
    if (!window.confirm(`卸载这个${label}及其所有本地正式版本？历史任务记录不会删除。`)) return
    setRemovingCatalogId(id)
    setExpertKitError('')
    try {
      await Promise.all([shutdownHarness(), stopLocalImRuntime()])
      await removeCatalogExtension(id, kind)
      if (selectedExpertKitId === id) setSelectedExpertKitId('')
      if (selectedSkillId === id) setSelectedSkillId('')
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
    if (kit.installState !== 'installed') return
    setSelectedExpertKitId(kit.id)
    setSelectedSkillId('')
    setHarnessSessionId('')
    setPage('chat')
    setPrompt('')
    setActiveExpertKitId('')
    focusComposer()
  }

  const useSkill = (skill: SkillView) => {
    if (skill.installState !== 'installed') return
    setSelectedSkillId(skill.id)
    setSelectedExpertKitId('')
    setHarnessSessionId('')
    setPage('chat')
    setPrompt(`请使用 skill "${skill.id}" 完成：`)
    setActiveSkillId('')
    void shutdownHarness()
    focusComposer()
  }

  const selectModel = (model: string) => {
    setSelectedModel(model)
    setModelMenuOpen(false)
    if (user) window.localStorage.setItem(modelStorageKey(user.userId), model)
  }

  const selectInvocation = (option: InvocationOption) => {
    setSelectedExpertKitId(option.profileKind === 'expert-kit' ? option.profileId : '')
    setSelectedSkillId(option.profileKind === 'skill' ? option.profileId : '')
    setHarnessSessionId('')
    setPrompt(option.kind === 'command'
      ? `/${option.id} `
      : `请使用 skill "${option.id}" 完成：`)
    void shutdownHarness()
    focusComposer()
  }

  const memorySaved = async () => {
    await Promise.all([shutdownHarness(), stopLocalImRuntime()])
    if (bootstrap) {
      await startLocalIm({
        employeeId: user!.userId,
        teamId: user!.teamId,
        litellmBaseUrl: bootstrap.endpoints.litellm,
        knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
        connectors: runtimeConnectors,
        allowedArtifacts,
        model: activeModel,
        modelApiKey: bootstrap.modelApiKey,
        accessToken,
      }).catch(() => undefined)
    }
  }

  const notifications = [
    ...(runtimeStatus === 'offline' ? [{ key: 'control-plane', title: '企业服务连接失败', detail: '点击顶部连接状态可立即重试。', tone: 'danger' }] : []),
    ...(harnessHealth === 'degraded' ? [{ key: 'harness', title: '本地 Agent 需要恢复', detail: harnessHealthDetail, tone: 'danger' }] : []),
    ...(localImError ? [{ key: 'local-im', title: '本机 IM 频道异常', detail: localImError, tone: 'danger' }] : []),
    ...failedCloudRuns.map((run) => ({ key: `run-${run.runId}`, title: `定时任务失败：${run.name}`, detail: new Date(run.startedAt).toLocaleString(), tone: 'danger' })),
    ...extensionSyncIssues.map((issue) => ({ key: `sync-${issue.key}`, title: `${issue.label}同步失败`, detail: issue.message, tone: 'warning' })),
  ]

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {dragActive && <div className="file-drop-overlay"><FolderOpen size={34} /><strong>松开即可添加到当前任务</strong><span>文件只会授权其所在目录，执行时仍遵循专家套件权限</span></div>}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <button aria-label="返回新任务" className="brand-home" onClick={newTask} title="返回新任务" type="button"><XiaoyinMascot size={38} variant="avatar" /></button>
          <div><strong>小胤</strong><small>跨境电商 AI 工作台</small></div>
          <div className="sidebar-toolbar">
            <button aria-expanded={taskSearchOpen} aria-label="搜索任务" onClick={() => { setTaskSearchOpen((value) => !value); setTaskQuery('') }} title="搜索任务（Ctrl/⌘ K）" type="button"><Search size={15} /></button>
            <button aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setSidebarCollapsed((value) => !value)} type="button">{sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</button>
          </div>
        </div>
        {taskSearchOpen && <label className="task-search"><Search size={14} /><input aria-label="搜索最近任务" onChange={(event) => setTaskQuery(event.target.value)} placeholder="搜索最近任务" ref={taskSearchInputRef} value={taskQuery} /><button aria-label="关闭搜索" onClick={() => { setTaskSearchOpen(false); setTaskQuery('') }} type="button"><X size={13} /></button></label>}
        <button className="new-task" onClick={newTask} title={sidebarCollapsed ? '新建任务' : undefined} type="button"><Plus size={17} /><span>新建任务</span></button>
        <p className="nav-label extension-label"><Boxes size={13} />扩展</p>
        <nav className="extension-nav">
          {extensionNav.map(({ id, label, icon: Icon }) => <button aria-current={page === id ? 'page' : undefined} className={page === id ? 'nav-item active' : 'nav-item'} key={id} onClick={() => setPage(id)} title={sidebarCollapsed ? label : undefined} type="button"><Icon size={17} /><span>{label}</span>{id === 'skills' && skills.length > 0 && <em>{skills.length}</em>}</button>)}
        </nav>
        <nav className="office-nav">
          <button aria-current={page === 'tasks' ? 'page' : undefined} className={page === 'tasks' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('tasks')} title={sidebarCollapsed ? '任务中心' : undefined} type="button"><SquareCheckBig size={17} /><span>任务中心</span></button>
          <button aria-current={page === 'schedules' ? 'page' : undefined} className={page === 'schedules' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('schedules')} title={sidebarCollapsed ? '定时任务' : undefined} type="button"><CalendarClock size={17} /><span>定时任务</span></button>
          <button aria-current={page === 'im' ? 'page' : undefined} className={page === 'im' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('im')} title={sidebarCollapsed ? 'IM 频道' : undefined} type="button"><MessageSquare size={17} /><span>IM 频道</span></button>
          <button aria-current={page === 'audit' ? 'page' : undefined} className={page === 'audit' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('audit')} title={sidebarCollapsed ? '审计记录' : undefined} type="button"><ScrollText size={17} /><span>审计记录</span></button>
        </nav>
        <div className="recent-tasks">
          <p className="nav-label">最近</p>
          {visibleLocalTasks.slice(0, 5).map((task) => <button className="recent-task" key={task.id} onClick={() => openLocalTask(task)} type="button"><span>{task.name}</span><small>{task.status === 'RUNNING' ? '运行中' : task.status === 'COMPLETED' ? '已完成' : task.status === 'CANCELED' ? '已取消' : '执行失败'}</small></button>)}
          {localTasks.length === 0 && <small className="recent-empty">暂无本机任务</small>}
          {localTasks.length > 0 && visibleLocalTasks.length === 0 && <small className="recent-empty">没有匹配的任务</small>}
        </div>
        <div className="sidebar-spacer" />
        <AccountMenu companyName={user?.companyName} department={user?.department} displayName={user?.displayName} onFeedback={submitDesktopFeedback} onLogout={logoutWithCleanup} onSettings={() => setPage('settings')} runtimeStatus={runtimeStatus} />
      </aside>

      <main className="workspace" ref={workspaceRef}>
        <header className="topbar">
          <button className={`connection-state ${runtimeStatus}`} disabled={runtimeStatus === 'connecting'} onClick={() => runtimeStatus === 'offline' && setConnectionAttempt((value) => value + 1)} title={runtimeStatus === 'offline' ? '点击重新连接' : undefined} type="button"><i /> 马帮 ERP · {statusLabel}</button>
          <div className="topbar-tools">
            <button className={`harness-state ${harnessHealth}`} disabled={harnessHealth === 'checking'} onClick={() => harnessHealth === 'degraded' && setHarnessHealthAttempt((value) => value + 1)} title={harnessHealthDetail} type="button"><i /> {harnessHealth === 'checking' ? 'Agent 检查中' : harnessHealth === 'ready' ? 'Agent 已就绪' : 'Agent 待恢复'}</button>
            <div className="notification-center">
              <button aria-expanded={notificationOpen} aria-label="通知中心" className="notification-trigger" onClick={() => setNotificationOpen((value) => !value)} type="button"><Bell size={16} />{notifications.length > 0 && <span>{notifications.length}</span>}</button>
              {notificationOpen && <section className="notification-popover"><header><strong>通知中心</strong><small>{notifications.length ? `${notifications.length} 项需要处理` : '当前运行正常'}</small></header>{notifications.length
                ? notifications.map((item) => <article className={item.tone} key={item.key}><i /><span><strong>{item.title}</strong><small>{item.detail}</small></span></article>)
                : <div className="notification-empty"><SquareCheckBig size={20} />暂无待处理事项</div>}
                {notifications.length > 0 && <footer><button onClick={() => { setNotificationOpen(false); setPage(localImError ? 'im' : failedCloudRuns.length ? 'tasks' : 'settings') }} type="button">{localImError ? '打开 IM 频道' : failedCloudRuns.length ? '打开任务中心' : '打开运行诊断'}</button></footer>}
              </section>}
            </div>
          </div>
        </header>

        {page === 'chat' ? (
          <section className={messages.length > 0 ? 'chat-page conversation' : 'chat-page'}>
            {messages.length === 0 && <div className="hero-copy">
              <XiaoyinMascot size={82} variant="hero" />
              <div className="hero-greeting">嗨，我是小胤</div>
              <h1>今天想先处理什么？</h1>
              <p>连接 ERP 数据，让专家 Agent 安全地完成查询、分析与内容生产</p>
              <div className="starter-actions">{starterTasks.map(({ icon: Icon, title, detail, prompt: value }) => <button key={title} onClick={() => { setPrompt(value); focusComposer() }} type="button"><Icon size={16} /><span><strong>{title}</strong><small>{detail}</small></span></button>)}</div>
            </div>}
            {messages.length > 0 && <div className="message-list" ref={messageListRef}>{messages.map((message, index) => {
              const retryable = message.role === 'assistant' && index === messages.length - 1 && !message.pending && (message.text.startsWith('执行失败：') || message.text.startsWith('任务已取消'))
              return <article className={`message ${message.role}${message.pending ? ' pending' : ''}`} key={`${message.role}-${index}`}><span className="message-avatar">{message.role === 'user' ? '你' : <XiaoyinMascot size={29} variant="avatar" />}</span><div><small>{message.role === 'user' ? '你' : '小胤'}</small><Suspense fallback={<p>{message.pending && harnessActivity ? harnessActivity : message.text}</p>}><RichMessage assistant={message.role === 'assistant'} onRegenerate={message.role === 'assistant' && !message.pending ? prepareRetry : undefined} text={message.pending && harnessActivity ? harnessActivity : message.text} /></Suspense>{message.role === 'assistant' && <ExecutionTrace steps={message.pending ? harnessSteps : message.executionSteps ?? []} />}{retryable && <button className="retry-task" onClick={prepareRetry} type="button">修改后重新执行</button>}</div></article>
            })}</div>}
            {harnessHealth === 'degraded' && <div className="runtime-recovery"><CircleStop size={17} /><span><strong>本地 Agent 暂不可用</strong><small>{harnessHealthDetail}</small></span><button onClick={() => setHarnessHealthAttempt((value) => value + 1)} type="button">重新检测</button></div>}
            <form className="composer" onSubmit={submit}>
              <textarea aria-label="给小胤发送消息" onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="描述任务，/ 选择专家套件或技能，@ 添加业务上下文" ref={composerRef} value={prompt} />
              <div className="composer-actions">
                <button aria-label="授权本地文件夹" className="circle-button" disabled={harnessRunning} onClick={() => void addLocalDirectory()} title="授权本地文件夹" type="button"><CirclePlus size={18} /></button>
                <button className="mode-button" onClick={() => setPage(selectedSkill ? 'skills' : 'experts')} type="button"><Sparkles size={14} /> {selectedExpertKit?.name ?? selectedSkill?.name ?? '运营通用'} <ChevronDown size={13} /></button>
                <div className="model-picker" ref={modelPickerRef}>
                  <button aria-expanded={modelMenuOpen} className="model-label" onClick={() => setModelMenuOpen((value) => !value)} type="button"><Bot size={14} /> {modelDisplayName(activeModel)} <ChevronDown size={13} /></button>
                  {modelMenuOpen && <div className="model-menu"><small>公司可用模型</small>{(bootstrap?.models.length ? bootstrap.models : [activeModel]).map((model) => <button className={model === activeModel ? 'active' : ''} key={model} onClick={() => selectModel(model)} type="button"><span><strong>{modelDisplayName(model)}</strong><small>{model}</small></span>{model === activeModel && <SquareCheckBig size={14} />}</button>)}</div>}
                </div>
                {harnessRunning
                  ? <button aria-label="取消当前任务" className="cancel-button" onClick={() => void cancelCurrentTask()} title="取消当前任务" type="button"><CircleStop size={17} /></button>
                  : <button aria-label="发送" className="send-button" disabled={!prompt.trim() || !bootstrap || runtimeStatus !== 'ready' || harnessHealth === 'degraded' || !selectedCapabilityExecutable} title={runtimeStatus !== 'ready' ? '企业服务未连接' : harnessHealth === 'degraded' ? '请先恢复本地 Agent' : !selectedCapabilityExecutable ? '企业目录缓存已过期，请先重新同步' : '发送'} type="submit"><Send size={17} /></button>}
              </div>
              {visibleInvocations.length > 0 && <div className="slash-menu"><small>快捷调用</small>{visibleInvocations.map((option) => <button key={`${option.kind}-${option.profileId}-${option.id}`} onClick={() => selectInvocation(option)} type="button"><span><strong>{option.label}</strong><small>{option.description}</small></span><em>{option.profileName}</em></button>)}</div>}
            </form>
            {localFileError && <div className="local-file-error">{localFileError}</div>}
            <div className="context-bar">
              <div className="local-contexts">
                {localDirectories.length === 0
                  ? <span>企业连接器 · 本地文件未授权 · 云端工作流</span>
                  : localDirectories.map((directory) => <span className="local-context" key={directory.id}>
                    <FolderOpen size={12} />{directory.name}
                    <button aria-label={`移除 ${directory.name}`} disabled={harnessRunning} onClick={() => void removeLocalDirectory(directory.id)} type="button"><X size={11} /></button>
                  </span>)}
              </div>
              <span><ShieldCheck size={14} /> 仅访问已授权目录 · 修改与 Shell 逐次确认</span>
            </div>
          </section>
        ) : (
          <section className="capability-page">
            <span className="page-kicker">企业能力中心</span>
            <h1>{extensionNav.find((item) => item.id === page)?.label ?? ({ settings: '桌面设置', tasks: '任务中心', schedules: '定时任务', im: 'IM 频道', audit: '审计记录' } as Record<string, string>)[page]}</h1>
            <p>{page === 'experts'
              ? '面向岗位的一整套工作方案，统一组合命令、技能、连接器和后台工作流。'
              : page === 'skills'
                ? '公司沉淀的独立工作方法，可由 Agent 自动识别或在对话中明确调用。'
                  : page === 'connectors'
                    ? '连接公司数据和员工电脑能力；账号、地址和令牌由公司统一管理。'
                  : page === 'knowledge'
                    ? '集中管理公司文档；索引任务由 Temporal 托管，回答可引用文件与页码或工作表。'
                  : page === 'im'
                    ? '把钉钉等公司消息入口连接到本机小胤 Harness，集中查看连接和处理状态。'
                  : page === 'tasks'
                    ? '统一查看小胤桌面任务、Temporal 云端执行和可下载的结果产物。'
                  : page === 'schedules'
                    ? '按专家套件声明的后台工作流创建任务；任务由 Temporal 托管，关闭电脑后仍会运行。'
                  : page === 'settings'
                    ? '管理个人记忆与当前电脑的本地能力；软件更新和反馈仍可从左下角头像打开。'
                    : page === 'audit'
                      ? '集中查看桌面 Agent 和工具的去敏执行记录，便于追溯成功、失败与授权结果。'
                    : '这里将由控制中心下发公司自己的能力与权限配置。'}</p>
            {extensionSyncIssues.length > 0 && <div className="sync-diagnostics"><div><CircleStop size={17} /><span><strong>部分企业能力同步失败，已保留上次成功数据</strong><small>{extensionSyncedAt ? `最近尝试 ${extensionSyncedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '刚刚尝试同步'}</small></span><button onClick={() => setExtensionSyncAttempt((value) => value + 1)} type="button">重新同步</button></div><details><summary>查看 {extensionSyncIssues.length} 项失败详情</summary>{extensionSyncIssues.map((issue) => <p key={issue.key}><strong>{issue.label}</strong><span>{issue.message}</span></p>)}</details></div>}
            {catalogCacheSavedAt && extensionSyncIssues.length > 0 && <div className={`catalog-cache-state ${catalogCacheStale ? 'stale' : ''}`}><ShieldCheck size={15} /><span>{catalogCacheStale ? '本机企业目录缓存已超过 7 天，浏览仍可用，但相关能力暂停执行。' : `当前显示本机缓存 · ${new Date(catalogCacheSavedAt).toLocaleString('zh-CN', { hour12: false })}`}</span></div>}
            {page === 'settings' && bootstrap && user && <DesktopSettingsPage
              accessToken={accessToken}
              authorizedDirectoryCount={localDirectories.length}
              connectors={connectors}
              deviceEndpoint={bootstrap.endpoints.deviceCapabilities ?? '/api/v1/device-capabilities'}
              employeeId={user.userId}
              memoryEndpoint={bootstrap.endpoints.memoryProfile ?? '/api/v1/memory-profile'}
              onMemorySaved={memorySaved}
              runtimeConnectors={runtimeConnectors}
              runtimeStatus={runtimeStatus}
            />}
            {page === 'audit' && bootstrap && user && <AuditEventsPage
              endpoint={bootstrap.endpoints.auditEvents ?? '/api/v1/audit-events'}
              employeeId={user.userId}
              accessToken={accessToken}
            />}
            {page === 'experts' && <>
              {expertKitsLoading && <div className="kit-empty">正在同步公司专家套件…</div>}
              {!expertKitsLoading && expertKits.length === 0 && <div className="kit-empty">控制中心尚未发布专家套件</div>}
              {expertKitError && <div className="kit-error">{expertKitError}</div>}
              {developerKitMode && <div className="developer-kit-bar">
                <span><strong>开发者验收模式</strong><small>本地套件不会上传或进入公司目录，仍受权限和逐次审批约束。</small></span>
                <button disabled={developerKitBusy} onClick={() => void installLocalAcceptanceKit()} type="button"><PackagePlus size={14} />{developerKitBusy ? '正在处理…' : '安装本地验收包'}</button>
              </div>}
              <ExtensionToolbar filter={extensionFilter} query={extensionQuery} onFilter={setExtensionFilter} onQuery={setExtensionQuery} />
              {!expertKitsLoading && expertKits.length > 0 && visibleExpertKits.length === 0 && <div className="kit-empty">没有匹配的专家套件</div>}
              <div className="kit-grid">{visibleExpertKits.map((kit) => {
                const installing = installingKitId === kit.id
                const stateLabel = kit.localOnly ? '本地验收' : kit.installState === 'retired' ? '已下架' : kit.installState === 'installed' ? '已安装' : kit.installState === 'update' ? '可更新' : '可安装'
                return <article key={kit.id}>
                  <div className="kit-card-head"><span className={`kit-state ${kit.installState}`}>{stateLabel}</span><small>v{kit.version}</small></div>
                  <h3>{kit.name}</h3>
                  <p>{kit.summary}</p>
                  <div className="kit-capabilities">
                    <small>{kit.skillIds.length} 个技能</small>
                    <small>{kit.connectorRefs.length} 个连接器</small>
                    <small>{kit.knowledgeBaseRefs.length} 个知识库</small>
                    <small>{kit.requiredTools.length} 个工具依赖</small>
                  </div>
                  <div className={`kit-readiness ${kit.readiness}`}>
                    {kit.readiness === 'ready'
                      ? '连接器、工具和知识库已就绪'
                      : `部分能力待启用：${[...kit.connectorIssues, ...kit.knowledgeIssues].join('；')}`}
                  </div>
                  {kit.installState === 'update' && <div className="kit-version-note">已安装 v{kit.installedVersion}</div>}
                  {kit.installState === 'retired' && <div className="kit-version-note">已停止加载，可卸载本地文件</div>}
                  <button
                    className="kit-install"
                    disabled={installing || (!kit.sha256 && !['installed', 'retired'].includes(kit.installState))}
                    onClick={() => setActiveExpertKitId(kit.id)}
                    type="button"
                  >{installing ? '正在校验并安装…' : kit.installState === 'retired' ? '查看并卸载' : kit.installState === 'installed' ? '查看详情' : kit.installState === 'update' ? '查看更新' : '查看并安装'}</button>
                </article>
              })}</div>
            </>}
            {page === 'skills' && <>
              {expertKitsLoading && <div className="kit-empty">正在同步公司技能…</div>}
              {!expertKitsLoading && skillViews.length === 0 && <div className="kit-empty">控制中心尚未发布独立技能</div>}
              {expertKitError && <div className="kit-error">{expertKitError}</div>}
              <ExtensionToolbar filter={extensionFilter} query={extensionQuery} onFilter={setExtensionFilter} onQuery={setExtensionQuery} />
              {!expertKitsLoading && skillViews.length > 0 && visibleSkillViews.length === 0 && <div className="kit-empty">没有匹配的 Skill</div>}
              <div className="kit-grid">{visibleSkillViews.map((skill) => {
                const installed = skill.installState === 'installed'
                const stateLabel = skill.installState === 'retired' ? '已下架' : installed ? '已安装' : skill.installState === 'update' ? '可更新' : '可安装'
                return <article key={skill.id}>
                  <div className="kit-card-head"><span className={`kit-state ${skill.installState}`}>{stateLabel}</span><small>v{skill.version}</small></div>
                  <h3>{skill.name}</h3>
                  <p>{skill.summary}</p>
                  <div className="kit-capabilities">{skill.triggers.slice(0, 3).map((trigger) => <small key={trigger}>{trigger}</small>)}</div>
                  <div className={`kit-readiness ${skill.readiness}`}>{skill.readiness === 'ready' ? '所需能力已就绪' : '部分依赖暂不可用'}</div>
                  {skill.installState === 'update' && <div className="kit-version-note">已安装 v{skill.installedVersion}</div>}
                  {skill.installState === 'retired' && <div className="kit-version-note">已停止加载，可卸载本地文件</div>}
                  <button className="kit-install" onClick={() => setActiveSkillId(skill.id)} type="button">
                    {skill.installState === 'retired' ? '查看并卸载' : installed ? '查看详情' : skill.installState === 'update' ? '查看更新' : '查看并安装'}
                  </button>
                </article>
              })}</div>
            </>}
            {page === 'connectors' && <>
              <ConnectorsPage
                accessToken={accessToken}
                catalog={connectors}
                catalogError={expertKitError}
                loading={expertKitsLoading}
                runtime={runtimeConnectors}
                syncError=""
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
              expertKits={expertKits}
            />}
            {page === 'tasks' && bootstrap && user && <TaskCenterPage
              accessToken={accessToken}
              employeeId={user.userId}
              endpoint={bootstrap.endpoints.taskRuns}
              localTasks={localTasks}
              onOpenLocalTask={openLocalTask}
              onArchiveLocalTask={archiveLocalTask}
            />}
            {page === 'im' && bootstrap && user && <ImChannelsPage
              accessToken={accessToken}
              employeeId={user.userId}
              teamId={user.teamId}
              connectors={runtimeConnectors}
              allowedArtifacts={allowedArtifacts}
              litellmBaseUrl={bootstrap.endpoints.litellm}
              knowledgeEndpoint={resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge)}
              model={activeModel}
              modelApiKey={bootstrap.modelApiKey}
            />}
          </section>
        )}
      </main>
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
      />}
      {activeSkill && <SkillDetailsModal
        skill={activeSkill}
        connectors={connectors}
        knowledgeBases={knowledgeBases}
        installing={installingSkillId === activeSkill.id}
        removing={removingCatalogId === activeSkill.id}
        selected={selectedSkillId === activeSkill.id}
        onClose={() => setActiveSkillId('')}
        onInstall={() => void installSkill(activeSkill)}
        onRemove={activeSkill.installed ? () => void removeCatalogArtifact('skill', activeSkill.id) : undefined}
        onUse={() => useSkill(activeSkill)}
      />}
    </div>
  )
}

function ExtensionToolbar({ filter, query, onFilter, onQuery }: {
  filter: ExtensionFilter
  query: string
  onFilter: (value: ExtensionFilter) => void
  onQuery: (value: string) => void
}) {
  const filters: Array<{ id: ExtensionFilter; label: string }> = [
    { id: 'all', label: '全部' }, { id: 'installed', label: '已安装' },
    { id: 'available', label: '可安装 / 更新' }, { id: 'attention', label: '需要处理' },
  ]
  return <div className="extension-toolbar">
    <label><Search size={14} /><input aria-label="搜索扩展" onChange={(event) => onQuery(event.target.value)} placeholder="搜索名称、说明或 ID" value={query} />{query && <button aria-label="清空搜索" onClick={() => onQuery('')} type="button"><X size={12} /></button>}</label>
    <div>{filters.map((item) => <button className={filter === item.id ? 'active' : ''} key={item.id} onClick={() => onFilter(item.id)} type="button">{item.label}</button>)}</div>
  </div>
}

function extensionMatches(
  item: { id: string; name: string; summary: string; installState: string; readiness: string },
  query: string,
  filter: ExtensionFilter,
): boolean {
  const value = query.trim().toLocaleLowerCase('zh-CN')
  if (value && !`${item.name} ${item.summary} ${item.id}`.toLocaleLowerCase('zh-CN').includes(value)) return false
  if (filter === 'installed') return item.installState === 'installed'
  if (filter === 'available') return item.installState === 'available' || item.installState === 'update'
  if (filter === 'attention') return item.installState === 'retired' || item.installState === 'update' || item.readiness === 'partial'
  return true
}
