import { useEffect, useRef, useState } from 'react'
import { localScheduleEvent, mutateLocalSchedules, nextLocalRun, readLocalSchedules, saveLocalSchedule, tickLocalSchedules, type LocalSchedule, type LocalScheduleExecutor, type LocalScheduleInput } from './localSchedules'

export function useLocalSchedules(owner: string | undefined, ready: boolean, run: LocalScheduleExecutor) {
  const [items, setItems] = useState<LocalSchedule[]>([])
  const [loadedOwner, setLoadedOwner] = useState<string>()
  const [error, setError] = useState('')
  const recoverRef = useRef<(() => Promise<void>) | undefined>(undefined)
  const current = useRef({ owner, ready, run }); current.current = { owner, ready, run }
  useEffect(() => {
    setItems([]); setError(''); setLoadedOwner(owner)
    if (!owner) return
    let pending = false, blocked = false, disposed = false
    const reload = async () => {
      try {
        const next = await readLocalSchedules(owner)
        if (!disposed && current.current.owner === owner) { setItems(next); if (!blocked) setError('') }
      } catch (reason) { if (!disposed && current.current.owner === owner) setError(String(reason)) }
    }
    void reload()
    window.addEventListener(localScheduleEvent, reload); window.addEventListener('storage', reload)
    const tick = async (recover = false) => {
      if (pending || disposed || (blocked && !recover) || current.current.owner !== owner) return
      if (!current.current.ready) {
        if (recover && blocked) setError('本机调度仍已暂停：执行尚未就绪或并发已满，请稍后重新检查。')
        return
      }
      pending = true
      try {
        const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
        if ((await readLocalSchedules(owner)).some((item) => !item.timing && item.timeZoneMode !== 'fixed' && item.timeZone !== timeZone)) {
          await mutateLocalSchedules(owner, (items) => items.map((item) => item.timing || item.timeZoneMode === 'fixed' || item.timeZone === timeZone ? item : {
            ...item, timeZone, nextAt: nextLocalRun({ ...item, timeZone }, new Date()),
          }))
        }
        await tickLocalSchedules(owner, () => current.current.owner === owner && current.current.ready, (schedule, id, scheduleRunId) => current.current.run(schedule, id, scheduleRunId))
        if (!disposed && current.current.owner === owner) { blocked = false; setItems(await readLocalSchedules(owner)); setError('') }
      }
      catch (reason) { if (!disposed) { blocked = true; setError(`本机调度已暂停：${String(reason)}。处理原因后点击“重新检查并恢复”。`) } }
      finally { pending = false }
    }
    recoverRef.current = () => tick(true)
    void tick()
    const timer = window.setInterval(() => void tick(), 15_000)
    return () => { disposed = true; recoverRef.current = undefined; clearInterval(timer); window.removeEventListener(localScheduleEvent, reload); window.removeEventListener('storage', reload) }
  }, [owner])
  async function action(id: string, action: 'pause' | 'resume' | 'delete' | 'run') {
    if (!owner) throw new Error('请先登录')
    if (action === 'run') {
      if (!current.current.ready) throw new Error('本机执行尚未就绪，或任务并发已满')
      await tickLocalSchedules(owner, () => current.current.owner === owner && current.current.ready, (schedule, taskId, scheduleRunId) => current.current.run(schedule, taskId, scheduleRunId), new Date(), id)
    } else await mutateLocalSchedules(owner, (items) => action === 'delete' ? items.filter((item) => item.id !== id) : items.map((item) => item.id !== id ? item : {
      ...item, active: action === 'resume', nextAt: action === 'resume' ? nextLocalRun(item, new Date()) : item.nextAt,
    }))
  }
  return { items: loadedOwner === owner ? items : [], error: loadedOwner === owner ? error : '', action, refresh: async () => {
    if (!owner) return
    try {
      const next = await readLocalSchedules(owner)
      if (current.current.owner === owner) setItems(next)
    } catch (reason) { if (current.current.owner === owner) setError(String(reason)) }
    void recoverRef.current?.()
  }, save: (input: LocalScheduleInput, id?: string) => {
    if (!owner) return Promise.reject(new Error('请先登录'))
    return saveLocalSchedule(owner, input, id)
  } }
}
export type LocalSchedulesController = ReturnType<typeof useLocalSchedules>
