import type { XiaoyinTaskProjection } from './types'

export const TASK_RESUME_PROMPT = '继续完成当前任务。先读取现有成果，核对上轮已完成步骤和结果待确认的工具操作，再执行剩余工作。不要重复已经成功的写入、提交或发送；外部操作结果无法核实时先说明不确定性。完成后检查实际结果并交付。'

export function taskInterruption(projection: XiaoyinTaskProjection, cause: NonNullable<XiaoyinTaskProjection['interruption']>['cause'], checkpointAt = projection.updatedAt): NonNullable<XiaoyinTaskProjection['interruption']> {
  // The official Harness Session Log owns pending tool receipts. Product
  // state only preserves a prior explicit interruption record and never
  // reconstructs writes from cached UI steps.
  return { checkpointAt, cause, pendingOperations: projection.interruption?.pendingOperations ?? [] }
}
