import { Bot, Check, Clock3, ExternalLink, Inbox, Info, MessageCircle, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  allowLocalImPairing,
  bindLocalImTask,
  configureLocalDingTalk,
  loadLocalImStatus,
  removeLocalDingTalk,
  revokeLocalImPairing,
  setLocalImEnabled,
  unbindLocalImTask,
  retryLocalImDelivery,
  type LocalImHarnessContext,
  type LocalImStatus,
} from './localIm'
import { XiaoyinMascot } from './XiaoyinMascot'
import type { LocalTaskRun } from './types'
import { OfficialConversationPanel } from './conversation/OfficialConversationPanel'
import { useDesktopDialog } from './DesktopDialog'
import { useDialogFocus } from './useDialogFocus'
import { DingTalkRegistration } from './DingTalkRegistration'
import { DingTalkIcon } from './DingTalkIcon'

interface Props extends LocalImHarnessContext { localTasks: LocalTaskRun[]; selectedConversationKey?: string; onSelectConversation?: (key: string) => void }

const STATUS_REFRESH_INTERVAL_MS = 10_000

const providers = [
  { id: 'DINGTALK', name: '钉钉', summary: '通过钉钉机器人接收并回复用户消息', tone: 'dingtalk' },
]

export function ImChannelsPage(harness: Props) {
  const { confirm, dialog } = useDesktopDialog()
  const [status, setStatus] = useState<LocalImStatus>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [configuring, setConfiguring] = useState(false)
  const [pairingOpen, setPairingOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [notifyTaskResults, setNotifyTaskResults] = useState(false)
  const [taskSelections, setTaskSelections] = useState<Record<string, string>>({})
  const [localConversationKey, setLocalConversationKey] = useState('')
  const activeConversationKey = harness.selectedConversationKey ?? localConversationKey
  const setActiveConversationKey = harness.onSelectConversation ?? setLocalConversationKey
  const [accessPolicy, setAccessPolicy] = useState<'open' | 'pairing'>('pairing')
  const [menuOpen, setMenuOpen] = useState(false)
  const [setupMode, setSetupMode] = useState<'scan' | 'manual'>('scan')
  const [qrRevision, setQrRevision] = useState(0)
  const [scanReady, setScanReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(false)
  const revision = useRef(0)
  const refreshing = useRef(false)
  const configRef = useRef<HTMLFormElement>(null)
  const pairingRef = useRef<HTMLElement>(null)
  const conversationRef = useRef<HTMLElement>(null)
  useDialogFocus(configRef, configuring ? 'config' : '', () => { if (!busyRef.current) setConfiguring(false) })
  useDialogFocus(pairingRef, pairingOpen ? 'pairing' : '', () => { if (!busyRef.current) setPairingOpen(false) })
  useDialogFocus(conversationRef, activeConversationKey, () => setActiveConversationKey(''))
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const refresh = useCallback(async () => {
    if (busyRef.current || refreshing.current) return
    refreshing.current = true
    const current = ++revision.current
    try {
      const value = await loadLocalImStatus()
      if (!mounted.current || current !== revision.current) return
      setStatus(value)
      setRefreshError('')
    } catch (reason) {
      if (mounted.current && current === revision.current) setRefreshError(message(reason))
    } finally {
      refreshing.current = false
      if (mounted.current) setLoading(false)
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
    if (!menuOpen) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
    }
    const outside = (event: PointerEvent) => { if (!(event.target as Element)?.closest('.im-provider-menu')) setMenuOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside) }
  }, [menuOpen])

  const run = async (action: () => Promise<LocalImStatus>): Promise<boolean> => {
    if (busyRef.current) return false
    busyRef.current = true
    ++revision.current
    setBusy(true); setError('')
    try {
      const value = await action()
      if (!mounted.current) return false
      setStatus(value)
      return true
    } catch (reason) { if (mounted.current) setError(message(reason)); return false }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  const harnessContext = useMemo<LocalImHarnessContext>(() => ({
    employeeId: harness.employeeId,
    teamId: harness.teamId,
    litellmBaseUrl: harness.litellmBaseUrl,
    knowledgeEndpoint: harness.knowledgeEndpoint,
    scheduleEndpoint: harness.scheduleEndpoint,
    capabilitySnapshot: harness.capabilitySnapshot,
    model: harness.model,
    modelApiKey: harness.modelApiKey,
    accessToken: harness.accessToken,
    allowShell: harness.allowShell,
    allowLsp: harness.allowLsp,
    allowExternalAgents: harness.allowExternalAgents,
    allowHooks: harness.allowHooks,
  }), [harness.accessToken, harness.allowExternalAgents, harness.allowHooks, harness.allowLsp, harness.allowShell, harness.capabilitySnapshot, harness.employeeId, harness.knowledgeEndpoint, harness.litellmBaseUrl, harness.model, harness.modelApiKey, harness.scheduleEndpoint, harness.teamId])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (await run(() => configureLocalDingTalk({
        clientId, clientSecret, enabled: status?.configured ? status.enabled : true, accessPolicy, notifyTaskResults, harness: harnessContext,
      }))) {
      setClientSecret('')
      setConfiguring(false)
    }
  }

  const toggle = async () => {
    if (!status?.configured || loading) return
    await run(() => setLocalImEnabled(!status.enabled, harnessContext))
  }

  const remove = async () => {
    setMenuOpen(false)
    if (!await confirm({
      title: '移除钉钉频道配置？',
      message: '本机保存的 Client Secret 和配对记录将一并删除。',
      confirmLabel: '移除',
      danger: true,
    })) return
    if (await run(removeLocalDingTalk)) {
      setClientId('')
      setClientSecret('')
      setConfiguring(false)
      setError('')
    }
  }

  const allowPairing = async (conversationKey: string) => {
    await run(() => allowLocalImPairing(conversationKey))
  }

  const revokePairing = async (key: string) => {
    if (await confirm({ title: '解除此会话配对？', message: '配对模式下，该会话后续消息需重新允许；已开始的任务不受影响。开放模式下仍可对话。', confirmLabel: '解除配对' })) {
      await run(() => revokeLocalImPairing(key))
    }
  }

  const bindTask = async (conversationKey: string) => {
    const task = harness.localTasks.find((item) => item.id === taskSelections[conversationKey])
    if (!task?.sessionId) return
    await run(() => bindLocalImTask(conversationKey, { id: task.id, name: task.name, sessionId: task.sessionId! }))
  }

  const unbindTask = async (conversationKey: string) => {
    await run(() => unbindLocalImTask(conversationKey))
  }

  const openConfiguration = () => {
    setSetupMode('scan'); setScanReady(false)
    setClientId(status?.clientId ?? '')
    setClientSecret('')
    setAccessPolicy(status?.accessPolicy ?? 'pairing')
    setError(''); setMenuOpen(false)
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
        <div className={`im-provider-icon ${provider.tone}`}><DingTalkIcon size={32} /></div>
        <div className="im-provider-copy"><div><h3>{provider.name}</h3>{status?.configured && <em className={status.state === 'DEGRADED' ? 'degraded' : !status.enabled ? 'disabled' : ''}>{!status.enabled ? '已关闭' : status.state === 'DEGRADED' ? '需要处理' : connected ? '已连接' : '连接中'}</em>}</div><p>{provider.summary}</p></div>
        {dingTalk && status?.configured ? <div className="im-provider-actions">
          <button disabled={busy} onClick={() => setPairingOpen(true)} type="button">配对管理{status.pendingPairings.length > 0 ? ` (${status.pendingPairings.length})` : ''}</button>
          <div className="im-provider-menu"><button aria-label="频道操作" aria-expanded={menuOpen} aria-haspopup="menu" disabled={busy} onClick={() => setMenuOpen(!menuOpen)} type="button"><MoreHorizontal size={20} /></button>{menuOpen && <div role="menu"><button onClick={openConfiguration} role="menuitem" type="button"><Pencil size={16} />编辑配置</button><button className="danger" onClick={() => void remove()} role="menuitem" type="button"><Trash2 size={16} />移除配置</button></div>}</div>
          <button aria-label={status.enabled ? '关闭频道' : '开启频道'} aria-checked={status.enabled} role="switch" className={`im-switch ${status.enabled ? 'on' : ''}`} disabled={loading || busy} onClick={() => void toggle()} type="button"><i /></button>
        </div> : <button className="im-configure" disabled={loading || busy || !dingTalk || (!status && Boolean(refreshError))} onClick={openConfiguration} type="button">{loading ? '读取中…' : '配置'}</button>}
      </article>
    })}</div>

    {status?.lastError && <div className="kit-error">钉钉频道需要处理：{status.lastError}</div>}
    {refreshError && <div className="kit-error im-refresh-error" role="alert"><span>频道状态读取失败：{refreshError}</span><button disabled={loading} onClick={() => { setLoading(true); void refresh() }} type="button">重新读取频道</button></div>}
    {error && !configuring && !pairingOpen && <div className="kit-error" role="alert">{error}</div>}

    {status?.configured && <section className="im-conversation-center"><header><div><h3>IM 会话</h3><p>可将钉钉会话接管到已有桌面任务，继续使用已有任务的文件和对话。钉钉内也可发送 /bind、/bind 序号、/unbind。</p></div><span>{status.conversations.length} 个会话</span></header><div>{status.conversations.map((conversation) => <article key={conversation.conversationKey}><span className="conversation-avatar"><MessageCircle size={16} /></span><div><button className="im-conversation-open" onClick={() => setActiveConversationKey(conversation.conversationKey)} type="button"><strong>{conversation.conversationType === 'group' ? conversation.conversationTitle || '未命名群' : conversation.senderNick || '钉钉用户'}</strong></button><p>{conversation.lastMessage}</p><small><Clock3 size={11} />{new Date(conversation.updatedAt).toLocaleString()} · {conversation.messageCount} 条消息</small>{conversation.boundTaskId
      ? <div className="im-task-binding"><span>已接管：{conversation.boundTaskName}</span><button disabled={loading || busy} onClick={() => void unbindTask(conversation.conversationKey)} type="button">解除</button></div>
      : <div className="im-task-binding"><select aria-label="选择接管任务" onChange={(event) => setTaskSelections((current) => ({ ...current, [conversation.conversationKey]: event.target.value }))} value={taskSelections[conversation.conversationKey] ?? ''}><option value="">选择桌面任务</option>{harness.localTasks.filter((task) => task.sessionId && !task.archivedAt).map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select><button disabled={loading || busy || !taskSelections[conversation.conversationKey]} onClick={() => void bindTask(conversation.conversationKey)} type="button">接管</button></div>}</div><div className="im-delivery-state"><em className={conversation.status.toLowerCase()}>{conversation.status === 'RUNNING' ? '执行中' : conversation.status === 'FAILED' ? '执行失败' : conversation.deliveryStatus ? '执行完成' : '已回复'}</em>{conversation.deliveryStatus && <small>{conversation.deliveryStatus === 'FAILED' ? `发送待处理 · ${conversation.pendingDeliveryCount ?? 1} 项` : '正在发送结果'}</small>}{conversation.deliveryStatus === 'FAILED' && <button type="button" disabled={busy || !status.connected} onClick={() => void run(() => retryLocalImDelivery(conversation.conversationKey))}>仅重试发送</button>}</div></article>)}{status.conversations.length === 0 && <div className="kit-empty"><MessageCircle size={17} />暂无 IM 会话，员工发送消息后会显示在这里</div>}</div></section>}

    {configuring && <div className="im-modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) setConfiguring(false) }}><form aria-labelledby="im-config-title" aria-modal="true" className="im-config-modal im-setup-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void save(event)} ref={configRef} role="dialog">
      <button aria-label="关闭" className="im-modal-close" disabled={busy} onClick={() => setConfiguring(false)} type="button"><X size={20} /></button>
      <div className="im-modal-logo dingtalk"><DingTalkIcon size={38} /></div>
      <div className="im-setup-body">
      <h2 id="im-config-title">{status?.configured ? '重新配置钉钉' : '配置钉钉'}</h2>
      <p className="im-setup-subtitle">{setupMode === 'scan' ? '在钉钉中扫码完成应用注册' : '手动填写已有钉钉应用的 Client ID 和 Client Secret'}</p>
      <button className="im-mode-link" disabled={busy} onClick={() => setSetupMode(setupMode === 'scan' ? 'manual' : 'scan')} type="button">{setupMode === 'scan' ? '手动配置' : '返回扫码'}</button>
      {setupMode === 'scan' && <DingTalkRegistration revision={qrRevision} onAuthorized={(id, secret) => { setClientId(id); setClientSecret(secret); setScanReady(true) }} />}
      {scanReady && <div className="im-bound-app"><strong><Check size={17} />待保存应用</strong><p>Client ID：{clientId}</p><p>Client Secret：••••••••••••••••</p></div>}
      {status?.configured && <div className="im-bound-app"><strong><Bot size={17} />当前绑定应用</strong><p>Client ID：{status.clientId}</p><p>Client Secret：{status.secretConfigured ? '••••••••••••••••' : '未保存'}</p></div>}
      {setupMode === 'manual' && <div className="im-manual-fields">
        <div className="im-field-heading"><label htmlFor="im-client-id">Client ID（原 AppKey）</label><a href="https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/go/create-bot/" rel="noreferrer" target="_blank">配置文档<ExternalLink size={14} /></a></div>
        <input id="im-client-id" autoComplete="off" disabled={busy} onChange={(event) => setClientId(event.target.value)} placeholder="请输入 Client ID" required value={clientId} />
        <label htmlFor="im-client-secret">Client Secret（原 AppSecret）</label>
        <input id="im-client-secret" autoComplete="new-password" disabled={busy} onChange={(event) => setClientSecret(event.target.value)} placeholder={status?.secretConfigured && clientId.trim() === status.clientId ? '留空保留当前密钥' : '请输入 Client Secret'} required={!status?.secretConfigured || clientId.trim() !== status.clientId} type="password" value={clientSecret} />
      </div>}
      <fieldset disabled={busy}><legend>准入策略</legend><div className="im-policy-options" role="radiogroup" aria-label="准入策略">
        <button aria-checked={accessPolicy === 'pairing'} className={accessPolicy === 'pairing' ? 'active' : ''} onClick={() => setAccessPolicy('pairing')} role="radio" type="button"><span><strong>配对模式</strong><small>需经你允许后，对应会话才能使用</small></span>{accessPolicy === 'pairing' && <Check size={20} />}</button>
        {accessPolicy === 'pairing' && <div className="im-policy-help"><Info size={18} /><span>保存后，用户私聊机器人或在群中 @机器人时会自动触发配对请求。你可以在频道卡片的“配对管理”中点击“允许”。配对以会话为单位：私聊允许后该用户可对话，群聊允许后群内所有成员均可对话。</span></div>}
        <button aria-checked={accessPolicy === 'open'} className={accessPolicy === 'open' ? 'active' : ''} onClick={() => setAccessPolicy('open')} role="radio" type="button"><span><strong>开放模式</strong><small>所有人／群可直接对话</small></span>{accessPolicy === 'open' && <Check size={20} />}</button>
      </div></fieldset>
      <details className="im-more-settings"><summary>更多设置{notifyTaskResults ? ' · 已开启结果推送' : ''}</summary><label className="im-notification-toggle"><input disabled={busy} checked={notifyTaskResults} onChange={(event) => setNotifyTaskResults(event.target.checked)} type="checkbox" /><span><strong>推送云端任务结果</strong><small>仅投递到创建定时任务时明确选择的钉钉会话；未选择则不推送</small></span></label></details>
      {error && <div className="kit-error" role="alert">{error}</div>}
      </div>
      <div className="im-modal-actions">{setupMode === 'scan' ? <button className="secondary" disabled={busy} onClick={() => { setScanReady(false); setClientId(status?.clientId ?? ''); setClientSecret(''); setQrRevision((value) => value + 1) }} type="button">刷新二维码</button> : <button className="secondary" disabled={busy} onClick={() => setConfiguring(false)} type="button">取消</button>}<button disabled={busy || !clientId.trim() || (setupMode === 'scan' && !scanReady && !status?.configured)} type="submit">{busy ? '正在保存…' : '保存'}</button></div>
    </form></div>}

    {pairingOpen && <div className="im-modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) setPairingOpen(false) }}><section aria-labelledby="im-pairing-title" aria-modal="true" className="im-config-modal pairing-modal" onMouseDown={(event) => event.stopPropagation()} ref={pairingRef} role="dialog">
      <button aria-label="关闭" className="im-modal-close" disabled={busy} onClick={() => setPairingOpen(false)} type="button"><X size={18} /></button>
      <h2 id="im-pairing-title">配对管理</h2>
      {status?.accessPolicy === 'open' && <p>当前为开放模式，配对记录会保留，切换到配对模式后生效。</p>}
      {error && <div className="kit-error" role="alert">{error}</div>}
      <div className="pairing-list">{status?.pendingPairings.map((request) => <article key={request.conversationKey}>
        <span><strong>{request.conversationType === 'group' ? request.conversationTitle || '未命名群' : request.senderNick || '钉钉用户'}</strong><small>{request.conversationType === 'group' ? '群聊' : '私聊'} · {new Date(request.requestedAt).toLocaleString()}</small></span>
        <button disabled={busy} onClick={() => void allowPairing(request.conversationKey)} type="button">允许</button>
      </article>)}{(status?.pairedConversations ?? []).map((key) => {
        const conversation = status?.conversations.find((item) => item.conversationKey === key)
        return <article key={key}><span><strong>{conversation ? conversation.conversationTitle || conversation.senderNick || '钉钉会话' : key.includes(':group:') ? '已配对群聊' : '已配对私聊'}</strong><small>已配对 · {key}</small></span><button disabled={busy} onClick={() => void revokePairing(key)} type="button">解除配对</button></article>
      })}{!status?.pendingPairings.length && !status?.pairedConversations?.length && <div className="im-pairing-empty"><Inbox size={42} strokeWidth={1.7} /><p>暂无待配对请求或已配对会话</p></div>}</div>
    </section></div>}

    {activeConversationKey && status && (() => {
      const conversation = status.conversations.find((item) => item.conversationKey === activeConversationKey)
      if (!conversation) return null
      const boundTask = harness.localTasks.find((task) => task.id === conversation.boundTaskId)
      return <div className="im-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveConversationKey('') }}><section aria-label="频道会话" aria-modal="true" className="im-config-modal im-conversation-modal" ref={conversationRef} role="dialog">
        <button aria-label="关闭" className="im-modal-close" onClick={() => setActiveConversationKey('')} type="button"><X size={18} /></button>
        <h2>{conversation.conversationType === 'group' ? conversation.conversationTitle || '未命名群' : conversation.senderNick || '钉钉用户'}</h2>
        <p>{conversation.boundTaskName ? `已接管桌面任务：${conversation.boundTaskName}` : '独立钉钉任务'}</p>
        <OfficialConversationPanel employeeId={harness.employeeId} sessionId={conversation.sessionId ?? boundTask?.sessionId} />
      </section></div>
    })()}
    {dialog}
  </div>
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
