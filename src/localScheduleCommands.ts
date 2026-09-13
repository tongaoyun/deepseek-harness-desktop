import { readLocalSchedules, saveLocalSchedule, type LocalScheduleInput } from './localSchedules'
import type { LocalSchedulesController } from './useLocalSchedules'
import type { LocalTaskRun } from './types'

export async function localScheduleCommand(owner: string, controller: LocalSchedulesController,
  task: LocalTaskRun, action: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务参数无效')
  const input = value as Record<string, unknown>
  if (action === 'list') return await readLocalSchedules(owner)
  const id = typeof input.id === 'string' ? input.id : ''
  const previous = id ? (await readLocalSchedules(owner)).find((item) => item.id === id) : undefined
  if (action !== 'create' && !previous) throw new Error('任务不存在，请先查询定时任务列表')
  if (['pause', 'resume', 'delete'].includes(action)) {
    await controller.action(id, action as 'pause' | 'resume' | 'delete')
    return { success: true, id, action }
  }
  if (action !== 'create' && action !== 'update') throw new Error('不支持的操作')
  const suppliedTime = ['cronExpression', 'runAt', 'intervalMinutes'].filter((key) => input[key] !== undefined)
  if (suppliedTime.length > 1 || action === 'create' && suppliedTime.length !== 1) throw new Error('请选择一个计划时间：周期、一次性时间或分钟间隔')
  const draft: LocalScheduleInput = previous ? { ...previous } : {
    name: '', prompt: '', cronExpression: '', timeZone: '', directories: task.localDirectories ?? [],
    model: task.model,
    taskContext: { invocationTokens: task.invocationTokens, capabilitySnapshot: task.capabilitySnapshot },
    attachments: task.messages.flatMap((message) => message.role === 'user' ? message.attachments ?? [] : [])
      .filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index),
  }
  for (const key of ['name', 'prompt', 'cronExpression'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new Error(`${key} 必须为文本`)
      draft[key] = input[key]
    }
  }
  if (draft.name.length > 100) throw new Error('任务名称不能超过 100 字')
  if (suppliedTime.length) draft.timing = undefined
  if (input.runAt !== undefined) {
    if (typeof input.runAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(input.runAt)) throw new Error('一次性时间必须包含时区偏移')
    draft.timing = { kind: 'once', at: input.runAt }
  }
  if (input.intervalMinutes !== undefined) {
    if (typeof input.intervalMinutes !== 'number') throw new Error('间隔必须为分钟数')
    draft.timing = { kind: 'interval', minutes: input.intervalMinutes }
  }
  if (draft.timeZoneMode !== 'fixed') draft.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const result = await saveLocalSchedule(owner, draft, action === 'update' ? id : undefined)
  return { schedule: action === 'update' ? result.find((item) => item.id === id) : result[0],
    execution: '由本机调度，需要小胤运行、电脑唤醒。每次生成独立任务对话；不会在服务器执行。' }
}
