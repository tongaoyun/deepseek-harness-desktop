import { Boxes, FileText, PlugZap, SearchCheck } from 'lucide-react'
import { ExecutionTrace } from './ExecutionTrace'
import { TaskArtifacts } from './TaskArtifacts'
import type { CapabilitySnapshot, TaskMonitorState } from './types'

interface Props {
  monitor: TaskMonitorState
  capabilitySnapshot?: CapabilitySnapshot
}

export function TaskMonitor({ monitor, capabilitySnapshot }: Props) {
  return <aside aria-label="任务监控" className="task-monitor">
    <header>
      <span><i className={monitor.status} /><strong>Task Monitor</strong></span>
      <small>{statusLabel(monitor.status)}</small>
    </header>
    <section className="monitor-activity">
      <strong>{monitor.activity}</strong>
      <small>{new Date(monitor.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small>
    </section>
    <section>
      <h2>执行计划 <em>{monitor.steps.length}</em></h2>
      {monitor.steps.length > 0
        ? <ExecutionTrace steps={monitor.steps} />
        : <div className="monitor-empty"><SearchCheck size={17} />发送任务后显示实时步骤</div>}
    </section>
    <section>
      <h2>任务产物 <em>{monitor.artifacts.length}</em></h2>
      {monitor.artifacts.length > 0
        ? <TaskArtifacts artifacts={monitor.artifacts} />
        : <div className="monitor-empty"><FileText size={17} />暂无结构化产物</div>}
    </section>
    <section>
      <h2>本任务能力</h2>
      {capabilitySnapshot
        ? <div className="monitor-capabilities">
          <span><Boxes size={14} />{capabilitySnapshot.extensions.length} 个扩展</span>
          <span><PlugZap size={14} />{capabilitySnapshot.connectors.length} 个连接器</span>
          <span><SearchCheck size={14} />{capabilitySnapshot.knowledgeBaseRefs.length} 个知识库</span>
        </div>
        : <div className="monitor-empty">首次发送时固定能力快照</div>}
    </section>
  </aside>
}

function statusLabel(status: TaskMonitorState['status']): string {
  if (status === 'running') return '执行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'canceled') return '已取消'
  return '待开始'
}
