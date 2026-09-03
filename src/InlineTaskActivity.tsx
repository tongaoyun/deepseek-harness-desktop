import { ChevronRight, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ExecutionTrace } from './ExecutionTrace'
import { taskDurationLabel } from './taskTiming'
import type { TaskMonitorState } from './types'

export function InlineTaskActivity({ monitor }: { monitor: TaskMonitorState }) {
  const [open, setOpen] = useState(monitor.status === 'running')
  const [clock, setClock] = useState(Date.now())

  useEffect(() => {
    setOpen(monitor.status === 'running')
  }, [monitor.status])

  useEffect(() => {
    if (monitor.status !== 'running') return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [monitor.status])

  if (monitor.status === 'idle' && monitor.steps.length === 0 && monitor.artifacts.length === 0) return null
  const duration = taskDurationLabel(monitor, clock)
  const summary = monitor.status === 'running'
    ? monitor.activity
    : duration ? `用时 ${duration}` : statusLabel(monitor.status)

  return <section className={`inline-task-activity ${monitor.status}`}>
    <button aria-expanded={open} className="inline-task-summary" onClick={() => setOpen((current) => !current)} type="button">
      {monitor.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
      <span>{summary}</span>
      {monitor.steps.length > 0 && <small>{monitor.steps.length} 项操作</small>}
      <ChevronRight className={open ? 'open' : ''} size={15} />
    </button>
    {open && <div className="inline-task-body">
      {monitor.steps.length > 0 && <ExecutionTrace steps={monitor.steps} />}
      {monitor.steps.length === 0 && <p>{monitor.activity}</p>}
    </div>}
  </section>
}

function statusLabel(status: TaskMonitorState['status']): string {
  if (status === 'running') return '执行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'canceled') return '已取消'
  return '待开始'
}
