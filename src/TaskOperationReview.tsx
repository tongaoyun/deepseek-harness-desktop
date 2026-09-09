import { invoke, isTauri } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'

interface TaskOperation { id: string; connector: string; tool: string; startedAt: string }

export function TaskOperationReview({ employeeId, taskId, revision, disabled }: {
  employeeId: string; taskId: string; revision: string; disabled: boolean
}) {
  const [operations, setOperations] = useState<TaskOperation[]>([])
  const [reviewing, setReviewing] = useState<{ id: string; applied: boolean }>()
  const [evidence, setEvidence] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  useEffect(() => {
    if (!isTauri() || disabled) return
    let active = true
    void invoke<TaskOperation[]>('task_write_operations', { request: { employeeId, taskId } })
      .then(value => { if (active) setOperations(value) }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [employeeId, taskId, revision, disabled])
  if (!operations.length && !error) return null
  return <section className="task-operation-review" aria-label="外部操作核对">
    <strong><ShieldAlert size={16} />外部操作待核对</strong>
    {operations.map(operation => <div className="task-operation-row" key={operation.id}>
      <div><span>{operation.connector} · {operation.tool}</span><small>{operation.id.slice(0, 12)} · {new Date(operation.startedAt).toLocaleString('zh-CN', { hour12: false })}</small></div>
      <div className="task-operation-actions"><button disabled={busy || disabled} type="button" onClick={() => { setReviewing({ id: operation.id, applied: true }); setEvidence('') }}>已确认完成</button><button disabled={busy || disabled} type="button" onClick={() => { setReviewing({ id: operation.id, applied: false }); setEvidence('') }}>已确认未执行</button></div>
    </div>)}
    {reviewing && <form onSubmit={async event => {
      event.preventDefault()
      if (lock.current || disabled) return
      lock.current = true; setBusy(true); setError('')
      try {
        setOperations(await invoke<TaskOperation[]>('task_write_operations', { request: { employeeId, taskId, resolution: { ...reviewing, evidence } } }))
        setReviewing(undefined)
      } catch (reason) { setError(String(reason)) }
      finally { lock.current = false; setBusy(false) }
    }}><label>核对依据<textarea required minLength={5} maxLength={2000} rows={2} disabled={busy || disabled} value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
      <div className="task-operation-actions"><button disabled={busy || disabled || evidence.trim().length < 5} type="submit">{reviewing.applied ? '确认已完成' : '确认未执行，允许重试'}</button><button disabled={busy} type="button" onClick={() => setReviewing(undefined)}>取消</button></div>
    </form>}
    {error && <p role="alert">{error}</p>}
  </section>
}
