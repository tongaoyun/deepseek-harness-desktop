import { useEffect, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import { loadLocalImStatus, type LocalImConversationSummary } from './localIm'

export function ChannelHistory({ onOpen, onConfigure }: { onOpen: (key: string) => void; onConfigure: () => void }) {
  const [conversations, setConversations] = useState<LocalImConversationSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let pending = false
    const refresh = async () => {
      if (disposed || pending || document.hidden) return
      pending = true
      try {
        const status = await loadLocalImStatus()
        if (!disposed) { setConversations(status.conversations); setError('') }
      } catch { if (!disposed) setError('频道会话暂不可用，请到 IM 频道检查连接。') }
      finally { pending = false; if (!disposed) setLoading(false) }
    }
    void refresh()
    const timer = window.setInterval(refresh, 10_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  return <div className="recent-tasks channel-history">
    {loading && <p className="channel-empty">正在读取频道会话…</p>}
    {error && <p className="channel-empty" role="alert">{error}</p>}
    {!loading && !error && conversations.length === 0 && <div className="channel-empty">还没有产生任何频道任务或对话，连接 IM 频道后即可开始。<button onClick={onConfigure} type="button">连接 IM 频道</button></div>}
    {conversations.map((conversation) => <button className="recent-task channel-task" key={conversation.conversationKey} onClick={() => onOpen(conversation.conversationKey)} type="button"><MessageCircle size={15} /><span>{conversation.conversationType === 'group' ? conversation.conversationTitle || '未命名群' : conversation.senderNick || '钉钉用户'}<small>{conversation.deliveryStatus === 'FAILED' ? '结果发送待处理' : conversation.status === 'RUNNING' ? '处理中' : conversation.lastMessage || '暂无消息'}</small></span></button>)}
  </div>
}
