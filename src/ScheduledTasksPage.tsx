import { CalendarPlus, CirclePause, CirclePlay, Play, Trash2 } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  changeScheduledTask,
  createScheduledTask,
  deleteScheduledTask,
  loadScheduledTasks,
  loadScheduledTaskExecutions,
} from './api'
import type { ExpertKitView } from './expertKits'
import type { ScheduledTask, ScheduledTaskExecution, ServerWorkflowInput } from './types'

interface Props {
  endpoint: string
  employeeId: string
  accessToken: string
  expertKits: ExpertKitView[]
}

export function ScheduledTasksPage({ endpoint, employeeId, accessToken, expertKits }: Props) {
  const workflows = useMemo(() => expertKits.flatMap((kit) =>
    (kit.serverWorkflows ?? []).map((workflow) => ({ kit, workflow }))), [expertKits])
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [selection, setSelection] = useState('')
  const [name, setName] = useState('')
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5')
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai')
  const [inputs, setInputs] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [expandedId, setExpandedId] = useState('')
  const [executions, setExecutions] = useState<Record<string, ScheduledTaskExecution[]>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selection && workflows.length > 0) {
      const first = workflows.find(({ kit }) => kit.readiness === 'ready') ?? workflows[0]
      setSelection(`${first.kit.id}:${first.workflow.id}`)
    }
  }, [selection, workflows])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    loadScheduledTasks(endpoint, employeeId, accessToken, controller.signal)
      .then(setTasks)
      .catch((reason) => { if (!controller.signal.aborted) setError(message(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [accessToken, employeeId, endpoint])

  const selected = workflows.find(({ kit, workflow }) => `${kit.id}:${workflow.id}` === selection)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected || selected.kit.readiness !== 'ready' || saving) return
    setSaving(true)
    setError('')
    try {
      const task = await createScheduledTask(endpoint, employeeId, accessToken, {
        name: name.trim() || selected.workflow.name,
        expertKitId: selected.kit.id,
        workflowId: selected.workflow.id,
        cronExpression: cronExpression.trim(),
        timeZone: timeZone.trim(),
        inputs: normalizeInputs(selected.workflow.inputs, inputs),
      })
      setTasks((current) => [task, ...current])
      setName('')
      setInputs({})
    } catch (reason) {
      setError(message(reason))
    } finally {
      setSaving(false)
    }
  }

  const operate = async (task: ScheduledTask, action: 'pause' | 'resume' | 'run' | 'delete') => {
    setBusyId(task.id)
    setError('')
    try {
      if (action === 'delete') {
        await deleteScheduledTask(endpoint, employeeId, accessToken, task.id)
        setTasks((current) => current.filter((item) => item.id !== task.id))
      } else {
        const updated = await changeScheduledTask(endpoint, employeeId, accessToken, task.id, action)
        setTasks((current) => current.map((item) => item.id === task.id ? updated : item))
      }
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusyId('')
    }
  }

  const toggleExecutions = async (task: ScheduledTask) => {
    if (expandedId === task.id) { setExpandedId(''); return }
    setExpandedId(task.id)
    if (executions[task.id]) return
    setBusyId(task.id)
    try {
      const values = await loadScheduledTaskExecutions(endpoint, employeeId, accessToken, task.id)
      setExecutions((current) => ({ ...current, [task.id]: values }))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusyId('')
    }
  }

  return <div className="schedule-layout">
    <form className="schedule-form" onSubmit={submit}>
      <div className="schedule-section-title"><CalendarPlus size={17} /><span><strong>新建定时任务</strong><small>任务在公司服务器运行，关闭电脑后仍会继续。</small></span></div>
      {workflows.length === 0 ? <div className="kit-empty">已发布的专家套件尚未声明后台工作流</div> : <>
        <label>专家工作流<select value={selection} onChange={(event) => { setSelection(event.target.value); setInputs({}) }}>
          {workflows.map(({ kit, workflow }) => <option disabled={kit.readiness !== 'ready'} key={`${kit.id}:${workflow.id}`} value={`${kit.id}:${workflow.id}`}>{kit.name} · {workflow.name}{kit.readiness !== 'ready' ? '（依赖未就绪）' : ''}</option>)}
        </select></label>
        {selected?.kit.readiness !== 'ready' && <div className="schedule-dependency-warning">暂不可创建：{selected?.kit.connectorIssues.join('；')}</div>}
        <label>任务名称<input maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={selected?.workflow.name} value={name} /></label>
        <div className="schedule-fields">
          <label>Cron 表达式<input onChange={(event) => setCronExpression(event.target.value)} value={cronExpression} /></label>
          <label>时区<input onChange={(event) => setTimeZone(event.target.value)} value={timeZone} /></label>
        </div>
        {selected?.workflow.inputs.map((input) => <WorkflowInputField input={input} key={input.name} value={inputs[input.name]} onChange={(value) => setInputs((current) => ({ ...current, [input.name]: value }))} />)}
        <small className="cron-hint">示例：工作日每天 9:00 为 <code>0 9 * * 1-5</code></small>
        <button className="schedule-primary" disabled={saving || selected?.kit.readiness !== 'ready'} type="submit">{saving ? '正在创建…' : '创建任务'}</button>
      </>}
    </form>

    <div className="schedule-list">
      <div className="schedule-list-head"><strong>我的任务</strong><small>{tasks.length} 个</small></div>
      {loading && <div className="kit-empty">正在读取云端任务…</div>}
      {!loading && tasks.length === 0 && <div className="kit-empty">还没有定时任务</div>}
      {tasks.map((task) => <article className="schedule-card" key={task.id}>
        <div><span className={`schedule-status ${task.status.toLowerCase()}`}>{task.status === 'ACTIVE' ? '运行中' : '已暂停'}</span><small>{task.expertKitId} · {task.workflowId}</small></div>
        <h3>{task.name}</h3>
        <p><code>{task.cronExpression}</code><span>{task.timeZone}</span></p>
        <div className="schedule-actions">
          <button disabled={busyId === task.id} onClick={() => void operate(task, 'run')} title="立即运行" type="button"><Play size={14} />立即运行</button>
          <button disabled={busyId === task.id} onClick={() => void operate(task, task.status === 'ACTIVE' ? 'pause' : 'resume')} type="button">{task.status === 'ACTIVE' ? <CirclePause size={14} /> : <CirclePlay size={14} />}{task.status === 'ACTIVE' ? '暂停' : '恢复'}</button>
          <button disabled={busyId === task.id} onClick={() => void toggleExecutions(task)} type="button">执行记录</button>
          <button className="danger" disabled={busyId === task.id} onClick={() => void operate(task, 'delete')} title="删除" type="button"><Trash2 size={14} /></button>
        </div>
        {expandedId === task.id && <div className="execution-list">
          {!executions[task.id] && <small>正在读取…</small>}
          {executions[task.id]?.length === 0 && <small>尚无执行记录</small>}
          {executions[task.id]?.map((execution) => <div key={execution.runId}>
            <span className={`execution-status ${execution.status.toLowerCase()}`}>{executionStatus(execution.status)}</span>
            <time>{new Date(execution.startedAt).toLocaleString()}</time>
          </div>)}
        </div>}
      </article>)}
    </div>
    {error && <div className="kit-error schedule-error">{error}</div>}
  </div>
}

function WorkflowInputField({ input, value, onChange }: {
  input: ServerWorkflowInput
  value: unknown
  onChange: (value: unknown) => void
}) {
  if (input.type === 'boolean') {
    return <label className="schedule-checkbox"><input checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} type="checkbox" />{input.label}</label>
  }
  return <label>{input.label}{input.required && <em>*</em>}<input
    onChange={(event) => onChange(event.target.value)}
    placeholder={input.description}
    required={input.required}
    type={input.type === 'date' ? 'date' : input.type === 'integer' ? 'number' : 'text'}
    value={typeof value === 'string' || typeof value === 'number' ? value : ''}
  /></label>
}

function normalizeInputs(definitions: ServerWorkflowInput[], values: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const input of definitions) {
    const value = values[input.name]
    if (value === undefined || value === '') {
      if (input.required) normalized[input.name] = value
      continue
    }
    normalized[input.name] = input.type === 'integer' ? Number(value) : value
  }
  return normalized
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function executionStatus(status: string): string {
  return ({ RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELED: '已取消', TERMINATED: '已终止' } as Record<string, string>)[status] ?? status
}
