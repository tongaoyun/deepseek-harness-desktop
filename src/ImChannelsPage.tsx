import { Bot, MessageCircle, RefreshCw, Server } from 'lucide-react'
import { useEffect, useState } from 'react'
import { loadImChannels } from './api'
import type { ImChannel } from './types'

interface Props {
  endpoint: string
  employeeId: string
  accessToken: string
}

export function ImChannelsPage({ endpoint, employeeId, accessToken }: Props) {
  const [channels, setChannels] = useState<ImChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshToken, setRefreshToken] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    loadImChannels(endpoint, employeeId, accessToken, controller.signal)
      .then(setChannels)
      .catch((reason) => { if (!controller.signal.aborted) setError(message(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [accessToken, employeeId, endpoint, refreshToken])

  return <div className="im-channel-page">
    <div className="im-channel-summary">
      <div><MessageCircle size={17} /><span><strong>公司消息入口</strong><small>机器人配置和凭据由服务端统一管理，员工电脑无需保存。</small></span></div>
      <button disabled={loading} onClick={() => setRefreshToken((value) => value + 1)} type="button"><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新状态</button>
    </div>
    {loading && channels.length === 0 && <div className="kit-empty">正在读取 IM 频道…</div>}
    {!loading && !error && channels.length === 0 && <div className="kit-empty">控制中心尚未配置 IM 频道</div>}
    <div className="im-channel-grid">{channels.map((channel) => <article key={channel.id}>
      <div className="im-channel-head"><span><Bot size={17} /></span><i className={`im-channel-status ${channel.status.toLowerCase()}`}>{statusLabel(channel.status)}</i></div>
      <h3>{channel.name}</h3>
      <p>{channel.provider === 'DINGTALK' ? '钉钉 Stream 机器人' : channel.provider}</p>
      <div className="im-channel-metrics">
        <span><Server size={13} />Stream {channel.connected ? '已连接' : '未连接'}</span>
        <span><MessageCircle size={13} />{channel.onlineClients} 个处理 Worker</span>
      </div>
      <small>机器人标识：{channel.botId}</small>
    </article>)}</div>
    <div className="im-channel-note">员工在频道中发送消息后，由云端 Worker 接手并回复；桌面关闭不会影响处理。</div>
    {error && <div className="kit-error">{error}</div>}
  </div>
}

function statusLabel(status: ImChannel['status']): string {
  return ({ READY: '可用', WAITING_CLIENT: '等待 Worker', DEGRADED: '连接异常', DISABLED: '已停用',
    UNAVAILABLE: '不可用' } as Record<string, string>)[status] ?? status
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
