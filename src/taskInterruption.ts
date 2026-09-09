import type { TaskMonitorState } from './types'

export const TASK_RESUME_PROMPT = '继续完成当前任务。先读取现有成果，核对上轮已完成步骤和结果待确认的工具操作，再执行剩余工作。不要重复已经成功的写入、提交或发送；外部操作结果无法核实时先说明不确定性。完成后检查实际结果并交付。'

export function taskInterruption(monitor: TaskMonitorState, cause: NonNullable<TaskMonitorState['interruption']>['cause'], checkpointAt = monitor.updatedAt): NonNullable<TaskMonitorState['interruption']> {
  const pending = new Map((monitor.interruption?.pendingOperations ?? []).map(operation => [operation.id, operation]))
  for (const entry of [...monitor.steps, ...(monitor.timeline ?? [])]) {
    if ((entry.kind === 'tool' || entry.toolName) && entry.status === 'running') pending.set(entry.id, {
      id: entry.id, label: entry.label, ...('toolName' in entry && entry.toolName ? { toolName: entry.toolName } : {}),
    })
  }
  return { checkpointAt, cause, pendingOperations: [...pending.values()] }
}
