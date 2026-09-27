import { RotateCcw } from 'lucide-react'
import type { XiaoyinTaskProjection } from './types'
import './taskRecovery.css'

export function TaskRecoveryNotice({ projection, disabled, onResume }: { projection: XiaoyinTaskProjection; disabled: boolean; onResume?: () => void }) {
  const interruption = projection.interruption
  if (!interruption) return null
  const timestamp = new Date(interruption.checkpointAt)
  return <section className="task-recovery-notice" aria-label="任务恢复">
    <div><strong>核对进度后继续</strong><time dateTime={interruption.checkpointAt}>最后记录：{Number.isNaN(timestamp.getTime()) ? '时间未知' : timestamp.toLocaleString('zh-CN', { hour12: false })}</time></div>
    {interruption.pendingOperations.length > 0 && <><p>以下操作已开始，结果尚未确认。</p><ul>{interruption.pendingOperations.slice(0, 20).map((operation) => <li key={operation.id}>{operation.label}<small>结果待核对</small></li>)}</ul>{interruption.pendingOperations.length > 20 && <p>另有 {interruption.pendingOperations.length - 20} 项待核对</p>}</>}
    {onResume && <button type="button" disabled={disabled} title={disabled ? '请先处理当前输入或等待任务结束' : '核对现有成果并继续剩余工作'} onClick={onResume}><RotateCcw size={14} />核对并继续</button>}
  </section>
}
