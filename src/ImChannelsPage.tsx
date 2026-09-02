import { Bot, Check, Clock3, MessageCircle, MoreHorizontal, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  allowLocalImPairing,
  bindLocalImTask,
  configureLocalDingTalk,
  loadLocalImStatus,
  removeLocalDingTalk,
  setLocalImEnabled,
  unbindLocalImTask,
  type ImAccessPolicy,
  type LocalImHarnessContext,
  type LocalImStatus,
} from './localIm'
import { XiaoyinMascot } from './XiaoyinMascot'
import type { LocalTaskRun } from './types'

interface Props extends LocalImHarnessContext { localTasks: LocalTaskRun[] }

const providers = [
  { id: 'DINGTALK', name: '钉钉', summary: '通过钉钉机器人接收并回复用户消息', tone: 'dingtalk' },
  { id: 'FEISHU', name: '飞书', summary: '通过飞书机器人接收并回复用户消息', tone: 'feishu' },
  { id: 'LARK', name: 'Lark', summary: '通过 Lark 机器人接收并回复用户消息', tone: 'feishu' },
  { id: 'WECHAT', name: '微信', summary: '通过微信机器人接收并回复用户消息', tone: 'wechat' },
  { id: 'WECOM', name: '企业微信', summary: '通过企业微信机器人接收并回复用户消息', tone: 'wecom' },
]

export function ImChannelsPage(harness: Props) {
  const [status, setStatus] = useState<LocalImStatus>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [configuring, setConfiguring] = useState(false)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [accessPolicy, setAccessPolicy] = useState<ImAccessPolicy>('pairing')
  const [notifyTaskResults, setNotifyTaskResults] = useState(false)
  const [taskSelections, setTaskSelections] = useState<Record<string, string>>({})
  const initialized = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const value = await loadLocalImStatus()
      setStatus(value)
      if (!initialized.current) {
        initialized.current = true
        setAccessPolicy(value.accessPolicy)
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
    const timer = window.setInterval(() => void refresh(), 3_000)
    return () => window.clearInterval(timer)
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
    connectors: harness.connectors,
    allowedArtifacts: harness.allowedArtifacts,
    model: harness.model,
    modelApiKey: harness.modelApiKey,
    accessToken: harness.accessToken,
  }), [harness.accessToken, harness.allowedArtifacts, harness.connectors, harness.employeeId, harness.knowledgeEndpoint, harness.litellmBaseUrl, harness.model, harness.modelApiKey, harness.teamId])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const value = await configureLocalDingTalk({
        clientId, clientSecret, enabled: true, accessPolicy, notifyTaskResults, harness: harnessContext,
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
    if (!window.confirm('移除钉钉频道配置？本机保存的 Client Secret 和配对记录将一并删除。')) return
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
    setAccessPolicy(status?.accessPolicy ?? 'pairing')
    setNotifyTaskResults(status?.notifyTaskResults ?? false)
    setConfiguring(true)
  }

  return <div className="im-channel-page local-im-page">
    <header className="local-im-intro">
      <div className="im-hero-avatars"><span><XiaoyinMascot size={38} variant="avatar" /></span><i><MessageCircle size={18} /></i></div>
      <h2>IM 频道</h2>
      <p>配置 IM 频道，让小胤接收来自钉钉、飞书等平台的消息。</p>
      <small>频道凭据仅保存在本机系统凭据库，不上传到控制中心。</small>
    </header>

    <div className="local-im-list">{providers.map((provider) => {
      const dingTalk = provider.id === 'DINGTALK'
      const connected = dingTalk && status?.connected
      return <article key={provider.id}>
        <div className={`im-provider-icon ${provider.tone}`}><Bot size={20} /></div>
        <div className="im-provider-copy"><div><h3>{provider.name}</h3>{connected && <em>已连接</em>}</div><p>{provider.summary}</p></div>
        {dingTalk && status?.configured ? <div className="im-provider-actions">
          {status.accessPolicy === 'pairing' && <button onClick={() => setPairingOpen(true)} type="button">配对管理{status.pendingPairings.length > 0 ? ` (${status.pendingPairings.length})` : ''}</button>}
          <button aria-label="重新配置" onClick={openConfiguration} title="重新配置" type="button"><MoreHorizontal size={17} /></button>
          <button aria-label={status.enabled ? '关闭频道' : '开启频道'} className={`im-switch ${status.enabled ? 'on' : ''}`} disabled={loading} onClick={() => void toggle()} type="button"><i /></button>
        </div> : <button className="im-configure" disabled={!dingTalk} onClick={openConfiguration} type="button">{dingTalk ? '配置' : '即将支持'}</button>}
      </article>
    })}</div>

    {status?.lastError && <div className="kit-error">钉钉连接异常：{status.lastError}</div>}
    {error && <div className="kit-error">{error}</div>}

    {status?.configured && <section className="im-conversation-center"><header><div><h3>IM 会话</h3><p>可将钉钉会话接管到已有桌面任务，继续使用同一个 Harness 上下文。</p></div><span>{status.conversations.length} 个会话</span></header><div>{status.conversations.map((conversation) => <article key={conversation.conversationKey}><span className="conversation-avatar"><MessageCircle size={16} /></span><div><strong>{conversation.conversationType === 'group' ? conversation.conversationTitle || '未命名群' : conversation.senderNick || '钉钉用户'}</strong><p>{conversation.lastMessage}</p><small><Clock3 size={11} />{new Date(conversation.updatedAt).toLocaleString()} · {conversation.messageCount} 条消息</small>{conversation.boundTaskId
      ? <div className="im-task-binding"><span>已接管：{conversation.boundTaskName}</span><button disabled={loading} onClick={() => void unbindTask(conversation.conversationKey)} type="button">解除</button></div>
      : <div className="im-task-binding"><select aria-label="选择接管任务" onChange={(event) => setTaskSelections((current) => ({ ...current, [conversation.conversationKey]: event.target.value }))} value={taskSelections[conversation.conversationKey] ?? ''}><option value="">选择桌面任务</option>{harness.localTasks.filter((task) => task.sessionId && !task.archivedAt).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select><button disabled={loading || !taskSelections[conversation.conversationKey]} onClick={() => void bindTask(conversation.conversationKey)} type="button">接管</button></div>}</div><em className={conversation.status.toLowerCase()}>{conversation.status === 'RUNNING' ? '处理中' : conversation.status === 'FAILED' ? '失败' : '已回复'}</em></article>)}{status.conversations.length === 0 && <div className="kit-empty"><MessageCircle size={17} />暂无 IM 会话，员工发送消息后会显示在这里</div>}</div></section>}

    {configuring && <div className="im-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfiguring(false) }}><form aria-labelledby="im-config-title" aria-modal="true" className="im-config-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void save(event)} role="dialog">
      <button aria-label="关闭" className="im-modal-close" onClick={() => setConfiguring(false)} type="button"><X size={18} /></button>
      <div className="im-modal-logo dingtalk"><Bot size={24} /></div>
      <h2 id="im-config-title">{status?.configured ? '重新配置钉钉' : '配置钉钉'}</h2>
      <p>在钉钉开放平台创建企业内部应用并启用机器人与 Stream 模式，然后填写应用凭据。</p>
      <label>Client ID（AppKey）<input autoComplete="off" onChange={(event) => setClientId(event.target.value)} required value={clientId} /></label>
      <label>Client Secret（AppSecret）<input autoComplete="new-password" onChange={(event) => setClientSecret(event.target.value)} placeholder={status?.secretConfigured ? '重新配置时必须重新填写' : ''} required type="password" value={clientSecret} /></label>
      <fieldset><legend>准入策略</legend>
        <button className={accessPolicy === 'pairing' ? 'active' : ''} onClick={() => setAccessPolicy('pairing')} type="button"><span><strong>配对模式</strong><small>需经您允许后，对应会话才能使用</small></span>{accessPolicy === 'pairing' && <Check size={16} />}</button>
        <button className={accessPolicy === 'open' ? 'active' : ''} onClick={() => setAccessPolicy('open')} type="button"><span><strong>开放模式</strong><small>所有人和群可直接对话</small></span>{accessPolicy === 'open' && <Check size={16} />}</button>
      </fieldset>
      <label className="im-notification-toggle"><input checked={notifyTaskResults} onChange={(event) => setNotifyTaskResults(event.target.checked)} type="checkbox" /><span><strong>推送云端任务结果</strong><small>仅向已建立且符合准入策略的会话推送新任务完成或失败通知</small></span></label>
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
  </div>
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
