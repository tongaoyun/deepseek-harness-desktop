import { Bot, Clock3, MessageCircle, MoreHorizontal, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  allowLocalImPairing,
  bindLocalImTask,
  configureLocalDingTalk,
  loadLocalImStatus,
  removeLocalDingTalk,
  setLocalImEnabled,
  unbindLocalImTask,
  type LocalImHarnessContext,
  type LocalImStatus,
} from './localIm'
import { XiaoyinMascot } from './XiaoyinMascot'
import type { LocalTaskRun } from './types'
import { applyHarnessNotification, createTaskMonitor } from './harness'
import { InlineTaskActivity } from './InlineTaskActivity'
import { useDesktopDialog } from './DesktopDialog'

interface Props extends LocalImHarnessContext { localTasks: LocalTaskRun[] }

const STATUS_REFRESH_INTERVAL_MS = 10_000

const providers = [
  { id: 'DINGTALK', name: '钉钉', summary: '通过钉钉机器人接收并回复用户消息', tone: 'dingtalk' },
]

export function ImChannelsPage(harness: Props) {
  const { confirm, dialog } = useDesktopDialog()
  const [status, setStatus] = useState<LocalImStatus>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [configuring, setConfiguring] = useState(false)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [notifyTaskResults, setNotifyTaskResults] = useState(false)
  const [taskSelections, setTaskSelections] = useState<Record<string, string>>({})
  const [activeConversationKey, setActiveConversationKey] = useState('')
  const initialized = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const value = await loadLocalImStatus()
      setStatus(value)
      if (!initialized.current) {
        initialized.current = true
        setNotifyTaskResults(value.notifyTaskResults)
      }
      setClientId((current) => current || value.clientId)
      setError('')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const refreshWhenVisible = () => {
      if (!document.hidden) void refresh()
    }
    const timer = window.setInterval(refreshWhenVisible, STATUS_REFRESH_INTERVAL_MS)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [refresh])

  useEffect(() => {
    if (!configuring && !pairingOpen) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (pairingOpen) setPairingOpen(false)
      else setConfiguring(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [configuring, pairingOpen])

  const harnessContext = useMemo<LocalImHarnessContext>(() => ({
    employeeId: harness.employeeId,
    teamId: harness.teamId,
    litellmBaseUrl: harness.litellmBaseUrl,
    knowledgeEndpoint: harness.knowledgeEndpoint,
    scheduleEndpoint: harness.scheduleEndpoint,
    connectors: harness.connectors,
    allowedArtifacts: harness.allowedArtifacts,
    model: harness.model,
    modelApiKey: harness.modelApiKey,
    accessToken: harness.accessToken,
  }), [harness.accessToken, harness.allowedArtifacts, harness.connectors, harness.employeeId, harness.knowledgeEndpoint, harness.litellmBaseUrl, harness.model, harness.modelApiKey, harness.scheduleEndpoint, harness.teamId])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const value = await configureLocalDingTalk({
        clientId, clientSecret, enabled: true, accessPolicy: 'open', notifyTaskResults, harness: harnessContext,
      })
      setStatus(value)
      setClientSecret('')
      setConfiguring(false)
    } catch (reason) {
      setError(message(reason))
    } finally {
      setLoading(false)
    }
  }

  const toggle = async () => {
    if (!status?.configured || loading) return
    setLoading(true)
    try {
      setStatus(await setLocalImEnabled(!status.enabled, harnessContext))
      setError('')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setLoading(false)
    }
  }

  const remove = async () => {
    if (!await confirm({
      title: '移除钉钉频道配置？',
      message: '本机保存的 Client Secret 和配对记录将一并删除。',
      confirmLabel: '移除',
      danger: true,
    })) return
    setLoading(true)
    try {
      setStatus(await removeLocalDingTalk())
      setClientId('')
      setClientSecret('')
      setConfiguring(false)
      setError('')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setLoading(false)
    }
  }

  const allowPairing = async (conversationKey: string) => {
    setLoading(true)
    try {
      setStatus(await allowLocalImPairing(conversationKey))
      setError('')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setLoading(false)
    }
  }

  const bindTask = async (conversationKey: string) => {
    const task = harness.localTasks.find((item) => item.id === taskSelections[conversationKey])
    if (!task?.sessionId) return
    setLoading(true)
    try {
      setStatus(await bindLocalImTask(conversationKey, { id: task.id, name: task.name, sessionId: task.sessionId }))
      setError('')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setLoading(false)
    }
  }

  const unbindTask = async (conversationKey: string) => {
    setLoading(true)
    try {
      setStatus(await unbindLocalImTask(conversationKey))
      setError('')
    } catch (reason) {
      setError(message(reason))
    } finally {
      setLoading(false)
    }
  }

  const openConfiguration = () => {
    setNotifyTaskResults(status?.notifyTaskResults ?? false)
    setConfiguring(true)
  }

  return <div className="im-channel-page local-im-page">
    <header className="local-im-intro">
      <div className="im-hero-avatars"><span><XiaoyinMascot size={38} variant="avatar" /></span><i><MessageCircle size={18} /></i></div>
      <p>连接钉钉机器人，让员工直接在公司 IM 中使用小胤。</p>
      <small>频道凭据仅保存在本机系统凭据库，不上传到控制中心。</small>
    </header>

    <div className="local-im-list">{providers.map((provider) => {
      const dingTalk = provider.id === 'DINGTALK'
      const connected = dingTalk && status?.connected
      return <article key={provider.id}>
        <div className={`im-provider-icon ${provider.tone}`}><Bot size={20} /></div>
        <div className="im-provider-copy"><div><h3>{provider.name}</h3>{connected && <em>已连接</em>}</div><p>{provider.summary}</p>{dingTalk && status?.configured && <small>{status.lastHeartbeatAt ? `最近心跳 ${new Date(status.lastHeartbeatAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '正在等待连接心跳'}{status.pendingEventCount > 0 ? ` · ${status.pendingEventCount} 条消息待重试` : ''}</small>}</div>
        {dingTalk && status?.configured ? <div className="im-provider-actions">
          {status.accessPolicy === 'pairing' && <button onClick={() => setPairingOpen(true)} type="button">配对管理{status.pendingPairings.length > 0 ? ` (${status.pendingPairings.length})` : ''}</button>}
          <button aria-label="重新配置" onClick={openConfiguration} title="重新配置" type="button"><MoreHorizontal size={17} /></button>
          <button aria-label={status.enabled ? '关闭频道' : '开启频道'} className={`im-switch ${status.enabled ? 'on' : ''}`} disabled={loading} onClick={() => void toggle()} type="button"><i /></button>
        </div> : <button className="im-configure" disabled={!dingTalk} onClick={openConfiguration} type="button">{dingTalk ? '配置' : '即将支持'}</button>}
      </article>
    })}</div>

    {status?.lastError && <div className="kit-error">钉钉连接异常：{status.lastError}</div>}
    {error && <div className="kit-error">{error}</div>}

    {status?.configured && <section className="im-conversation-center"><header><div><h3>IM 会话</h3><p>可将钉钉会话接管到已有桌面任务，继续使用同一个 Harness 上下文。钉钉内也可发送 /bind、/bind 序号、/unbind。</p></div><span>{status.conversations.length} 个会话</span></header><div>{status.conversations.map((conversation) => <article key={conversation.conversationKey}><span className="conversation-avatar"><MessageCircle size={16} /></span><div><button className="im-conversation-open" onClick={() => setActiveConversationKey(conversation.conversationKey)} type="button"><strong>{conversation.conversationType === 'group' ? conversation.conversationTitle || '未命名群' : conversation.senderNick || '钉钉用户'}</strong></button><p>{conversation.lastMessage}</p><small><Clock3 size={11} />{new Date(conversation.updatedAt).toLocaleString()} · {conversation.messageCount} 条消息</small>{conversation.boundTaskId
      ? <div className="im-task-binding"><span>已接管：{conversation.boundTaskName}</span><button disabled={loading} onClick={() => void unbindTask(conversation.conversationKey)} type="button">解除</button></div>
      : <div className="im-task-binding"><select aria-label="选择接管任务" onChange={(event) => setTaskSelections((current) => ({ ...current, [conversation.conversationKey]: event.target.value }))} value={taskSelections[conversation.conversationKey] ?? ''}><option value="">选择桌面任务</option>{harness.localTasks.filter((task) => task.sessionId && !task.archivedAt).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select><button disabled={loading || !taskSelections[conversation.conversationKey]} onClick={() => void bindTask(conversation.conversationKey)} type="button">接管</button></div>}</div><em className={conversation.status.toLowerCase()}>{conversation.status === 'RUNNING' ? '处理中' : conversation.status === 'FAILED' ? '失败' : '已回复'}</em></article>)}{status.conversations.length === 0 && <div className="kit-empty"><MessageCircle size={17} />暂无 IM 会话，员工发送消息后会显示在这里</div>}</div></section>}

    {configuring && <div className="im-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfiguring(false) }}><form aria-labelledby="im-config-title" aria-modal="true" className="im-config-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void save(event)} role="dialog">
      <button aria-label="关闭" className="im-modal-close" onClick={() => setConfiguring(false)} type="button"><X size={18} /></button>
      <div className="im-modal-logo dingtalk"><Bot size={24} /></div>
      <h2 id="im-config-title">{status?.configured ? '重新配置钉钉' : '配置钉钉'}</h2>
      <p>在钉钉开放平台创建企业内部应用并启用机器人与 Stream 模式，然后填写应用凭据。</p>
      <label>Client ID（AppKey）<input autoComplete="off" onChange={(event) => setClientId(event.target.value)} required value={clientId} /></label>
      <label>Client Secret（AppSecret）<input autoComplete="new-password" onChange={(event) => setClientSecret(event.target.value)} placeholder={status?.secretConfigured ? '重新配置时必须重新填写' : ''} required type="password" value={clientSecret} /></label>
      {status?.accessPolicy === 'pairing' && <div className="im-security-note">重新保存后将切换为公司内开放使用，不再需要逐个配对。</div>}
      <label className="im-notification-toggle"><input checked={notifyTaskResults} onChange={(event) => setNotifyTaskResults(event.target.checked)} type="checkbox" /><span><strong>推送云端任务结果</strong><small>仅投递到创建定时任务时明确选择的钉钉会话；未选择则不推送</small></span></label>
      <div className="im-security-note"><ShieldCheck size={15} />Client Secret 只写入 Windows Credential Manager 或 macOS Keychain。</div>
      <div className="im-modal-actions">{status?.configured && <button className="danger" onClick={() => void remove()} type="button">移除配置</button>}<button disabled={loading} type="submit">{loading ? '正在连接…' : '保存并连接'}</button></div>
    </form></div>}

    {pairingOpen && <div className="im-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPairingOpen(false) }}><section aria-labelledby="im-pairing-title" aria-modal="true" className="im-config-modal pairing-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <button aria-label="关闭" className="im-modal-close" onClick={() => setPairingOpen(false)} type="button"><X size={18} /></button>
      <h2 id="im-pairing-title">钉钉配对管理</h2><p>员工私聊机器人或在群中 @机器人后，会在这里产生配对请求。</p>
      <div className="pairing-list">{status?.pendingPairings.map((request) => <article key={request.conversationKey}>
        <span><strong>{request.conversationType === 'group' ? request.conversationTitle || '未命名群' : request.senderNick || '钉钉用户'}</strong><small>{request.conversationType === 'group' ? '群聊' : '私聊'} · {new Date(request.requestedAt).toLocaleString()}</small></span>
        <button disabled={loading} onClick={() => void allowPairing(request.conversationKey)} type="button">允许</button>
      </article>)}{status?.pendingPairings.length === 0 && <div className="kit-empty"><RefreshCw size={16} />暂无待处理的配对请求</div>}</div>
    </section></div>}

    {activeConversationKey && status && (() => {
      const conversation = status.conversations.find((item) => item.conversationKey === activeConversationKey)
      if (!conversation) return null
      const boundTask = harness.localTasks.find((task) => task.id === conversation.boundTaskId)
      const monitor = boundTask?.monitor ?? (conversation.taskEvents ?? []).reduce(
        (current, item) => applyHarnessNotification(current, { requestId: 0, event: { event: item.event } }),
        createTaskMonitor(conversation.updatedAt),
      )
      return <div className="im-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveConversationKey('') }}><section aria-modal="true" className="im-config-modal im-conversation-modal" role="dialog">
        <button aria-label="关闭" className="im-modal-close" onClick={() => setActiveConversationKey('')} type="button"><X size={18} /></button>
        <h2>{conversation.conversationType === 'group' ? conversation.conversationTitle || '未命名群' : conversation.senderNick || '钉钉用户'}</h2>
        <p>{conversation.boundTaskName ? `已接管桌面任务：${conversation.boundTaskName}` : '独立钉钉任务'}</p>
        <div className="im-message-history">{(conversation.messages ?? []).map((item) => <article className={item.role} key={item.id}><small>{item.role === 'user' ? conversation.senderNick || '员工' : '小胤'} · {new Date(item.createdAt).toLocaleString()}</small><p>{item.text}</p></article>)}
          {(conversation.messages ?? []).length === 0 && <div className="kit-empty">暂无可显示的历史消息</div>}
        </div>
        <InlineTaskActivity finalResponse={conversation.lastMessage} monitor={monitor} />
      </section></div>
    })()}
    {dialog}
  </div>
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
