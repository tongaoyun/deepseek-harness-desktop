import { RefreshCw, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { loadAuditEvents } from './api'
import type { AuditEventEntry } from './types'

interface Props {
  endpoint: string
  employeeId: string
  accessToken: string
}

const categoryLabels: Record<AuditEventEntry['category'], string> = {
  AGENT: 'Agent', TOOL: '工具', APPROVAL: '审批', SCHEDULE: '定时任务', KNOWLEDGE: '知识库', EXTENSION: '扩展',
}
const outcomeLabels: Record<AuditEventEntry['outcome'], string> = {
  STARTED: '开始', SUCCEEDED: '成功', FAILED: '失败', DENIED: '已拒绝',
}

export function AuditEventsPage({ endpoint, employeeId, accessToken }: Props) {
  const [events, setEvents] = useState<AuditEventEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    return loadAuditEvents(endpoint, employeeId, accessToken, signal)
      .then(setEvents)
      .catch((value) => {
        if (value instanceof DOMException && value.name === 'AbortError') return
        setError(value instanceof Error ? value.message : String(value))
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [endpoint, employeeId, accessToken])

  return <div className="audit-page">
    <div className="audit-toolbar">
      <span><ShieldCheck size={16} />仅记录执行摘要和结果，不保存工具参数、密钥与业务返回原文。</span>
      <button disabled={loading} onClick={() => void refresh()} type="button"><RefreshCw size={14} />刷新</button>
    </div>
    {error && <div className="kit-error">{error}</div>}
    {loading && events.length === 0 && <div className="kit-empty">正在读取审计记录…</div>}
    {!loading && events.length === 0 && <div className="kit-empty">暂无审计记录</div>}
    <div className="audit-list">{events.map((event) => <article key={event.id}>
      <span className={`audit-outcome ${event.outcome.toLowerCase()}`}>{outcomeLabels[event.outcome]}</span>
      <div><strong>{event.action}</strong><small>{categoryLabels[event.category]} · {event.source} · {new Date(event.occurredAt).toLocaleString()}</small>{event.summary && <p>{event.summary}</p>}</div>
      <code>{event.resourceId || '—'}</code>
    </article>)}</div>
  </div>
}
