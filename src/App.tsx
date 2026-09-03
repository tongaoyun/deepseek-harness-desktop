import {
  Bell,
  BookOpenCheck,
  Boxes,
  CircleStop,
  FolderOpen,
  PlugZap,
  ShieldCheck,
  SquareCheckBig,
  WandSparkles,
} from 'lucide-react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
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
  submitDeviceHeartbeat,
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
  installedExtensionSnapshot,
  listInstalledExtensions,
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
  createTaskMonitor,
  listenHarnessNotifications,
  probeHarnessHost,
  revokeLocalDirectory,
  runHarness,
  shutdownHarness,
  type AuthorizedLocalDirectory,
} from './harness'
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
import { ScheduledTasksPage } from './ScheduledTasksPage'
import { ImChannelsPage } from './ImChannelsPage'
import { loadTaskHistory, persistTaskHistory } from './taskHistory'
import { loadLocalImStatus, startLocalIm, stopLocalImRuntime, syncLocalImTasks } from './localIm'
import { mergeImStatusIntoTasks } from './imTaskSync'
import type { LocalTaskRun, TaskExecutionStep, TaskMessage, TaskMonitorState } from './types'
import { memoryInstruction, rememberInstruction } from './memory'
import { modelStorageKey, resolveSelectedModel } from './modelSelection'
import { buildInvocationOptions, filterInvocationOptions, type InvocationOption } from './invocations'
import { needsLocalDirectoryAuthorization } from './localFileIntent'
import { creationPrompt, type XiaoyinCreationKind } from './creationPrompts'
import { buildRuntimeConnectorCatalog, withDesktopBuiltinConnectors } from './connectors'
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
import { mergeSkills, type SkillView } from './skills'
import { allowedExtensionArtifacts } from './extensionPolicy'
import { connectorsForSnapshot, createCapabilitySnapshot } from './capabilitySnapshot'
import { DesktopSidebar } from './DesktopSidebar'
import { ChatPage } from './ChatPage'
import { cacheAge, loadEnterpriseCatalogCache, saveEnterpriseCatalogCache } from './enterpriseCache'
import { inspectDeviceHeartbeatContext } from './deviceHeartbeat'
import { extensionMatches, type ExtensionFilter } from './ExtensionToolbar'
import type { ExtensionCategoryFilter } from './extensionCategories'
import { ExpertCatalogPage, SkillCatalogPage } from './ExtensionCatalogPages'
import { ExtensionAuthoringModal } from './ExtensionAuthoringModal'
import { loadPersonalConnectors, savePersonalConnector, type ExtensionKind } from './extensionSubmissions'
import { ExtensionPageActions } from './ExtensionPageActions'
import './styles.css'

const extensionNav = [
  { id: 'experts', label: '专家套件', icon: Boxes },
  { id: 'skills', label: '技能', icon: WandSparkles },
  { id: 'connectors', label: '连接器', icon: PlugZap },
  { id: 'knowledge', label: '知识库', icon: BookOpenCheck },
]

interface ExtensionSyncIssue {
  key: string
  label: string
  message: string
}

type HarnessHealth = 'checking' | 'ready' | 'degraded'

export default function App() {
  const { accessToken, authorizing, error: authError, logout, reopen, state: authState, user } = useEnterpriseSession()
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
  const [authoringKind, setAuthoringKind] = useState<ExtensionKind>()
  const [enabledConnectorIds, setEnabledConnectorIds] = useState<string[]>([])
  const [connectorSecrets, setConnectorSecrets] = useState<ConnectorSecretStore>({})
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseEntry[]>([])
  const [expertKitsLoading, setExpertKitsLoading] = useState(false)
  const [expertKitError, setExpertKitError] = useState('')
  const [extensionSyncIssues, setExtensionSyncIssues] = useState<ExtensionSyncIssue[]>([])
  const [extensionSyncAttempt, setExtensionSyncAttempt] = useState(0)
  const [extensionSyncedAt, setExtensionSyncedAt] = useState<Date>()
  const [catalogCacheSavedAt, setCatalogCacheSavedAt] = useState('')
  const [catalogCacheStale, setCatalogCacheStale] = useState(false)
  const [developerKitBusy, setDeveloperKitBusy] = useState(false)
  const [installingKitId, setInstallingKitId] = useState('')
  const [installingSkillId, setInstallingSkillId] = useState('')
  const [removingCatalogId, setRemovingCatalogId] = useState('')
  const [activeExpertKitId, setActiveExpertKitId] = useState('')
  const [activeSkillId, setActiveSkillId] = useState('')
  const [selectedExpertKitId, setSelectedExpertKitId] = useState('')
  const [selectedSkillId, setSelectedSkillId] = useState('')
  const [harnessSessionId, setHarnessSessionId] = useState('')
  const [currentCapabilitySnapshot, setCurrentCapabilitySnapshot] = useState<import('./types').CapabilitySnapshot>()
  const [selectedKnowledgeBaseRefs, setSelectedKnowledgeBaseRefs] = useState<string[]>([])
  const [harnessRunning, setHarnessRunning] = useState(false)
  const [harnessHealth, setHarnessHealth] = useState<HarnessHealth>('checking')
  const [harnessHealthDetail, setHarnessHealthDetail] = useState('正在检查本地 Agent')
  const [harnessHealthAttempt, setHarnessHealthAttempt] = useState(0)
  const [localImError, setLocalImError] = useState('')
  const [failedCloudRuns, setFailedCloudRuns] = useState<CloudTaskRun[]>([])
  const [taskMonitor, setTaskMonitor] = useState<TaskMonitorState>(createTaskMonitor)
  const taskMonitorRef = useRef<TaskMonitorState>(taskMonitor)
  const extensionPreviewRunningRef = useRef(false)
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
  const [extensionFilter, setExtensionFilter] = useState<ExtensionFilter>('market')
  const [extensionCategory, setExtensionCategory] = useState<ExtensionCategoryFilter>('all')
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
      setEnabledConnectorIds([])
      setConnectorSecrets({})
      return
    }
    setEnabledConnectorIds(loadEnabledConnectorIds(user.userId))
    setConnectorSecrets(loadConnectorSecrets(user.userId))
  }, [user])

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
          const personal = loadPersonalConnectors(user.userId)
          setConnectorSecrets(loadConnectorSecrets(user.userId))
          const cachedConnectors = withDesktopBuiltinConnectors([...personal, ...cached.connectors.filter((item) => !personal.some((value) => value.id === item.id))])
          extensionCacheRef.current.connectors = cachedConnectors
          setConnectors(cachedConnectors)
          setKnowledgeBases(cached.knowledge)
          setSkillViews(mergeSkills(cached.skills, extensionCacheRef.current.installed, cachedConnectors, cached.knowledge, enabledConnectorIds))
          setExpertKits(mergeExpertKits(cached.catalog, extensionCacheRef.current.installed, cachedConnectors, cached.knowledge, enabledConnectorIds))
        }
      }
      const [catalogResult, installedResult, skillsResult, connectorsResult, knowledgeResult] = await Promise.allSettled([
        loadExpertKits(bootstrap.endpoints.expertKits, user.userId, accessToken, controller.signal),
        listInstalledExtensions(),
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
        if (connectorsResult.status === 'fulfilled') {
          const personal = loadPersonalConnectors(user.userId)
          setConnectorSecrets(loadConnectorSecrets(user.userId))
          cache.connectors = withDesktopBuiltinConnectors([...personal, ...connectorsResult.value.filter((item) => !personal.some((value) => value.id === item.id))])
        }
        if (knowledgeResult.status === 'fulfilled') cache.knowledge = knowledgeResult.value
        setExpertKitCatalog(cache.catalog)
        setSkills(cache.skills)
        setSkillViews(mergeSkills(cache.skills, cache.installed, cache.connectors, cache.knowledge, enabledConnectorIds))
        setConnectors(cache.connectors)
        setKnowledgeBases(cache.knowledge)
        setExpertKits(mergeExpertKits(cache.catalog, cache.installed, cache.connectors, cache.knowledge, enabledConnectorIds))
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
  }, [accessToken, bootstrap, enabledConnectorIds, extensionSyncAttempt, user])

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
      connectors: buildRuntimeConnectorCatalog(connectors, bootstrap.endpoints.erpMcp, enabledConnectorIds, connectorSecrets),
      allowedArtifacts,
      model: selectedModel || bootstrap.models[0] || 'deepseek-v4-flash',
      modelApiKey: bootstrap.modelApiKey,
      accessToken,
    }).then(async (status) => {
      setLocalImError(status.lastError ?? '')
      if (status.enabled) await syncLocalImTasks(localTasks.filter((task) => task.sessionId && !task.archivedAt)
        .map((task) => ({ id: task.id, name: task.name, sessionId: task.sessionId! })))
    })
      .catch((reason) => setLocalImError(reason instanceof Error ? reason.message : String(reason)))
  }, [accessToken, allowedArtifacts, authState, bootstrap, connectors, connectorSecrets, enabledConnectorIds, selectedModel, user])

  useEffect(() => {
    if (authState !== 'authenticated' || !user) return
    let disposed = false
    const synchronize = async () => {
      try {
        await syncLocalImTasks(localTasks.filter((task) => task.sessionId && !task.archivedAt)
          .map((task) => ({ id: task.id, name: task.name, sessionId: task.sessionId! })))
        const status = await loadLocalImStatus()
        if (disposed || !status.enabled) return
        const merged = mergeImStatusIntoTasks(localTasks, status)
        if (merged.changed.length === 0) return
        setLocalTasks(merged.tasks)
        for (const task of merged.changed) void persistTaskHistory(user.userId, task)
        const current = merged.changed.find((task) => task.id === currentLocalTaskId)
        if (current) {
          setMessages(current.messages)
          setHarnessSessionId(current.sessionId ?? '')
          taskMonitorRef.current = current.monitor
          setTaskMonitor(current.monitor)
        }
      } catch {
        // Runtime may be disabled or restarting; the next poll retries.
      }
    }
    void synchronize()
    const timer = window.setInterval(() => void synchronize(), 3_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [authState, currentLocalTaskId, localTasks, user])

  useEffect(() => {
    let disposed = false
    let unlisten: () => void = () => undefined
    void listenHarnessNotifications((notification) => {
      if (!disposed && !extensionPreviewRunningRef.current) {
        const next = applyHarnessNotification(taskMonitorRef.current, notification)
        taskMonitorRef.current = next
        setTaskMonitor(next)
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
  }, [messages, taskMonitor.updatedAt])

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }, [page])

  useEffect(() => {
    if (authState !== 'authenticated' || runtimeStatus !== 'ready' || !bootstrap || !user) return
    let stopped = false
    const heartbeat = async () => {
      try {
        const context = await inspectDeviceHeartbeatContext()
        const installed = await listInstalledExtensions()
        if (!stopped && /^\d+\.\d+\.\d+$/.test(context.desktopVersion)) {
          await submitDeviceHeartbeat(bootstrap.endpoints.deviceCapabilities ?? '/api/v1/device-capabilities',
            user.userId, accessToken, { ...context, installedExtensions: installedExtensionSnapshot(installed, [
              ...expertKitCatalog.map(({ id, version }) => ({ kind: 'expert-kit' as const, id, version })),
              ...skills.map(({ id, version }) => ({ kind: 'skill' as const, id, version })),
            ]) })
        }
      } catch { /* best effort: control-plane inventory must never interrupt employee work */ }
    }
    void heartbeat()
    const timer = window.setInterval(() => void heartbeat(), 6 * 60 * 60 * 1000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [accessToken, authState, bootstrap, expertKitCatalog, runtimeStatus, skills, user])

  useEffect(() => {
    if (authState !== 'authenticated' || runtimeStatus !== 'ready' || !bootstrap || !user) return
    let stopped = false
    const refreshFailures = async () => {
      try {
        const values = await loadCloudTaskRuns(bootstrap.endpoints.taskRuns, user.userId, accessToken)
        const cutoff = Date.now() - 24 * 60 * 60 * 1_000
        if (!stopped) setFailedCloudRuns(values.filter((run) => run.status === 'FAILED' && Date.parse(run.startedAt) >= cutoff).slice(0, 5))
      } catch { /* scheduled task history remains available when background polling is unavailable */ }
    }
    void refreshFailures()
    const timer = window.setInterval(() => void refreshFailures(), 60_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [accessToken, authState, bootstrap, runtimeStatus, user])

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
  const selectedSkill = skillViews.find((skill) => skill.id === selectedSkillId
    && (skill.installState === 'installed' || skill.installState === 'update'))
  const activeExpertKit = expertKits.find((kit) => kit.id === activeExpertKitId)
  const activeSkill = skillViews.find((skill) => skill.id === activeSkillId)
  const runtimeConnectors = buildRuntimeConnectorCatalog(
    connectors, bootstrap?.endpoints.erpMcp ?? '', enabledConnectorIds, connectorSecrets,
  )
  const toggleConnector = (connectorId: string, enabled: boolean) => {
    if (!user) return
    setEnabledConnectorIds((current) => saveEnabledConnectorIds(
      user.userId,
      enabled ? [...current, connectorId] : current.filter((id) => id !== connectorId),
    ))
    void shutdownHarness()
  }
  const invocationOptions = buildInvocationOptions(expertKits, skillViews)
  const visibleInvocations = filterInvocationOptions(invocationOptions, prompt)
  const contextQuery = prompt.startsWith('@') && !/\s/.test(prompt.slice(1))
    ? prompt.slice(1).toLocaleLowerCase('zh-CN') : undefined
  const visibleKnowledgeContexts = contextQuery === undefined || currentCapabilitySnapshot ? [] : knowledgeBases
    .filter((item) => !selectedKnowledgeBaseRefs.includes(item.reference)
      && (!contextQuery || `${item.name} ${item.description} ${item.reference}`.toLocaleLowerCase('zh-CN').includes(contextQuery)))
    .slice(0, 8)
  const activeModel = selectedModel || bootstrap?.models[0] || 'deepseek-v4-flash'
  const selectedEnterpriseCapability = Boolean(selectedExpertKit || selectedSkill)
  const selectedCapabilityExecutable = !selectedEnterpriseCapability || !catalogCacheStale
  const activeLocalTasks = localTasks.filter((task) => !task.archivedAt)
  const visibleLocalTasks = taskQuery.trim()
    ? activeLocalTasks.filter((task) => task.name.toLocaleLowerCase().includes(taskQuery.trim().toLocaleLowerCase()))
    : activeLocalTasks
  const focusComposer = () => window.requestAnimationFrame(() => composerRef.current?.focus())
  const setTaskMonitorActivity = (activity: string) => {
    const next = { ...taskMonitorRef.current, activity, updatedAt: new Date().toISOString() }
    taskMonitorRef.current = next
    setTaskMonitor(next)
  }
  const startNewTask = (initialPrompt = '') => {
    setPage('chat')
    setTaskSearchOpen(false)
    setTaskQuery('')
    setMessages([])
    setPrompt(initialPrompt)
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
    setSelectedKnowledgeBaseRefs([])
    setSelectedExpertKitId('')
    setSelectedSkillId('')
    setCurrentLocalTaskId('')
    const monitor = createTaskMonitor()
    taskMonitorRef.current = monitor
    setTaskMonitor(monitor)
    setLocalDirectories([])
    setLocalFileError('')
    void Promise.all([clearLocalDirectories(), shutdownHarness()])
    focusComposer()
  }
  const newTask = () => startNewTask()
  const createWithXiaoyin = (kind: XiaoyinCreationKind) => startNewTask(creationPrompt(kind))
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
    setCurrentCapabilitySnapshot(task.capabilitySnapshot)
    setSelectedKnowledgeBaseRefs(task.capabilitySnapshot?.knowledgeBaseRefs ?? [])
    setSelectedExpertKitId(task.expertKitId ?? '')
    setSelectedSkillId(task.skillId ?? '')
    setSelectedModel(resolveSelectedModel(bootstrap?.models ?? [], task.model ?? selectedModel))
    setPrompt('')
    taskMonitorRef.current = task.monitor
    setTaskMonitor(task.monitor)
    setLocalDirectories([])
    setLocalFileError('')
    void Promise.all([clearLocalDirectories(), shutdownHarness()])
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
    let taskSessionId = harnessSessionId
    if (taskDirectories.length === 0 && needsLocalDirectoryAuthorization(input)) {
      setLocalFileError('')
      try {
        const authorization = await authorizeLocalDirectory()
        if (!authorization) {
          setLocalFileError('需要先选择允许小胤访问的文件夹，任务内容已保留。')
          return
        }
        taskDirectories = [authorization]
        taskSessionId = ''
        setLocalDirectories(taskDirectories)
        setHarnessSessionId('')
        await shutdownHarness()
      } catch (error) {
        setLocalFileError(error instanceof Error ? error.message : String(error))
        return
      }
    }
    const now = new Date().toISOString()
    const capabilitySnapshot = currentCapabilitySnapshot
      ?? createCapabilitySnapshot(expertKits, skillViews, runtimeConnectors, selectedKnowledgeBaseRefs, now)
    if (!currentCapabilitySnapshot) setCurrentCapabilitySnapshot(capabilitySnapshot)
    const taskId = currentLocalTaskId || crypto.randomUUID()
    const existingTask = localTasks.find((task) => task.id === taskId)
    const pendingMessages: TaskMessage[] = [...messages, { role: 'user', text: input },
      { role: 'assistant', text: '正在分析任务…', pending: true }]
    const runningMonitor: TaskMonitorState = {
      ...(existingTask?.monitor ?? createTaskMonitor(now)),
      status: 'running',
      activity: '正在启动本地 Agent',
      updatedAt: now,
    }
    const runningTask: LocalTaskRun = {
      id: taskId,
      source: 'DESKTOP',
      name: existingTask?.name ?? input.slice(0, 60),
      status: 'RUNNING',
      createdAt: existingTask?.createdAt ?? now,
      updatedAt: now,
      sessionId: taskSessionId || existingTask?.sessionId,
      expertKitId: selectedExpertKit?.id,
      skillId: selectedSkill?.id,
      model: activeModel,
      capabilitySnapshot,
      monitor: runningMonitor,
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
    taskMonitorRef.current = runningMonitor
    setTaskMonitor(runningMonitor)
    try {
      const result = await runHarness({
        prompt: input,
        employeeId: user!.userId,
        teamId: user!.teamId,
        ...(taskSessionId ? { sessionId: taskSessionId } : {}),
        ...(selectedExpertKit
          ? { selectedExtension: { kind: 'expert-kit' as const, id: selectedExpertKit.id } }
          : selectedSkill ? { selectedExtension: { kind: 'skill' as const, id: selectedSkill.id } } : {}),
        litellmBaseUrl: bootstrap.endpoints.litellm,
        knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
        connectors: connectorsForSnapshot(capabilitySnapshot, connectorSecrets),
        allowedArtifacts: capabilitySnapshot.extensions,
        knowledgeBaseRefs: capabilitySnapshot.knowledgeBaseRefs,
        model: activeModel,
        modelApiKey: bootstrap.modelApiKey,
        accessToken,
        localFileRootIds: taskDirectories.map((directory) => directory.id),
      })
      if (!result.finalResponse.trim()) throw new Error('模型本轮没有返回可显示文本，请重试')
      setHarnessSessionId(result.sessionId)
      const completedMessages = pendingMessages.map((message, index) => index === pendingMessages.length - 1
        ? { role: 'assistant', text: result.finalResponse }
        : message) as TaskMessage[]
      const completedMonitor: TaskMonitorState = {
        ...taskMonitorRef.current, status: 'completed', activity: '任务已完成', updatedAt: new Date().toISOString(),
      }
      taskMonitorRef.current = completedMonitor
      setTaskMonitor(completedMonitor)
      setMessages(completedMessages)
      persistLocalTask({ ...runningTask, status: 'COMPLETED', updatedAt: new Date().toISOString(),
        sessionId: result.sessionId, monitor: completedMonitor, messages: completedMessages })
      await reportTaskAudit('SUCCEEDED', taskId, completedMonitor.steps)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const canceled = cancellationRequestedRef.current
      const failedMessages = pendingMessages.map((item, index) => index === pendingMessages.length - 1
        ? { role: 'assistant', text: canceled ? '任务已取消，可修改要求后重新执行。' : `执行失败：${message}` }
        : item) as TaskMessage[]
      const failedMonitor: TaskMonitorState = {
        ...taskMonitorRef.current,
        status: canceled ? 'canceled' : 'failed',
        activity: canceled ? '任务已取消' : '任务执行失败',
        updatedAt: new Date().toISOString(),
      }
      taskMonitorRef.current = failedMonitor
      setTaskMonitor(failedMonitor)
      setMessages(failedMessages)
      persistLocalTask({ ...runningTask, status: canceled ? 'CANCELED' : 'FAILED', updatedAt: new Date().toISOString(), monitor: failedMonitor, messages: failedMessages })
      if (!canceled) {
        setHarnessHealth('degraded')
        setHarnessHealthDetail(`Harness 执行异常：${message}`)
      }
      void shutdownHarness()
      await reportTaskAudit('FAILED', taskId, failedMonitor.steps)
    } finally {
      setHarnessRunning(false)
      cancellationRequestedRef.current = false
    }
  }

  const cancelCurrentTask = async () => {
    if (!harnessRunning || cancellationRequestedRef.current) return
    cancellationRequestedRef.current = true
    setTaskMonitorActivity('正在取消当前任务')
    try {
      const canceled = await cancelHarness()
      if (!canceled) {
        cancellationRequestedRef.current = false
        setTaskMonitorActivity('当前任务即将完成，暂时无法取消')
      }
    } catch (reason) {
      cancellationRequestedRef.current = false
      setTaskMonitorActivity('取消失败，任务仍在执行')
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
      const installed = await installExtension(download, 'expert-kit')
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
    const installed = await listInstalledExtensions()
    extensionCacheRef.current.installed = installed
    setExpertKits(mergeExpertKits(expertKitCatalog, installed, connectors, knowledgeBases, enabledConnectorIds))
    setSkillViews(mergeSkills(skills, installed, connectors, knowledgeBases, enabledConnectorIds))
    if (bootstrap && user) {
      const context = await inspectDeviceHeartbeatContext()
      if (/^\d+\.\d+\.\d+$/.test(context.desktopVersion)) {
        await submitDeviceHeartbeat(bootstrap.endpoints.deviceCapabilities ?? '/api/v1/device-capabilities',
          user.userId, accessToken, { ...context, installedExtensions: installedExtensionSnapshot(installed, [
            ...expertKitCatalog.map(({ id, version }) => ({ kind: 'expert-kit' as const, id, version })),
            ...skills.map(({ id, version }) => ({ kind: 'skill' as const, id, version })),
          ]) })
          .catch(() => undefined)
      }
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
      if (path) window.alert(`定制副本已创建，请修改版本号后重新导入：\n${path}`)
    } catch (error) { setExpertKitError(error instanceof Error ? error.message : String(error)) }
  }

  const exportLocalExpertKit = async (kit: ExpertKitView) => {
    try {
      const path = await exportExpertKit(kit.id, kit.installed?.manifest.version ?? kit.version)
      if (path) window.alert(`专家套件已导出：\n${path}`)
    } catch (error) { setExpertKitError(error instanceof Error ? error.message : String(error)) }
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
    if (!['installed', 'update'].includes(kit.installState)) return
    if (messages.length > 0) {
      setMessages([])
      setCurrentLocalTaskId('')
      setSelectedKnowledgeBaseRefs([])
    }
    setSelectedExpertKitId(kit.id)
    setSelectedSkillId('')
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
    setPage('chat')
    setPrompt('')
    setActiveExpertKitId('')
    focusComposer()
  }

  const useSkill = (skill: SkillView) => {
    if (!['installed', 'update'].includes(skill.installState)) return
    if (messages.length > 0) {
      setMessages([])
      setCurrentLocalTaskId('')
      setSelectedKnowledgeBaseRefs([])
    }
    setSelectedSkillId(skill.id)
    setSelectedExpertKitId('')
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
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
    if (messages.length > 0) {
      setMessages([])
      setCurrentLocalTaskId('')
      setSelectedKnowledgeBaseRefs([])
    }
    setSelectedExpertKitId(option.profileKind === 'expert-kit' ? option.profileId : '')
    setSelectedSkillId(option.profileKind === 'skill' ? option.profileId : '')
    setHarnessSessionId('')
    setCurrentCapabilitySnapshot(undefined)
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
    ...(runtimeStatus === 'offline' ? [{ key: 'control-plane', title: '服务连接失败', detail: '请检查内网连接后重试。', tone: 'danger' }] : []),
    ...(harnessHealth === 'degraded' ? [{ key: 'harness', title: '本地 Agent 需要恢复', detail: harnessHealthDetail, tone: 'danger' }] : []),
    ...(localImError ? [{ key: 'local-im', title: '本机 IM 频道异常', detail: localImError, tone: 'danger' }] : []),
    ...failedCloudRuns.map((run) => ({ key: `run-${run.runId}`, title: `定时任务失败：${run.name}`, detail: new Date(run.startedAt).toLocaleString(), tone: 'danger' })),
    ...extensionSyncIssues.map((issue) => ({ key: `sync-${issue.key}`, title: `${issue.label}同步失败`, detail: issue.message, tone: 'warning' })),
    ...(expertKits.some((kit) => kit.installState === 'update') ? [{ key: 'expert-updates', title: '专家套件有可用更新', detail: `${expertKits.filter((kit) => kit.installState === 'update').length} 个套件等待确认`, tone: 'warning' }] : []),
    ...(skillViews.some((skill) => skill.installState === 'update') ? [{ key: 'skill-updates', title: 'Skills 有可用更新', detail: `${skillViews.filter((skill) => skill.installState === 'update').length} 个 Skill 等待确认`, tone: 'warning' }] : []),
  ]

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      {dragActive && <div className="file-drop-overlay"><FolderOpen size={34} /><strong>松开即可添加到当前任务</strong><span>文件只会授权其所在目录，执行时仍遵循专家套件权限</span></div>}
      <DesktopSidebar
        collapsed={sidebarCollapsed}
        onCloseSearch={() => { setTaskSearchOpen(false); setTaskQuery('') }}
        onFeedback={submitDesktopFeedback}
        onLogout={logoutWithCleanup}
        onNewTask={newTask}
        onOpenTask={openLocalTask}
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
        {page === 'chat' && <header className="topbar">
          <div className="topbar-tools">
            <div className="notification-center">
              <button aria-expanded={notificationOpen} aria-label="通知中心" className="notification-trigger" onClick={() => setNotificationOpen((value) => !value)} type="button"><Bell size={16} />{notifications.length > 0 && <span>{notifications.length}</span>}</button>
              {notificationOpen && <section className="notification-popover"><header><strong>通知中心</strong><small>{notifications.length ? `${notifications.length} 项需要处理` : '当前运行正常'}</small></header>{notifications.length
                ? notifications.map((item) => <article className={item.tone} key={item.key}><i /><span><strong>{item.title}</strong><small>{item.detail}</small></span></article>)
                : <div className="notification-empty"><SquareCheckBig size={20} />暂无待处理事项</div>}
                {notifications.length > 0 && <footer><button onClick={() => { setNotificationOpen(false); if (runtimeStatus === 'offline') setConnectionAttempt((value) => value + 1); else if (harnessHealth === 'degraded') setHarnessHealthAttempt((value) => value + 1); else setPage(localImError ? 'im' : failedCloudRuns.length ? 'schedules' : expertKits.some((kit) => kit.installState === 'update') ? 'experts' : skillViews.some((skill) => skill.installState === 'update') ? 'skills' : 'settings') }} type="button">{runtimeStatus === 'offline' ? '重新连接' : harnessHealth === 'degraded' ? '恢复本地 Agent' : localImError ? '打开 IM 频道' : failedCloudRuns.length ? '查看定时任务' : expertKits.some((kit) => kit.installState === 'update') ? '查看套件更新' : skillViews.some((skill) => skill.installState === 'update') ? '查看 Skill 更新' : '打开设置'}</button></footer>}
              </section>}
            </div>
          </div>
        </header>}

        {page === 'chat' ? (
          <ChatPage
            activeModel={activeModel}
            capabilitySnapshot={currentCapabilitySnapshot}
            composerRef={composerRef}
            contextQuery={contextQuery}
            harnessHealth={harnessHealth}
            harnessHealthDetail={harnessHealthDetail}
            harnessRunning={harnessRunning}
            knowledgeBases={knowledgeBases}
            localDirectories={localDirectories}
            localFileError={localFileError}
            messageListRef={messageListRef}
            messages={messages}
            modelMenuOpen={modelMenuOpen}
            modelPickerRef={modelPickerRef}
            models={bootstrap?.models ?? []}
            onAddKnowledge={(reference) => { setSelectedKnowledgeBaseRefs((current) => [...current, reference]); setPrompt(''); focusComposer() }}
            onAddLocalDirectory={() => void addLocalDirectory()}
            onCancel={() => void cancelCurrentTask()}
            onCapabilityPage={() => setPage(selectedSkill ? 'skills' : 'experts')}
            onPrepareRetry={prepareRetry}
            onPrompt={(value) => { setPrompt(value); focusComposer() }}
            onRecoverHarness={() => setHarnessHealthAttempt((value) => value + 1)}
            onRemoveKnowledge={(reference) => setSelectedKnowledgeBaseRefs((current) => current.filter((item) => item !== reference))}
            onRemoveLocalDirectory={(id) => void removeLocalDirectory(id)}
            onSelectInvocation={selectInvocation}
            onSelectModel={selectModel}
            onSubmit={(event) => void submit(event)}
            onToggleModelMenu={() => setModelMenuOpen((value) => !value)}
            prompt={prompt}
            runtimeStatus={runtimeStatus}
            selectedCapabilityExecutable={Boolean(bootstrap) && selectedCapabilityExecutable}
            selectedCapabilityName={selectedExpertKit?.name ?? selectedSkill?.name ?? '通用'}
            selectedKnowledgeBaseRefs={selectedKnowledgeBaseRefs}
            taskMonitor={taskMonitor}
            visibleInvocations={visibleInvocations}
            visibleKnowledgeContexts={visibleKnowledgeContexts}
          />
        ) : (
          <section className="capability-page">
            {page !== 'schedules' && <div className="capability-page-heading"><div>
            <h1>{extensionNav.find((item) => item.id === page)?.label ?? ({ settings: '桌面设置', schedules: '定时任务', im: 'IM 频道' } as Record<string, string>)[page]}</h1>
            <p>{page === 'experts'
              ? '专家套件是面向角色或行业的工具套件，在对话框中输入 @ 或 / 即可使用。'
              : page === 'skills'
                ? '安装与管理技能，在对话中扩展小胤的能力。'
                  : page === 'connectors'
                    ? '连接外部应用、日历与服务，让你的工作流更顺畅。'
                  : page === 'knowledge'
                    ? '集中管理公司文档；索引任务由 Temporal 托管，回答可引用文件与页码或工作表。'
                  : page === 'im'
                    ? '把钉钉等公司消息入口连接到本机小胤 Harness，集中查看连接和处理状态。'
                  : page === 'settings'
                    ? '管理企业身份、个人记忆、快捷键与应用更新。'
                    : '这里将由控制中心下发公司自己的能力与权限配置。'}</p></div>{(page === 'experts' || page === 'skills' || page === 'connectors') && <ExtensionPageActions
              loading={expertKitsLoading}
              onCreate={() => {
                if (page === 'experts' || page === 'skills') createWithXiaoyin(page === 'experts' ? 'expert-kit' : 'skill')
                else setAuthoringKind('connector')
              }}
              onImportConnector={(connector) => {
                if (!user) return
                const values = connectorSecretValues(connector)
                const template = connectorSecretTemplate(connector)
                savePersonalConnector(user.userId, connector)
                setConnectorSecrets(saveConnectorSecrets(user.userId, connector.id, values))
                const next = [template, ...connectors.filter((item) => item.id !== connector.id)]
                extensionCacheRef.current.connectors = next
                setConnectors(next)
                setEnabledConnectorIds((current) => saveEnabledConnectorIds(user.userId, [...new Set([...current, connector.id])]))
              }}
              onQuery={setExtensionQuery}
              onRefresh={() => setExtensionSyncAttempt((value) => value + 1)}
              onUpload={() => void installLocalExtension(page === 'skills' ? 'skill' : 'expert-kit')}
              page={page}
              query={extensionQuery}
            />}</div>}
            {extensionSyncIssues.length > 0 && <div className="sync-diagnostics"><div><CircleStop size={17} /><span><strong>部分企业能力同步失败，已保留上次成功数据</strong><small>{extensionSyncedAt ? `最近尝试 ${extensionSyncedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '刚刚尝试同步'}</small></span><button onClick={() => setExtensionSyncAttempt((value) => value + 1)} type="button">重新同步</button></div><details><summary>查看 {extensionSyncIssues.length} 项失败详情</summary>{extensionSyncIssues.map((issue) => <p key={issue.key}><strong>{issue.label}</strong><span>{issue.message}</span></p>)}</details></div>}
            {catalogCacheSavedAt && extensionSyncIssues.length > 0 && <div className={`catalog-cache-state ${catalogCacheStale ? 'stale' : ''}`}><ShieldCheck size={15} /><span>{catalogCacheStale ? '本机企业目录缓存已超过 7 天，浏览仍可用，但相关能力暂停执行。' : `当前显示本机缓存 · ${new Date(catalogCacheSavedAt).toLocaleString('zh-CN', { hour12: false })}`}</span></div>}
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
                  setConnectorSecrets(saveConnectorSecrets(user.userId, connectorId, values))
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
              expertKits={expertKits}
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
        employeeId={user.userId}
        initialKind={authoringKind}
        onClose={() => setAuthoringKind(undefined)}
        onPreviewRunningChange={(running) => { extensionPreviewRunningRef.current = running }}
        previewConfig={!harnessRunning && runtimeStatus === 'ready' && bootstrap ? {
          employeeId: user.userId,
          teamId: user.teamId,
          litellmBaseUrl: bootstrap.endpoints.litellm,
          knowledgeEndpoint: resolveControlPlaneEndpoint(bootstrap.endpoints.knowledge),
          connectors: runtimeConnectors,
          allowedArtifacts,
          model: activeModel,
          modelApiKey: bootstrap.modelApiKey,
          accessToken,
          localFileRootIds: localDirectories.map((directory) => directory.id),
        } : undefined}
        previewUnavailableReason={harnessRunning ? '当前已有本地任务在运行，请完成或停止后再试运行。' : runtimeStatus !== 'ready' ? '企业服务尚未连接，暂时不能试运行。' : undefined}
        skills={skillViews}
        onChanged={async (change) => {
          if (change.type === 'connector-upsert') {
            const connector = change.connector
            setConnectorSecrets(saveConnectorSecrets(user.userId, connector.id, change.secrets))
            const next = [connector, ...connectors.filter((item) => item.id !== connector.id)]
            extensionCacheRef.current.connectors = next
            setConnectors(next)
            setEnabledConnectorIds((current) => saveEnabledConnectorIds(user.userId, [...current, connector.id]))
          } else if (change.type === 'connector-delete') {
            setConnectorSecrets(deleteConnectorSecrets(user.userId, change.id))
            const next = connectors.filter((item) => item.id !== change.id)
            extensionCacheRef.current.connectors = next
            setConnectors(next)
            setEnabledConnectorIds((current) => saveEnabledConnectorIds(user.userId, current.filter((id) => id !== change.id)))
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
        selected={selectedSkillId === activeSkill.id}
        onClose={() => setActiveSkillId('')}
        onInstall={() => void installSkill(activeSkill)}
        onRemove={activeSkill.installed ? () => void removeCatalogArtifact('skill', activeSkill.id) : undefined}
        onUse={() => useSkill(activeSkill)}
      />}
    </div>
  )
}
