import { CalendarClock, Check, ChevronDown, Clock3, MoreHorizontal, Play, Plus, RefreshCw, Server, Trash2, X } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { changeScheduledTask, createScheduledTask, deleteScheduledTask, loadScheduledTaskExecutions, loadScheduledTasks } from './api'
import { cronPresets, nextCronRuns } from './cronPreview'
import { loadLocalImStatus, routeLocalImSchedule, type LocalImConversationSummary } from './localIm'
import { parseNaturalSchedule } from './scheduleLanguage'
import type { ScheduledTask, ScheduledTaskExecution } from './types'

interface Props {
  endpoint: string
  employeeId: string
  accessToken: string
  onCreateWithXiaoyin: () => void
}

type ScheduleView = 'tasks' | 'executions'
type SortOrder = 'created-desc' | 'created-asc' | 'name'

export function ScheduledTasksPage({ endpoint, employeeId, accessToken, onCreateWithXiaoyin }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [name, setName] = useState('')
  const [naturalLanguage, setNaturalLanguage] = useState('')
  const [parseSummary, setParseSummary] = useState('')
  const [cronExpression, setCronExpression] = useState('0 9 * * 1-5')
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [executions, setExecutions] = useState<Record<string, ScheduledTaskExecution[]>>({})
  const [executionsLoading, setExecutionsLoading] = useState(false)
  const [error, setError] = useState('')
  const [imConversations, setImConversations] = useState<LocalImConversationSummary[]>([])
  const [deliveryConversationKey, setDeliveryConversationKey] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [view, setView] = useState<ScheduleView>('tasks')
  const [sort, setSort] = useState<SortOrder>('created-desc')
  const [menuId, setMenuId] = useState('')

  const refresh = async () => {
    setLoading(true)
    setError('')
    try { setTasks(await loadScheduledTasks(endpoint, employeeId, accessToken)) }
    catch (reason) { setError(message(reason)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void refresh() }, [accessToken, employeeId, endpoint])
  useEffect(() => { void loadLocalImStatus().then((status) => setImConversations(status.enabled ? status.conversations : [])).catch(() => setImConversations([])) }, [])

  const upcomingRuns = useMemo(() => nextCronRuns(cronExpression, timeZone), [cronExpression, timeZone])
  const sortedTasks = useMemo(() => [...tasks].sort((left, right) => {
    if (sort === 'name') return left.name.localeCompare(right.name, 'zh-CN')
    const difference = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    return sort === 'created-desc' ? difference : -difference
  }), [sort, tasks])
  const executionRows = useMemo(() => tasks.flatMap((task) => (executions[task.id] ?? []).map((execution) => ({ task, execution })))
    .sort((left, right) => new Date(right.execution.startedAt).getTime() - new Date(left.execution.startedAt).getTime()), [executions, tasks])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!naturalLanguage.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      const task = await createScheduledTask(endpoint, employeeId, accessToken, {
        name: name.trim() || '定时任务',
        expertKitId: 'xiaoyin-agent',
        workflowId: 'agent-prompt',
        cronExpression: cronExpression.trim(),
        timeZone: timeZone.trim(),
        inputs: { prompt: naturalLanguage.trim() },
      })
      setTasks((current) => [task, ...current])
      if (deliveryConversationKey) await routeLocalImSchedule(task.id, deliveryConversationKey)
      resetForm()
      setCreateOpen(false)
    } catch (reason) { setError(message(reason)) }
    finally { setSaving(false) }
  }

  const parseSchedule = () => {
    setError('')
    try {
      const parsed = parseNaturalSchedule(naturalLanguage)
      if (!name.trim()) setName(parsed.name)
      setCronExpression(parsed.cronExpression)
      setParseSummary(`已识别：${parsed.summary}`)
    } catch (reason) { setParseSummary(''); setError(message(reason)) }
  }

  const operate = async (task: ScheduledTask, action: 'pause' | 'resume' | 'run' | 'delete') => {
    setBusyId(task.id)
    setMenuId('')
    setError('')
    try {
      if (action === 'delete') {
        await deleteScheduledTask(endpoint, employeeId, accessToken, task.id)
        setTasks((current) => current.filter((item) => item.id !== task.id))
      } else {
        const updated = await changeScheduledTask(endpoint, employeeId, accessToken, task.id, action)
        setTasks((current) => current.map((item) => item.id === task.id ? updated : item))
      }
    } catch (reason) { setError(message(reason)) }
    finally { setBusyId('') }
  }

  const showExecutions = async () => {
    setView('executions')
    const missing = tasks.filter((task) => !executions[task.id])
    if (missing.length === 0) return
    setExecutionsLoading(true)
    try {
      const values = await Promise.all(missing.map(async (task) => [task.id, await loadScheduledTaskExecutions(endpoint, employeeId, accessToken, task.id)] as const))
      setExecutions((current) => ({ ...current, ...Object.fromEntries(values) }))
    } catch (reason) { setError(message(reason)) }
    finally { setExecutionsLoading(false) }
  }

  const resetForm = () => {
    setName('')
    setNaturalLanguage('')
    setParseSummary('')
    setDeliveryConversationKey('')
  }

  return <div className="schedule-page">
    <header className="schedule-page-heading"><div><h1>定时任务</h1><p>按计划自动执行任务，也可随时手动触发。在任意对话中描述你想定期做的事，即可快速创建。</p></div><div><button aria-label="刷新任务" className="refresh-extension-button" disabled={loading} onClick={() => void refresh()} type="button"><RefreshCw className={loading ? 'spin' : ''} size={17} /></button><button className="schedule-create-with-ai" onClick={onCreateWithXiaoyin} type="button"><CalendarClock size={16} />通过小胤创建</button><button className="schedule-new-button" onClick={() => setCreateOpen(true)} type="button"><Plus size={17} />新建定时任务</button></div></header>
    <div className="schedule-server-note"><span><Server size={16} />任务在公司服务器运行，关闭电脑后仍会继续</span><strong><Check size={15} />云端持续运行</strong></div>
    <div className="schedule-toolbar"><div role="tablist"><button aria-selected={view === 'tasks'} className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')} role="tab" type="button">我的定时任务</button><button aria-selected={view === 'executions'} className={view === 'executions' ? 'active' : ''} onClick={() => void showExecutions()} role="tab" type="button">执行记录</button></div>{view === 'tasks' && <label className="schedule-sort"><select aria-label="任务排序" onChange={(event) => setSort(event.target.value as SortOrder)} value={sort}><option value="created-desc">按创建时间倒序</option><option value="created-asc">按创建时间正序</option><option value="name">按名称排序</option></select><ChevronDown size={14} /></label>}</div>
    {error && <div className="kit-error schedule-error">{error}</div>}
    {view === 'tasks' ? <div className="schedule-list">
      {loading && <div className="kit-empty">正在读取云端任务…</div>}
      {!loading && tasks.length === 0 && <div className="kit-empty">还没有定时任务，点击右上角创建第一个。</div>}
      {sortedTasks.map((task) => <article className="schedule-card" key={task.id}>
        <div className="schedule-card-top"><button aria-label={task.status === 'ACTIVE' ? '暂停任务' : '恢复任务'} className={`schedule-toggle ${task.status === 'ACTIVE' ? 'active' : ''}`} disabled={busyId === task.id} onClick={() => void operate(task, task.status === 'ACTIVE' ? 'pause' : 'resume')} type="button"><i /></button><div className="schedule-card-menu"><button aria-label="任务操作" onClick={() => setMenuId((current) => current === task.id ? '' : task.id)} type="button"><MoreHorizontal size={19} /></button>{menuId === task.id && <div><button disabled={busyId === task.id} onClick={() => void operate(task, 'run')} type="button"><Play size={15} />立即执行</button><button className="danger" disabled={busyId === task.id} onClick={() => void operate(task, 'delete')} type="button"><Trash2 size={15} />删除任务</button></div>}</div></div>
        <h3>{task.name}</h3><p>{taskDescription(task)}</p><footer><span><Clock3 size={15} />{cronLabel(task.cronExpression)} · {task.timeZone}</span><small>{task.expertKitId} / {task.workflowId}</small></footer>
      </article>)}
    </div> : <div className="schedule-execution-page">
      {executionsLoading && <div className="kit-empty">正在读取执行记录…</div>}
      {!executionsLoading && executionRows.length === 0 && <div className="kit-empty">还没有执行记录</div>}
      {executionRows.map(({ task, execution }) => <article key={`${task.id}:${execution.runId}`}><span className={`execution-status ${execution.status.toLowerCase()}`}>{executionStatus(execution.status)}</span><div><strong>{task.name}</strong><small>{execution.runId}</small></div><time>{new Date(execution.startedAt).toLocaleString('zh-CN', { hour12: false })}</time></article>)}
    </div>}
    {createOpen && <div className="schedule-modal-backdrop" onMouseDown={() => setCreateOpen(false)} role="presentation"><form aria-modal="true" className="schedule-modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit} role="dialog">
      <button aria-label="关闭" className="schedule-modal-close" onClick={() => setCreateOpen(false)} type="button"><X size={20} /></button><header><h2>新建定时任务</h2><p>按计划自动执行任务，也可随时手动触发。</p></header>
      <label>任务名称<input maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="描述你的任务" value={name} /></label>
        <div className="schedule-modal-time"><label>计划时间<select aria-label="计划频率" onChange={(event) => setCronExpression(event.target.value)} value={cronExpression}>{cronPresets.map((preset) => <option key={preset.expression} value={preset.expression}>{preset.label}</option>)}{!cronPresets.some((preset) => preset.expression === cronExpression) && <option value={cronExpression}>自然语言识别时间</option>}</select></label><label>时区<input onChange={(event) => setTimeZone(event.target.value)} value={timeZone} /></label></div>
        <label className="schedule-prompt-label"><span>让小胤帮你做什么… <button disabled={!naturalLanguage.trim()} onClick={parseSchedule} type="button">识别时间</button></span><textarea maxLength={10000} onChange={(event) => setNaturalLanguage(event.target.value)} placeholder="例如：每个工作日下午 6:30 汇总最新业务数据并给出异常提醒" required value={naturalLanguage} /></label>
        {parseSummary && <div className="schedule-parse-result">{parseSummary}</div>}
        <label>完成后推送到<select onChange={(event) => setDeliveryConversationKey(event.target.value)} value={deliveryConversationKey}><option value="">不推送到 IM</option>{imConversations.map((conversation) => <option key={conversation.conversationKey} value={conversation.conversationKey}>{conversation.conversationType === 'group' ? conversation.conversationTitle || '未命名群' : conversation.senderNick || '钉钉用户'}</option>)}</select></label>
        <small className="cron-hint">{upcomingRuns.length > 0 ? `接下来：${upcomingRuns.map((value) => value.toLocaleString('zh-CN', { timeZone, hour12: false })).join('、')}` : '执行时间或时区无效，请检查后再保存'}</small>
      <footer><button className="secondary" onClick={() => setCreateOpen(false)} type="button">取消</button><button disabled={saving || !naturalLanguage.trim() || upcomingRuns.length === 0} type="submit">{saving ? '正在保存…' : '保存'}</button></footer>
    </form></div>}
  </div>
}

function taskDescription(task: ScheduledTask): string {
  const text = Object.values(task.inputs).find((value) => typeof value === 'string' && value.trim())
  return typeof text === 'string' ? text : `按计划执行 ${task.workflowId}`
}

function cronLabel(expression: string): string {
  return cronPresets.find((preset) => preset.expression === expression)?.label ?? expression
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function executionStatus(status: string): string { return ({ RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELED: '已取消', TERMINATED: '已终止' } as Record<string, string>)[status] ?? status }
