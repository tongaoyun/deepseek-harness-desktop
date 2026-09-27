import { invoke, isTauri } from '@tauri-apps/api/core'
import { nextCronRuns } from './cronPreview'
import { attachmentSelectionError } from './attachmentLimits'
import type { LocalTaskRun, LocalTaskAttachment } from './types'

export type ScheduleTiming = { kind: 'once'; at: string } | { kind: 'interval'; minutes: number }

export interface LocalScheduleRun {
  id: string; scheduledAt: string; startedAt: string; closedAt?: string
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELED' | 'INTERRUPTED' | 'MISSED' | 'NEEDS_ATTENTION'
  /** Stable product-level run identity. `id` remains the storage key for the run. */
  scheduleId?: string; scheduleRunId?: string
  taskId?: string; detail?: string
}
export interface LocalSchedule {
  id: string; name: string; prompt: string; cronExpression: string; timeZone: string
  directories: NonNullable<LocalTaskRun['localDirectories']>
  active: boolean; createdAt: string; nextAt: string; runs: LocalScheduleRun[]
  timing?: ScheduleTiming
  attachments?: LocalTaskAttachment[]
  model?: string
  timeZoneMode?: 'system' | 'fixed'
  taskContext?: Pick<LocalTaskRun, 'invocationTokens' | 'capabilitySnapshot'>
}
export type LocalScheduleInput = Pick<LocalSchedule, 'name' | 'prompt' | 'cronExpression' | 'timeZone' | 'directories' | 'timing' | 'attachments' | 'taskContext' | 'model' | 'timeZoneMode'>
export const localScheduleEvent = 'xiaoyin-local-schedules-updated'
const key = (owner: string) => `xiaoyin:local-schedules:v1:${owner}`
function parseLocalSchedules(value: unknown): LocalSchedule[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item.id !== 'string' || typeof item.prompt !== 'string' || !Array.isArray(item.runs) || !Array.isArray(item.directories) || !Number.isFinite(Date.parse(item.nextAt)))) {
    throw new Error('本机定时计划数据无法读取，已停止自动调度；原始数据保留')
  }
  return value as LocalSchedule[]
}
export async function readLocalSchedules(owner: string): Promise<LocalSchedule[]> {
  const storageKey = key(owner)
  if (!isTauri()) return parseLocalSchedules(JSON.parse(localStorage.getItem(storageKey) ?? '[]'))
  return parseLocalSchedules(await invoke<unknown>('load_local_schedules', { owner }))
}
async function writeLocalSchedules(owner: string, schedules: LocalSchedule[]) {
  if (isTauri()) await invoke('save_local_schedules', { owner, schedules })
  else localStorage.setItem(key(owner), JSON.stringify(schedules))
}
export async function mutateLocalSchedules(owner: string, update: (items: LocalSchedule[]) => LocalSchedule[]) {
  if (!navigator.locks) throw new Error('当前环境缺少本机调度锁，未保存或执行计划，请使用更新版本的小胤桌面端')
  return navigator.locks.request(`${key(owner)}:storage`, async () => {
    const previous = await readLocalSchedules(owner)
    const next = update(previous)
    if (next === previous) return previous
    await writeLocalSchedules(owner, next)
    window.dispatchEvent(new Event(localScheduleEvent))
    return next
  })
}
export function nextLocalRun(input: Pick<LocalSchedule, 'cronExpression' | 'timeZone' | 'timing'>, now: Date) {
  if (input.timing?.kind === 'once') {
    const at = Date.parse(input.timing.at)
    if (!Number.isFinite(at) || at <= now.getTime()) throw new Error('请选择未来的执行时间')
    return new Date(at).toISOString()
  }
  if (input.timing?.kind === 'interval') {
    const minutes = input.timing.minutes
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new Error('执行间隔须为 1 至 525600 分钟')
    return new Date(now.getTime() + minutes * 60000).toISOString()
  }
  const next = nextCronRuns(input.cronExpression, input.timeZone, 1, now)[0]
  if (!next) throw new Error('计划时间或时区无效')
  return next.toISOString()
}
export async function saveLocalSchedule(owner: string, input: LocalScheduleInput, id?: string, now = new Date()) {
  if (!input.name.trim() || input.name.length > 100 || !input.prompt.trim() || input.prompt.length > 10_000) throw new Error('请填写不超过 100 字的任务名称和不超过 10000 字的任务内容')
  const attachmentError = attachmentSelectionError(input.attachments ?? [])
  if (attachmentError) throw new Error(attachmentError)
  const nextAt = nextLocalRun(input, now)
  return mutateLocalSchedules(owner, (items) => {
    if (!id && items.length >= 100) throw new Error('本机最多保存 100 个计划')
    const previous = id ? items.find((item) => item.id === id) : undefined
    if (id && !previous) throw new Error('计划已被删除，请重新创建')
    const item: LocalSchedule = { ...input, id: id ?? crypto.randomUUID(), name: input.name.trim(), prompt: input.prompt.trim(),
      active: previous?.active ?? true, createdAt: previous?.createdAt ?? now.toISOString(), nextAt, runs: previous?.runs ?? [] }
    return previous ? items.map((entry) => entry.id === id ? item : entry) : [item, ...items]
  })
}

export type LocalScheduleResult = boolean | 'canceled' | { notStarted: string }
export type LocalScheduleExecutor = (schedule: LocalSchedule, taskId: string, scheduleRunId: string) => Promise<LocalScheduleResult>
/** A lease covers the actual run; state writes use a separate short lock. This
 * allows pause/delete while running and prevents a second window dispatching it. */
export async function tickLocalSchedules(owner: string, ready: () => boolean, run: LocalScheduleExecutor, now = new Date(), onlyId?: string) {
  if (!navigator.locks) throw new Error('当前环境不支持本机调度锁，自动执行已暂停')
  await navigator.locks.request(`${key(owner)}:runner`, { ifAvailable: true }, async (lock) => {
    if (!lock) { if (onlyId) throw new Error('已有本机定时任务执行中，请稍后再试'); return }
    let selected: LocalSchedule | undefined
    let record: LocalScheduleRun | undefined
    await mutateLocalSchedules(owner, (items) => {
      let changed = false
      const next = items.map((item) => {
        // With the runner lease acquired, an existing running marker can only be
        // from an interrupted process. Never replay its potentially completed writes.
        if (item.runs.some((entry) => entry.status === 'RUNNING')) {
          changed = true
          return { ...item, active: false, runs: item.runs.map((entry) => entry.status === 'RUNNING' ? { ...entry, status: 'INTERRUPTED' as const, closedAt: now.toISOString(), detail: '应用执行中断，请打开已有任务核对结果后再恢复计划' } : entry) }
        }
        if (selected || !ready() || (onlyId ? item.id !== onlyId : !item.active || Date.parse(item.nextAt) > now.getTime())) return item
        const missed = !onlyId && now.getTime() - Date.parse(item.nextAt) > 60_000
        const taskId = crypto.randomUUID()
        const scheduleRunId = crypto.randomUUID()
        record = { id: scheduleRunId, scheduleId: item.id, scheduleRunId, scheduledAt: onlyId ? now.toISOString() : item.nextAt, startedAt: now.toISOString(),
          status: missed ? 'MISSED' : 'RUNNING', ...(missed ? { closedAt: now.toISOString(), detail: '错过计划时间（应用离线、电脑休眠或执行资源未就绪），未自动补跑' } : { taskId }) }
        const once = item.timing?.kind === 'once'
        const interval = item.timing?.kind === 'interval' ? item.timing.minutes * 60000 : 0
        const followingAt = onlyId || once ? item.nextAt : interval
          ? new Date(Date.parse(item.nextAt) + (Math.floor((now.getTime() - Date.parse(item.nextAt)) / interval) + 1) * interval).toISOString()
          : nextLocalRun(item, now)
        const updated = { ...item, active: once && !onlyId ? false : item.active,
          nextAt: followingAt, runs: [record, ...item.runs].slice(0, 30) }
        changed = true
        if (!missed) selected = updated
        return updated
      })
      return changed ? next : items
    })
    if (!selected || !record?.taskId) return
    const selectedId = selected.id, runId = record.id
    let result: LocalScheduleResult = false, detail = ''
    try { if (!ready()) throw new Error('执行前账号或本机状态发生变化，本轮未启动'); result = await run(selected, record.taskId, runId) }
    catch (error) { detail = error instanceof Error ? error.message : String(error) }
    const success = result === true
    const notStarted = typeof result === 'object' && 'notStarted' in result ? result.notStarted : ''
    await mutateLocalSchedules(owner, (items) => items.map((item) => item.id !== selectedId ? item : {
      ...item, active: success ? item.active : false,
      runs: item.runs.map((entry) => {
        if (entry.id !== runId) return entry
        const { taskId: _taskId, ...withoutTask } = entry
        return { ...(notStarted ? withoutTask : entry), status: success ? 'COMPLETED' : result === 'canceled' ? 'CANCELED' : 'FAILED', closedAt: new Date().toISOString(),
          ...(!success ? { detail: notStarted || detail || (result === 'canceled' ? '本次任务已主动停止，已保留结果并暂停计划；恢复需手动操作' : '本次任务未完成，计划已暂停；请在任务对话中核对或继续') } : {}) }
      }),
    }))
  })
}
