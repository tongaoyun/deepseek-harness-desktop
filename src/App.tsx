import {
  BookOpenCheck,
  Bot,
  Boxes,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  CirclePlus,
  FolderOpen,
  HelpCircle,
  LogOut,
  MessageSquare,
  Mic,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  PlugZap,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  SquareCheckBig,
  Store,
  WandSparkles,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  createExpertKitDownload,
  loadBootstrap,
  loadConnectors,
  loadExpertKits,
  loadSkills,
} from './api'
import { DesktopUpdater } from './DesktopUpdater'
import { ErpAuthScreen } from './ErpAuthScreen'
import {
  installExpertKit,
  listInstalledExpertKits,
  mergeExpertKits,
  type ExpertKitView,
} from './expertKits'
import {
  authorizeLocalDirectory,
  clearLocalDirectories,
  harnessActivityLabel,
  listenHarnessNotifications,
  revokeLocalDirectory,
  runHarness,
  shutdownHarness,
  type AuthorizedLocalDirectory,
} from './harness'
import type {
  BootstrapResponse,
  ConnectorCatalogEntry,
  RuntimeStatus,
  SkillCatalogEntry,
} from './types'
import { useEnterpriseSession } from './useEnterpriseSession'
import { XiaoyinMascot } from './XiaoyinMascot'
import { ScheduledTasksPage } from './ScheduledTasksPage'
import { TaskCenterPage } from './TaskCenterPage'
import { ImChannelsPage } from './ImChannelsPage'
import { loadLocalTasks, saveLocalTask } from './taskHistory'
import { startLocalIm, stopLocalImRuntime } from './localIm'
import type { LocalTaskRun, TaskMessage } from './types'
import { MemoryPage } from './MemoryPage'
import { modelDisplayName, modelStorageKey, resolveSelectedModel } from './modelSelection'
import { buildInvocationOptions, filterInvocationOptions, type InvocationOption } from './invocations'
import { buildRuntimeConnectorCatalog } from './connectors'
import './styles.css'

const extensionNav = [
  { id: 'experts', label: '专家套件', icon: Boxes },
  { id: 'skills', label: '技能', icon: WandSparkles },
  { id: 'connectors', label: '连接器', icon: PlugZap },
  { id: 'knowledge', label: '知识库', icon: BookOpenCheck },
]

const starterTasks = [
  { icon: SquareCheckBig, title: '订单异常诊断', detail: '定位履约风险与待办', prompt: '分析昨天的订单异常，并给出处理优先级' },
  { icon: Boxes, title: '库存风险分析', detail: '识别缺货与滞销商品', prompt: '分析本周库存风险，列出需要补货的商品' },
  { icon: Store, title: 'Listing 优化', detail: '生成更专业的商品内容', prompt: '帮我优化这个商品的 Listing 内容' },
]

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
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([])
  const [connectors, setConnectors] = useState<ConnectorCatalogEntry[]>([])
  const [expertKitsLoading, setExpertKitsLoading] = useState(false)
  const [expertKitError, setExpertKitError] = useState('')
  const [installingKitId, setInstallingKitId] = useState('')
  const [selectedExpertKitId, setSelectedExpertKitId] = useState('')
  const [harnessSessionId, setHarnessSessionId] = useState('')
  const [harnessRunning, setHarnessRunning] = useState(false)
  const [harnessActivity, setHarnessActivity] = useState('')
  const [localDirectories, setLocalDirectories] = useState<AuthorizedLocalDirectory[]>([])
  const [localFileError, setLocalFileError] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [modelMenuOpen, setModelMenuOpen] = useState(false)

  useEffect(() => {
    if (authState !== 'authenticated' || !user) return
    const controller = new AbortController()
    setRuntimeStatus('connecting')
    loadBootstrap(user.userId, accessToken, controller.signal)
      .then((value) => { setBootstrap(value); setRuntimeStatus('ready') })
      .catch(() => setRuntimeStatus('offline'))
    return () => controller.abort()
  }, [accessToken, authState, user])

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
    setLocalTasks(loadLocalTasks(user.userId))
  }, [authState, user])

  useEffect(() => {
    if (!bootstrap || !user) return
    const controller = new AbortController()
    setExpertKitsLoading(true)
    setExpertKitError('')
    Promise.allSettled([
      loadExpertKits(bootstrap.endpoints.expertKits, user.userId, accessToken, controller.signal),
      listInstalledExpertKits(),
      loadSkills(bootstrap.endpoints.skills, user.userId, accessToken, controller.signal),
      loadConnectors(bootstrap.endpoints.connectors, user.userId, accessToken, controller.signal),
    ])
      .then(([catalogResult, installedResult, skillsResult, connectorsResult]) => {
        if (controller.signal.aborted) return
        const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : []
        const installed = installedResult.status === 'fulfilled' ? installedResult.value : []
        const skillCatalog = skillsResult.status === 'fulfilled' ? skillsResult.value : []
        const connectorCatalog = connectorsResult.status === 'fulfilled' ? connectorsResult.value : []
        setSkills(skillCatalog)
        setConnectors(connectorCatalog)
        setExpertKits(mergeExpertKits(catalog, installed, connectorCatalog))
        const failures = [catalogResult, installedResult, skillsResult, connectorsResult]
          .flatMap((result) => result.status === 'rejected'
            ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
            : [])
        if (failures.length > 0) {
          setExpertKitError(`部分企业能力同步失败：${failures.join('；')}`)
        }
      })
      .finally(() => { if (!controller.signal.aborted) setExpertKitsLoading(false) })
    return () => controller.abort()
  }, [accessToken, bootstrap, user])

  useEffect(() => {
    if (!bootstrap || !user || authState !== 'authenticated') return
    void startLocalIm({
      employeeId: user.userId,
      litellmBaseUrl: bootstrap.endpoints.litellm,
      connectors: buildRuntimeConnectorCatalog(connectors, bootstrap.endpoints.erpMcp),
      model: selectedModel || bootstrap.models[0] || 'deepseek-v4-flash',
      modelApiKey: bootstrap.modelApiKey,
      accessToken,
    }).catch(() => undefined)
  }, [accessToken, authState, bootstrap, connectors, selectedModel, user])

  useEffect(() => {
    let disposed = false
    let unlisten: () => void = () => undefined
    void listenHarnessNotifications((notification) => {
      if (!disposed) setHarnessActivity(harnessActivityLabel(notification))
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

  const statusLabel = useMemo(() => ({
    connecting: '正在连接企业服务',
    ready: '企业服务已连接',
    offline: '企业服务暂不可用',
  })[runtimeStatus], [runtimeStatus])

  if (authState !== 'authenticated') {
    return <ErpAuthScreen checking={authState === 'checking'} error={authError} onReopen={() => void reopen()} />
  }

  const selectedExpertKit = expertKits.find((kit) => kit.id === selectedExpertKitId && kit.installState === 'installed')
  const runtimeConnectors = buildRuntimeConnectorCatalog(connectors, bootstrap?.endpoints.erpMcp ?? '')
  const invocationOptions = buildInvocationOptions(expertKits, skills)
  const visibleInvocations = filterInvocationOptions(invocationOptions, prompt)
  const activeModel = selectedModel || bootstrap?.models[0] || 'deepseek-v4-flash'
  const newTask = () => {
    setPage('chat')
    setMessages([])
    setPrompt('')
    setHarnessSessionId('')
    setCurrentLocalTaskId('')
    setHarnessActivity('')
    setLocalDirectories([])
    setLocalFileError('')
    void Promise.all([clearLocalDirectories(), shutdownHarness()])
  }
  const persistLocalTask = (task: LocalTaskRun) => {
    if (!user) return
    setLocalTasks(saveLocalTask(user.userId, task))
  }
  const openLocalTask = (task: LocalTaskRun) => {
    setPage('chat')
    setMessages(task.messages.map((message) => ({ ...message, pending: false })))
    setCurrentLocalTaskId(task.id)
    setHarnessSessionId(task.sessionId ?? '')
    setSelectedExpertKitId(task.expertKitId ?? '')
    setSelectedModel(resolveSelectedModel(bootstrap?.models ?? [], task.model ?? selectedModel))
    setPrompt('')
    setHarnessActivity('')
    setLocalDirectories([])
    setLocalFileError('')
    void Promise.all([clearLocalDirectories(), shutdownHarness()])
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
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input = prompt.trim()
    if (!input || !bootstrap || harnessRunning) return
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
      expertKitId: selectedExpertKit?.id ?? existingTask?.expertKitId,
      model: activeModel,
      messages: pendingMessages,
    }
    setCurrentLocalTaskId(taskId)
    setMessages(pendingMessages)
    persistLocalTask(runningTask)
    setPrompt('')
    setHarnessRunning(true)
    setHarnessActivity('正在启动本地 Agent')
    try {
      const result = await runHarness({
        prompt: input,
        employeeId: user!.userId,
        ...(harnessSessionId ? { sessionId: harnessSessionId } : {}),
        ...(selectedExpertKit ? { expertKitId: selectedExpertKit.id } : {}),
        litellmBaseUrl: bootstrap.endpoints.litellm,
        connectors: runtimeConnectors,
        model: activeModel,
        modelApiKey: bootstrap.modelApiKey,
        accessToken,
        localFileRootIds: localDirectories.map((directory) => directory.id),
      })
      setHarnessSessionId(result.sessionId)
      const completedMessages = pendingMessages.map((message, index) => index === pendingMessages.length - 1
        ? { role: 'assistant', text: result.finalResponse || '任务已执行完成，但模型没有返回文本。' }
        : message) as TaskMessage[]
      setMessages(completedMessages)
      persistLocalTask({ ...runningTask, status: 'COMPLETED', updatedAt: new Date().toISOString(),
        sessionId: result.sessionId, messages: completedMessages })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failedMessages = pendingMessages.map((item, index) => index === pendingMessages.length - 1
        ? { role: 'assistant', text: `执行失败：${message}` }
        : item) as TaskMessage[]
      setMessages(failedMessages)
      persistLocalTask({ ...runningTask, status: 'FAILED', updatedAt: new Date().toISOString(), messages: failedMessages })
    } finally {
      setHarnessRunning(false)
      setHarnessActivity('')
    }
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

  const useExpertKit = (kit: ExpertKitView) => {
    if (kit.installState !== 'installed') return
    setSelectedExpertKitId(kit.id)
    setHarnessSessionId('')
    setPage('chat')
    setPrompt('')
  }

  const selectModel = (model: string) => {
    setSelectedModel(model)
    setModelMenuOpen(false)
    if (user) window.localStorage.setItem(modelStorageKey(user.userId), model)
  }

  const selectInvocation = (option: InvocationOption) => {
    setSelectedExpertKitId(option.expertKitId)
    setHarnessSessionId('')
    setPrompt(option.kind === 'command'
      ? `/${option.id} `
      : `请使用 skill "${option.id}" 完成：`)
    void shutdownHarness()
  }

  const memorySaved = async () => {
    await Promise.all([shutdownHarness(), stopLocalImRuntime()])
    if (bootstrap) {
      await startLocalIm({
        employeeId: user!.userId,
        litellmBaseUrl: bootstrap.endpoints.litellm,
        connectors: runtimeConnectors,
        model: activeModel,
        modelApiKey: bootstrap.modelApiKey,
        accessToken,
      }).catch(() => undefined)
    }
  }

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <button className="brand-home" onClick={newTask} type="button"><XiaoyinMascot size={38} variant="avatar" /></button>
          <div><strong>小胤</strong><small>跨境电商 AI 工作台</small></div>
          <div className="sidebar-toolbar">
            <button aria-label="搜索任务" title="搜索任务" type="button"><Search size={15} /></button>
            <button aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} onClick={() => setSidebarCollapsed((value) => !value)} type="button">{sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}</button>
          </div>
        </div>
        <button className="new-task" onClick={newTask} type="button"><Plus size={17} /><span>新建任务</span></button>
        <p className="nav-label extension-label"><Boxes size={13} />扩展</p>
        <nav className="extension-nav">
          {extensionNav.map(({ id, label, icon: Icon }) => <button className={page === id ? 'nav-item active' : 'nav-item'} key={id} onClick={() => setPage(id)} type="button"><Icon size={17} /><span>{label}</span>{id === 'skills' && skills.length > 0 && <em>{skills.length}</em>}</button>)}
        </nav>
        <nav className="office-nav">
          <button className={page === 'memory' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('memory')} type="button"><BrainCircuit size={17} /><span>意识</span></button>
          <button className={page === 'schedules' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('schedules')} type="button"><CalendarClock size={17} /><span>定时任务</span></button>
          <button className={page === 'im' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('im')} type="button"><MessageSquare size={17} /><span>IM 频道</span></button>
          <button className={page === 'admin' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('admin')} type="button"><ShieldCheck size={17} /><span>管理中心</span></button>
        </nav>
        <div className="sidebar-segments"><button className={page === 'tasks' ? 'active' : ''} onClick={() => setPage('tasks')} type="button"><SquareCheckBig size={14} />任务</button><button className={page === 'im' ? 'active' : ''} onClick={() => setPage('im')} type="button"><MessageSquare size={14} />频道</button></div>
        <div className="recent-tasks">
          <p className="nav-label">最近</p>
          {localTasks.slice(0, 5).map((task) => <button className="recent-task" key={task.id} onClick={() => openLocalTask(task)} type="button"><span>{task.name}</span><small>{task.status === 'RUNNING' ? '运行中' : task.status === 'COMPLETED' ? '已完成' : '执行失败'}</small></button>)}
          {localTasks.length === 0 && <small className="recent-empty">暂无本机任务</small>}
        </div>
        <div className="sidebar-spacer" />
        <button className="account" type="button"><span>{user?.displayName.slice(0, 1) ?? '员'}</span><div><strong>{user?.displayName ?? '企业员工'} · {user?.department || '跨境运营'}</strong><small>{user?.companyName || '企业内部版'}</small></div><i className={`status-dot ${runtimeStatus}`} /></button>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <span className={`connection-state ${runtimeStatus}`}><i /> 马帮 ERP · {statusLabel}</span>
          <DesktopUpdater />
          <button type="button"><HelpCircle size={15} /> 问题反馈</button>
          <button onClick={() => void logoutWithCleanup()} type="button"><LogOut size={15} /> 退出登录</button>
        </header>

        {page === 'chat' ? (
          <section className={messages.length > 0 ? 'chat-page conversation' : 'chat-page'}>
            {messages.length === 0 && <div className="hero-copy">
              <XiaoyinMascot size={82} variant="hero" />
              <div className="hero-greeting">嗨，我是小胤</div>
              <h1>今天想先处理什么？</h1>
              <p>连接 ERP 数据，让专家 Agent 安全地完成查询、分析与内容生产</p>
              <div className="starter-actions">{starterTasks.map(({ icon: Icon, title, detail, prompt: value }) => <button key={title} onClick={() => setPrompt(value)} type="button"><Icon size={16} /><span><strong>{title}</strong><small>{detail}</small></span></button>)}</div>
            </div>}
            {messages.length > 0 && <div className="message-list">{messages.map((message, index) => <article className={`message ${message.role}${message.pending ? ' pending' : ''}`} key={`${message.role}-${index}`}><span className="message-avatar">{message.role === 'user' ? '你' : <XiaoyinMascot size={29} variant="avatar" />}</span><div><small>{message.role === 'user' ? '你' : '小胤'}</small><p>{message.pending && harnessActivity ? harnessActivity : message.text}</p></div></article>)}</div>}
            <form className="composer" onSubmit={submit}>
              <textarea aria-label="给小胤发送消息" onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} placeholder="描述任务，/ 选择专家套件或技能，@ 添加业务上下文" value={prompt} />
              <div className="composer-actions">
                <button aria-label="授权本地文件夹" className="circle-button" disabled={harnessRunning} onClick={() => void addLocalDirectory()} title="授权本地文件夹" type="button"><CirclePlus size={18} /></button>
                <button className="mode-button" onClick={() => setPage('experts')} type="button"><Sparkles size={14} /> {selectedExpertKit?.name ?? '运营通用'} <ChevronDown size={13} /></button>
                <div className="model-picker">
                  <button aria-expanded={modelMenuOpen} className="model-label" onClick={() => setModelMenuOpen((value) => !value)} type="button"><Bot size={14} /> {modelDisplayName(activeModel)} <ChevronDown size={13} /></button>
                  {modelMenuOpen && <div className="model-menu"><small>公司可用模型</small>{(bootstrap?.models.length ? bootstrap.models : [activeModel]).map((model) => <button className={model === activeModel ? 'active' : ''} key={model} onClick={() => selectModel(model)} type="button"><span><strong>{modelDisplayName(model)}</strong><small>{model}</small></span>{model === activeModel && <SquareCheckBig size={14} />}</button>)}</div>}
                </div>
                <button aria-label="语音输入" className="circle-button" type="button"><Mic size={17} /></button>
                <button aria-label="发送" className="send-button" disabled={!prompt.trim() || harnessRunning || !bootstrap} type="submit"><Send size={17} /></button>
              </div>
              {visibleInvocations.length > 0 && <div className="slash-menu"><small>快捷调用</small>{visibleInvocations.map((option) => <button key={`${option.kind}-${option.expertKitId}-${option.id}`} onClick={() => selectInvocation(option)} type="button"><span><strong>{option.label}</strong><small>{option.description}</small></span><em>{option.expertKitName}</em></button>)}</div>}
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
            <h1>{extensionNav.find((item) => item.id === page)?.label ?? ({ memory: '意识', tasks: '任务中心', schedules: '定时任务', im: 'IM 频道', admin: '管理中心' } as Record<string, string>)[page]}</h1>
            <p>{page === 'experts'
              ? '面向岗位的一整套工作方案，统一组合命令、技能、连接器和后台工作流。'
              : page === 'skills'
                ? '公司沉淀的独立工作方法，可由 Agent 自动识别或在对话中明确调用。'
                : page === 'connectors'
                  ? '连接公司数据和员工电脑能力；账号、地址和令牌由公司统一管理。'
                  : page === 'im'
                    ? '把钉钉等公司消息入口连接到云端小胤 Worker，集中查看连接和处理状态。'
                  : page === 'tasks'
                    ? '统一查看小胤桌面任务、Temporal 云端执行和可下载的结果产物。'
                  : page === 'schedules'
                    ? '按专家套件声明的后台工作流创建任务；任务由 Temporal 托管，关闭电脑后仍会运行。'
                  : page === 'memory'
                    ? '跨会话保留你的协作风格和长期有效的业务工作手册。'
                    : '这里将由控制中心下发公司自己的能力与权限配置。'}</p>
            {page === 'memory' && user && <MemoryPage employeeId={user.userId} onSaved={memorySaved} />}
            {page === 'experts' && <>
              {expertKitsLoading && <div className="kit-empty">正在同步公司专家套件…</div>}
              {!expertKitsLoading && expertKits.length === 0 && <div className="kit-empty">控制中心尚未发布专家套件</div>}
              {expertKitError && <div className="kit-error">{expertKitError}</div>}
              <div className="kit-grid">{expertKits.map((kit) => {
                const installing = installingKitId === kit.id
                const stateLabel = kit.installState === 'installed' ? '已安装' : kit.installState === 'update' ? '可更新' : '可安装'
                return <article key={kit.id}>
                  <div className="kit-card-head"><span className={`kit-state ${kit.installState}`}>{stateLabel}</span><small>v{kit.version}</small></div>
                  <h3>{kit.name}</h3>
                  <p>{kit.summary}</p>
                  <div className="kit-capabilities">
                    <small>{kit.skillIds.length} 个技能</small>
                    <small>{kit.connectorRefs.length} 个连接器</small>
                    <small>{kit.requiredTools.length} 个工具依赖</small>
                  </div>
                  <div className={`kit-readiness ${kit.readiness}`}>
                    {kit.readiness === 'ready'
                      ? '所需连接器已就绪'
                      : `部分能力待启用：${kit.connectorIssues.join('；')}`}
                  </div>
                  {kit.installState === 'update' && <div className="kit-version-note">已安装 v{kit.installedVersion}</div>}
                  <button
                    className="kit-install"
                    disabled={installing || (!kit.sha256 && kit.installState !== 'installed')}
                    onClick={() => kit.installState === 'installed' ? useExpertKit(kit) : void installKit(kit)}
                    type="button"
                  >{installing ? '正在校验并安装…' : kit.installState === 'installed' ? selectedExpertKitId === kit.id ? '正在使用' : '使用套件' : kit.installState === 'update' ? '更新套件' : '安装套件'}</button>
                </article>
              })}</div>
            </>}
            {page === 'skills' && <>
              {expertKitsLoading && <div className="kit-empty">正在同步公司技能…</div>}
              {!expertKitsLoading && skills.length === 0 && <div className="kit-empty">控制中心尚未发布独立技能</div>}
              {expertKitError && <div className="kit-error">{expertKitError}</div>}
              <div className="kit-grid">{skills.map((skill) => {
                const installed = expertKits.some((kit) => kit.installState === 'installed'
                  && kit.installed?.manifest.skills.some((item) => item.id === skill.id))
                const source = expertKits.find((kit) => kit.id === skill.sourceKitId)
                return <article key={skill.id}>
                  <div className="kit-card-head"><span className={`kit-state ${installed ? '' : 'available'}`}>{installed ? '已加载' : '企业技能'}</span><small>v{skill.version}</small></div>
                  <h3>{skill.name}</h3>
                  <p>{skill.summary}</p>
                  <div className="kit-capabilities">{skill.triggers.slice(0, 3).map((trigger) => <small key={trigger}>{trigger}</small>)}</div>
                  <div className="kit-source">{source ? `来自《${source.name}》` : '公司独立 Skill'}</div>
                  {source && <button className="kit-install" onClick={() => setPage('experts')} type="button">{installed ? '查看套件' : '安装所属套件'}</button>}
                </article>
              })}</div>
            </>}
            {page === 'connectors' && <>
              {expertKitsLoading && <div className="kit-empty">正在同步企业连接器…</div>}
              {!expertKitsLoading && connectors.length === 0 && <div className="kit-empty">控制中心尚未配置连接器</div>}
              {expertKitError && <div className="kit-error">{expertKitError}</div>}
              <div className="kit-grid">{connectors.map((connector) => <article key={connector.id}>
                <div className="kit-card-head"><span className={`connector-state ${connector.status}`}>{connectorStatusLabel(connector.status)}</span><small>{connector.managed ? '公司托管' : '员工配置'}</small></div>
                <h3>{connector.name}</h3>
                <p>{connector.summary}</p>
                <div className="kit-capabilities">
                  <small>{connector.transport ?? connector.kind}</small><small>v{connector.version ?? '1'}</small><small>{connector.scope}</small><small>{connector.toolNames.length} 个工具</small>
                </div>
                {connector.toolNames.length > 0 && <div className="connector-tools">{connector.toolNames.join(' · ')}</div>}
                <button className="kit-install" disabled type="button">{connector.managed ? '由公司统一管理' : '配置连接器'}</button>
                <small className="connector-activation-note">连接器配置或启停后，对新会话生效</small>
              </article>)}</div>
            </>}
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
            />}
            {page === 'im' && bootstrap && user && <ImChannelsPage
              accessToken={accessToken}
              employeeId={user.userId}
              connectors={runtimeConnectors}
              litellmBaseUrl={bootstrap.endpoints.litellm}
              model={activeModel}
              modelApiKey={bootstrap.modelApiKey}
            />}
          </section>
        )}
      </main>
    </div>
  )
}

function connectorStatusLabel(status: ConnectorCatalogEntry['status']): string {
  return ({
    ready: '已就绪',
    'needs-configuration': '需要配置',
    unavailable: '暂不可用',
    disabled: '已停用',
  })[status]
}
