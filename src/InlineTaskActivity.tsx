import { ChevronRight, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ExecutionTimeline } from './ExecutionTimeline'
import { taskDurationLabel } from './taskTiming'
import type { TaskMonitorState } from './types'

export function InlineTaskActivity({ monitor, finalResponse = '' }: { monitor: TaskMonitorState; finalResponse?: string }) {
  const [open, setOpen] = useState(monitor.status === 'running' || (monitor.timeline?.length ?? 0) > 0)
  const [clock, setClock] = useState(Date.now())

  useEffect(() => {
    if (monitor.status === 'running') setOpen(true)
  }, [monitor.status])

  useEffect(() => {
    if (monitor.status !== 'running') return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [monitor.status])

  if (monitor.status === 'idle' && monitor.steps.length === 0 && monitor.artifacts.length === 0) return null
  const duration = taskDurationLabel(monitor, clock)
  const summary = monitor.status === 'running'
    ? duration ? `正在处理 ${duration}` : monitor.activity
    : duration ? `${monitor.status === 'failed' ? '处理失败' : '已处理'} ${duration}` : statusLabel(monitor.status)
  const hasDetails = (monitor.timeline?.length ?? 0) > 0

  return <section className={`inline-task-activity ${monitor.status}`}>
    <button aria-expanded={hasDetails ? open : undefined} className="inline-task-summary" disabled={!hasDetails} onClick={() => setOpen((current) => !current)} type="button">
      {monitor.status === 'running' && <LoaderCircle className="turn-spinner" size={14} />}
      <span>{summary}</span>
      {hasDetails && <ChevronRight className={open ? 'open' : ''} size={15} />}
    </button>
    {open && hasDetails && <ExecutionTimeline entries={monitor.timeline ?? []} finalResponse={finalResponse} />}
  </section>
}

function statusLabel(status: TaskMonitorState['status']): string {
  if (status === 'running') return '执行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'canceled') return '已取消'
  return '待开始'
}
