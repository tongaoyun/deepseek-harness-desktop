// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mutateLocalSchedules, nextLocalRun, readLocalSchedules, saveLocalSchedule, tickLocalSchedules } from './localSchedules'
import { localScheduleCommand } from './localScheduleCommands'
import { userEntry } from './conversation/testing'
import type { LocalTaskRun } from './types'

const now = new Date('2026-09-06T01:00:00Z')
const input = { name: '日报', prompt: '生成日报', cronExpression: '0 9 * * *', timeZone: 'Asia/Shanghai', directories: [] }
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  const held = new Map<string, Promise<unknown>>()
  vi.stubGlobal('navigator', { locks: { async request(name: string, options: unknown, handler?: (lock: object | null) => unknown) {
    const callback = handler ?? options as (lock: object | null) => unknown
    if (held.has(name)) {
      if (handler && (options as { ifAvailable?: boolean }).ifAvailable) return callback(null)
      await held.get(name)
    }
    let release!: () => void
    held.set(name, new Promise<void>((resolve) => { release = resolve }))
    try { return await callback({ name }) } finally { held.delete(name); release() }
  } } })
})
afterEach(() => vi.unstubAllGlobals())
it('runs a one-off exactly once and persists its completed disabled state', async () => {
  await saveLocalSchedule('one', { ...input, timing: { kind: 'once', at: now.toISOString() } }, undefined, new Date(now.getTime() - 60000))
  const run = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, run, now)
  await tickLocalSchedules('one', () => true, run, new Date(now.getTime() + 86400000))
  expect(run).toHaveBeenCalledOnce()
  expect((await readLocalSchedules('one'))[0]).toMatchObject({ active: false, runs: [{ status: 'COMPLETED' }] })
})
it('expires a missed one-off without replaying and rejects saving past dates', async () => {
  const timing = { kind: 'once' as const, at: now.toISOString() }
  await saveLocalSchedule('one', { ...input, timing }, undefined, new Date(now.getTime() - 60000))
  const run = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, run, new Date(now.getTime() + 90000))
  expect((await readLocalSchedules('one'))[0]).toMatchObject({ active: false, runs: [{ status: 'MISSED' }] })
  expect(run).not.toHaveBeenCalled()
  await expect(saveLocalSchedule('one', { ...input, timing }, undefined, now)).rejects.toThrow('未来')
})
it('anchors intervals without drifting with polling and skips missed intervals', async () => {
  await saveLocalSchedule('one', { ...input, timing: { kind: 'interval', minutes: 180 } }, undefined, now)
  const run = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, run, new Date(now.getTime() + 10815000))
  expect((await readLocalSchedules('one'))[0].nextAt).toBe(new Date(now.getTime() + 21600000).toISOString())
  await tickLocalSchedules('one', () => true, run, new Date(now.getTime() + 33000000))
  expect(run).toHaveBeenCalledOnce()
  expect((await readLocalSchedules('one'))[0].runs[0].status).toBe('MISSED')
  expect(() => nextLocalRun({ ...input, timing: { kind: 'interval', minutes: 0 } }, now)).toThrow('间隔')
})
it('chat tools create in the same local store, inherit files and retain pause state on edit', async () => {
  const file = { id: 'file', rootId: 'root', rootName: '资料', name: 'input.csv', path: 'input.csv', kind: 'file' as const }
  const task = { model: 'selected-model', localDirectories: [{ id: 'root', name: '资料', path: '/tmp/fixture' }], entries: [userEntry('turn-1', '日报', [file])] } as LocalTaskRun
  const controller = { items: [], error: '', action: vi.fn(async () => {}), refresh: vi.fn(), save: vi.fn(async () => []) }
  await localScheduleCommand('one', controller, task, 'create', { name: '日报', prompt: '分析资料', intervalMinutes: 60 })
  const created = (await readLocalSchedules('one'))[0]
  expect(created).toMatchObject({ active: true, model: 'selected-model', timing: { kind: 'interval', minutes: 60 }, directories: task.localDirectories, attachments: [file] })
  await mutateLocalSchedules('one', (items) => items.map((item) => ({ ...item, active: false })))
  await localScheduleCommand('one', controller, task, 'update', { id: created.id, name: '修改日报', cronExpression: '0 18 * * 1,4' })
  expect((await readLocalSchedules('one'))[0]).toMatchObject({ active: false, name: '修改日报', cronExpression: '0 18 * * 1,4', attachments: [file] })
  expect((await readLocalSchedules('one'))[0].timing).toBeUndefined()
  await expect(localScheduleCommand('one', controller, task, 'create', { name: '冲突', prompt: '测试', runAt: '2030-01-01', intervalMinutes: 5 })).rejects.toThrow('请选择一个')
  await expect(localScheduleCommand('one', controller, task, 'create', { name: '缺时间', prompt: '测试' })).rejects.toThrow('请选择一个')
  await expect(localScheduleCommand('one', controller, task, 'update', { id: 'missing' })).rejects.toThrow('不存在')
  expect(await readLocalSchedules('one')).toHaveLength(1)
})
async function due() {
  await saveLocalSchedule('one', input, undefined, new Date(now.getTime() - 60_000))
  return (await readLocalSchedules('one'))[0]
}
it('does not write or broadcast when an idle tick changes no schedule', async () => {
  await saveLocalSchedule('one', input, undefined, now)
  const write = vi.spyOn(localStorage, 'setItem')
  const updated = vi.fn()
  window.addEventListener('xiaoyin-local-schedules-updated', updated)
  try {
    await tickLocalSchedules('one', () => true, vi.fn(), now)
    expect(write).not.toHaveBeenCalled()
    expect(updated).not.toHaveBeenCalled()
  } finally { window.removeEventListener('xiaoyin-local-schedules-updated', updated) }
})
it('preserves an explicitly configured timezone and model when a chat tool edits the name', async () => {
  await saveLocalSchedule('fixed', { ...input, timeZone: 'UTC', timeZoneMode: 'fixed', model: 'selected-model' })
  const id = (await readLocalSchedules('fixed'))[0].id
  const controller = { items: [], error: '', action: vi.fn(async () => {}), refresh: vi.fn(), save: vi.fn(async () => []) }
  await localScheduleCommand('fixed', controller, { entries: [] } as unknown as LocalTaskRun, 'update', { id, name: '新的名称' })
  expect((await readLocalSchedules('fixed'))[0]).toMatchObject({ name: '新的名称', timeZone: 'UTC', timeZoneMode: 'fixed', model: 'selected-model' })
  expect(nextLocalRun((await readLocalSchedules('fixed'))[0], now)).toBe('2026-09-06T09:00:00.000Z')
})
it('dispatches a due plan once through the shared task callback and persists the task link', async () => {
  await due()
  const run = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, run, now)
  await tickLocalSchedules('one', () => true, run, now)
  expect(run).toHaveBeenCalledOnce()
  const plan = (await readLocalSchedules('one'))[0]
  expect(plan.runs[0]).toMatchObject({ status: 'COMPLETED', taskId: expect.any(String), scheduleId: plan.id, scheduleRunId: expect.any(String) })
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: plan.id }), plan.runs[0].taskId, plan.runs[0].scheduleRunId)
})
it('records missed offline windows without catch-up execution', async () => {
  await due()
  const run = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, run, new Date(now.getTime() + 90_000))
  expect(run).not.toHaveBeenCalled()
  expect((await readLocalSchedules('one'))[0].runs[0].status).toBe('MISSED')
})
it('pauses a schedule when its official run does not complete', async () => {
  await due()
  await tickLocalSchedules('one', () => true, async () => false, now)
  expect((await readLocalSchedules('one'))[0]).toMatchObject({ active: false, runs: [{ status: 'FAILED', taskId: expect.any(String) }] })
  const rerun = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, rerun, new Date(now.getTime() + 86400_000))
  expect(rerun).not.toHaveBeenCalled()
})
it('records deliberate cancellation separately and pauses future runs without losing the task link', async () => {
  await due()
  await tickLocalSchedules('one', () => true, async () => 'canceled', now)
  expect((await readLocalSchedules('one'))[0]).toMatchObject({ active: false, runs: [{ status: 'CANCELED', taskId: expect.any(String), detail: expect.stringContaining('主动停止') }] })
  const rerun = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, rerun, new Date(now.getTime() + 86400_000))
  expect(rerun).not.toHaveBeenCalled()
})
it('does not offer a nonexistent task link when preflight prevents dispatch', async () => {
  await due()
  await tickLocalSchedules('one', () => true, async () => ({ notStarted: '请先选择工作目录' }), now)
  const plan = (await readLocalSchedules('one'))[0]
  expect(plan.active).toBe(false)
  expect(plan.runs[0]).toMatchObject({ status: 'FAILED', detail: '请先选择工作目录' })
  expect(plan.runs[0].taskId).toBeUndefined()
})
it('pauses failed and interrupted runs rather than replaying side effects', async () => {
  const plan = await due()
  await tickLocalSchedules('one', () => true, async () => false, now)
  expect((await readLocalSchedules('one'))[0].active).toBe(false)
  await mutateLocalSchedules('one', (items) => items.map((item) => ({ ...item, active: true, runs: [{ id: 'old', taskId: 'partial-task', scheduledAt: now.toISOString(), startedAt: now.toISOString(), status: 'RUNNING' }] })))
  const run = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, run, now, plan.id)
  expect(run).not.toHaveBeenCalled()
  expect((await readLocalSchedules('one'))[0]).toMatchObject({ active: false, runs: [{ status: 'INTERRUPTED', taskId: 'partial-task' }] })
})
it('holds a cross-window lease while executing but allows pausing the next run', async () => {
  const plan = await due()
  let finish!: (value: boolean) => void
  let started!: () => void
  const begin = new Promise<void>((resolve) => { started = resolve })
  const first = tickLocalSchedules('one', () => true, () => { started(); return new Promise((resolve) => { finish = resolve }) }, now)
  await begin
  const second = vi.fn(async () => true)
  await tickLocalSchedules('one', () => true, second, now)
  await expect(tickLocalSchedules('one', () => true, second, now, plan.id)).rejects.toThrow('执行中')
  await mutateLocalSchedules('one', (items) => items.map((item) => ({ ...item, active: false })))
  finish(true); await first
  expect(second).not.toHaveBeenCalled()
  expect((await readLocalSchedules('one'))[0].active).toBe(false)
})
it('does not execute if the durable running marker cannot be written', async () => {
  await due()
  const fail = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('disk full') })
  const run = vi.fn(async () => true)
  await expect(tickLocalSchedules('one', () => true, run, now)).rejects.toThrow('disk full')
  expect(run).not.toHaveBeenCalled()
  fail.mockRestore()
})
it('keeps owners isolated and does not silently replace corrupt data', async () => {
  await due()
  expect(await readLocalSchedules('another')).toEqual([])
  localStorage.setItem('xiaoyin:local-schedules:v1:one', '{broken')
  await expect(saveLocalSchedule('one', input)).rejects.toThrow()
  expect(localStorage.getItem('xiaoyin:local-schedules:v1:one')).toBe('{broken')
})
