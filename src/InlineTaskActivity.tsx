import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ExecutionTrace } from './ExecutionTrace'
import { TaskArtifacts } from './TaskArtifacts'
import type { TaskMonitorState } from './types'

export function InlineTaskActivity({ monitor }: { monitor: TaskMonitorState }) {
  const [open, setOpen] = useState(monitor.status === 'running')

  useEffect(() => {
    setOpen(monitor.status === 'running')
  }, [monitor.status])

  if (monitor.status === 'idle' && monitor.steps.length === 0 && monitor.artifacts.length === 0) return null
  const count = monitor.steps.length

  return <section className={`inline-task-activity ${monitor.status}`}>
    <button aria-expanded={open} className="inline-task-summary" onClick={() => setOpen((current) => !current)} type="button">
      <i aria-hidden="true" />
      <span>{monitor.activity}</span>
      <small>{count > 0 ? `${count} 项操作` : statusLabel(monitor.status)}</small>
      <ChevronDown className={open ? 'open' : ''} size={14} />
    </button>
    {open && <div className="inline-task-body">
      {monitor.steps.length > 0 && <ExecutionTrace steps={monitor.steps} />}
      {monitor.artifacts.length > 0 && <div className="inline-artifacts"><strong>生成的文件</strong><TaskArtifacts artifacts={monitor.artifacts} /></div>}
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
