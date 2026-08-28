import { Bot, Check, MessageCircle, MoreHorizontal, RefreshCw, ShieldCheck, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  allowLocalImPairing,
  configureLocalDingTalk,
  loadLocalImStatus,
  removeLocalDingTalk,
  setLocalImEnabled,
  type ImAccessPolicy,
  type LocalImHarnessContext,
  type LocalImStatus,
} from './localIm'

interface Props extends LocalImHarnessContext {}

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
  const initialized = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const value = await loadLocalImStatus()
      setStatus(value)
      if (!initialized.current) {
        initialized.current = true
        setAccessPolicy(value.accessPolicy)
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

  const harnessContext = useMemo<LocalImHarnessContext>(() => ({
    litellmBaseUrl: harness.litellmBaseUrl,
    erpMcpUrl: harness.erpMcpUrl,
    model: harness.model,
    accessToken: harness.accessToken,
  }), [harness.accessToken, harness.erpMcpUrl, harness.litellmBaseUrl, harness.model])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const value = await configureLocalDingTalk({
        clientId, clientSecret, enabled: true, accessPolicy, harness: harnessContext,
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

  const openConfiguration = () => {
    setAccessPolicy(status?.accessPolicy ?? 'pairing')
    setConfiguring(true)
  }

  return <div className="im-channel-page local-im-page">
    <header className="local-im-intro">
      <div className="im-hero-avatars"><span>AI</span><i><MessageCircle size={18} /></i></div>
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

    {configuring && <div className="im-modal-backdrop"><form className="im-config-modal" onSubmit={(event) => void save(event)}>
      <button aria-label="关闭" className="im-modal-close" onClick={() => setConfiguring(false)} type="button"><X size={18} /></button>
      <div className="im-modal-logo dingtalk"><Bot size={24} /></div>
      <h2>{status?.configured ? '重新配置钉钉' : '配置钉钉'}</h2>
      <p>在钉钉开放平台创建企业内部应用并启用机器人与 Stream 模式，然后填写应用凭据。</p>
      <label>Client ID（AppKey）<input autoComplete="off" onChange={(event) => setClientId(event.target.value)} required value={clientId} /></label>
      <label>Client Secret（AppSecret）<input autoComplete="new-password" onChange={(event) => setClientSecret(event.target.value)} placeholder={status?.secretConfigured ? '重新配置时必须重新填写' : ''} required type="password" value={clientSecret} /></label>
      <fieldset><legend>准入策略</legend>
        <button className={accessPolicy === 'pairing' ? 'active' : ''} onClick={() => setAccessPolicy('pairing')} type="button"><span><strong>配对模式</strong><small>需经您允许后，对应会话才能使用</small></span>{accessPolicy === 'pairing' && <Check size={16} />}</button>
        <button className={accessPolicy === 'open' ? 'active' : ''} onClick={() => setAccessPolicy('open')} type="button"><span><strong>开放模式</strong><small>所有人和群可直接对话</small></span>{accessPolicy === 'open' && <Check size={16} />}</button>
      </fieldset>
      <div className="im-security-note"><ShieldCheck size={15} />Client Secret 只写入 Windows Credential Manager 或 macOS Keychain。</div>
      <div className="im-modal-actions">{status?.configured && <button className="danger" onClick={() => void remove()} type="button">移除配置</button>}<button disabled={loading} type="submit">{loading ? '正在连接…' : '保存并连接'}</button></div>
    </form></div>}

    {pairingOpen && <div className="im-modal-backdrop"><section className="im-config-modal pairing-modal">
      <button aria-label="关闭" className="im-modal-close" onClick={() => setPairingOpen(false)} type="button"><X size={18} /></button>
      <h2>钉钉配对管理</h2><p>员工私聊机器人或在群中 @机器人后，会在这里产生配对请求。</p>
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
