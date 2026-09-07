import { useEffect, useRef, useState } from 'react'
import { persistTaskHistory } from './taskHistory'
import type { LocalTaskRun } from './types'

interface Failure { task: LocalTaskRun; detail: string; retrying: boolean }
/** One visible save state for final writes and periodic checkpoints. */
export function useTaskPersistence(owner: string | undefined, tasks: LocalTaskRun[]) {
  const [failures, setFailures] = useState<Record<string, Failure>>({})
  const [loadedOwner, setLoadedOwner] = useState(owner)
  const context = useRef({ owner, versions: new Map<string, number>() })
  if (context.current.owner !== owner) context.current = { owner, versions: new Map() }
  const current = useRef({ tasks, failures }); current.current = { tasks, failures }
  useEffect(() => { setFailures({}); setLoadedOwner(owner) }, [owner])
  async function save(task: LocalTaskRun) {
    const request = context.current
    if (!request.owner || request.owner !== owner) throw new Error('账号已变化，请在当前账号下保存任务')
    const version = (request.versions.get(task.id) ?? 0) + 1
    request.versions.set(task.id, version)
    const valid = () => context.current === request && request.versions.get(task.id) === version
    setFailures((values) => values[task.id] ? { ...values, [task.id]: { ...values[task.id], retrying: true } } : values)
    try {
      await persistTaskHistory(request.owner, task)
      if (valid()) setFailures((values) => { const next = { ...values }; delete next[task.id]; return next })
    } catch (reason) {
      if (valid()) setFailures((values) => ({ ...values, [task.id]: { task, detail: reason instanceof Error ? reason.message : String(reason), retrying: false } }))
      throw reason
    }
  }
  function forget(id: string) {
    context.current.versions.set(id, (context.current.versions.get(id) ?? 0) + 1)
    setFailures((values) => { const next = { ...values }; delete next[id]; return next })
  }
  async function retry() {
    await Promise.all(Object.values(current.current.failures).filter((item) => !item.retrying).map((item) =>
      save(current.current.tasks.find((task) => task.id === item.task.id) ?? item.task).catch(() => undefined)))
  }
  const visible = loadedOwner === owner ? Object.values(failures) : []
  useEffect(() => {
    if (!visible.length) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [visible.length])
  return { save, forget, retry, failures: visible }
}
