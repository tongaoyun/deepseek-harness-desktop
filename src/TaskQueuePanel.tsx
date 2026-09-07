import { ListPlus, Pencil, X } from 'lucide-react'
import { useState } from 'react'
import type { TaskQueue } from './useTaskQueue'

export function TaskQueuePanel({ queue, onRemove, onEdit, onResume, onPause }: {
  queue?: TaskQueue; onRemove?: (id: string) => void; onEdit?: (id: string, text: string) => void; onResume?: () => void; onPause?: () => void
}) {
  const [editing, setEditing] = useState('')
  const [draft, setDraft] = useState('')
  if (!queue?.items.length) return null
  return <section className="task-queue-panel" aria-label="待处理消息">
    <header><ListPlus size={15} /><strong>待处理 {queue.items.length} 条</strong><span>{queue.paused ? '已暂停' : '按顺序自动执行'}</span><button onClick={queue.paused ? onResume : onPause} type="button">{queue.paused ? '继续队列' : '暂停队列'}</button></header>
    <ol>{queue.items.map((item) => <li key={item.id}>{editing === item.id ? <div className="queue-editor"><textarea aria-label="编辑排队消息" maxLength={20000} value={draft} onChange={(event) => setDraft(event.target.value)} /><button disabled={!draft.trim()} type="button" onClick={() => { onEdit?.(item.id, draft); setEditing('') }}>保存</button><button type="button" onClick={() => setEditing('')}>取消</button></div> : <><p>{item.text}</p><button aria-label={`编辑：${item.text.slice(0, 30)}`} onClick={() => { setEditing(item.id); setDraft(item.text) }} type="button"><Pencil size={13} /></button><button aria-label={`移除：${item.text.slice(0, 30)}`} onClick={() => onRemove?.(item.id)} type="button"><X size={14} /></button></>}</li>)}</ol>
  </section>
}
