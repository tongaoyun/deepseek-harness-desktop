import { useEffect, useRef } from 'react'
import { persistTaskHistory } from './taskHistory'
import type { LocalTaskRun } from './types'

/** Bounded periodic snapshots, not a second task store or per-token database writes. */
export function useTaskCheckpoints(employeeId: string | undefined, tasks: LocalTaskRun[], onError: (reason: unknown) => void, save = persistTaskHistory) {
  const latest = useRef({ employeeId, tasks, onError, save })
  latest.current = { employeeId, tasks, onError, save }
  useEffect(() => {
    if (!employeeId) return
    const saved = new Map<string, string>()
    const pending = new Set<string>()
    const checkpoint = () => {
      if (latest.current.employeeId !== employeeId) return
      const runningIds = new Set(latest.current.tasks.filter((task) => task.status === 'RUNNING').map((task) => task.id))
      for (const id of saved.keys()) if (!runningIds.has(id)) saved.delete(id)
      for (const task of latest.current.tasks) {
        if (task.status !== 'RUNNING' || pending.has(task.id)) continue
        const key = checkpointKey(task)
        if (saved.get(task.id) === key) continue
        pending.add(task.id)
        void latest.current.save(employeeId, task).then(() => saved.set(task.id, key)).catch((reason) => {
          if (latest.current.employeeId === employeeId) latest.current.onError(reason)
        }).finally(() => pending.delete(task.id))
      }
    }
    const timer = window.setInterval(checkpoint, 2000)
    window.addEventListener('pagehide', checkpoint)
    return () => { window.clearInterval(timer); window.removeEventListener('pagehide', checkpoint) }
  }, [employeeId])
}

function checkpointKey(task: LocalTaskRun): string {
  // Keep the dedupe key bounded; durable details are owned by Harness Persistence.
  return JSON.stringify([task.sessionId ?? '', task.status, task.updatedAt, task.projection.updatedAt, task.messagePreview?.slice(-500) ?? ''])
}
