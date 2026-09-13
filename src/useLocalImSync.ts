import { useEffect, useRef } from 'react'
import { loadLocalImStatus, startLocalIm, stopLocalImRuntime, syncLocalImTasks, type LocalImHarnessContext } from './localIm'
import { mergeImStatusIntoTasks } from './imTaskSync'
import { persistTaskHistory } from './taskHistory'
import type { LocalTaskRun } from './types'

const SYNC_INTERVAL_MS = 10_000
const FAILURE_NOTICE_THRESHOLD = 3
let startupQueue: Promise<void> = Promise.resolve()

export function useLocalImSync({
  context,
  currentTaskId,
  employeeId,
  enabled,
  onCurrentTaskChanged,
  onSyncError,
  onTasksChanged,
  tasks,
}: {
  context?: LocalImHarnessContext
  currentTaskId: string
  employeeId?: string
  enabled: boolean
  onCurrentTaskChanged: (task: LocalTaskRun) => void
  onSyncError?: (message: string) => void
  onTasksChanged: (tasks: LocalTaskRun[]) => void
  tasks: LocalTaskRun[]
}) {
  const latest = useRef({ currentTaskId, onCurrentTaskChanged, onSyncError, onTasksChanged, tasks })
  latest.current = { currentTaskId, onCurrentTaskChanged, onSyncError, onTasksChanged, tasks }
  const started = useRef(false)
  const configuredContext = useRef('')

  useEffect(() => {
    if (!enabled || !context) {
      if (started.current) {
        started.current = false
        configuredContext.current = ''
        startupQueue = startupQueue.then(async () => {
          try { await stopLocalImRuntime() }
          catch (reason) { latest.current.onSyncError?.(`IM 连接停止失败：${message(reason)}`) }
        })
      }
      return
    }
    started.current = true
    let disposed = false
    const contextKey = JSON.stringify(context)
    startupQueue = startupQueue.then(async () => {
      if (disposed) return
      if (configuredContext.current === contextKey) return
      try {
        const status = await startLocalIm(context)
        if (!disposed) configuredContext.current = contextKey
        if (!disposed && status.enabled) await syncLocalImTasks(synchronizedTasks(latest.current.tasks))
      } catch (reason) {
        if (!disposed) latest.current.onSyncError?.(`IM 连接启动失败：${message(reason)}`)
      }
    })
    return () => { disposed = true }
  }, [context, enabled])

  useEffect(() => () => {
    if (!started.current) return
    started.current = false
    configuredContext.current = ''
    startupQueue = startupQueue.then(() => stopLocalImRuntime()).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!enabled || !employeeId) return
    let disposed = false
    let synchronizing = false
    let consecutiveFailures = 0
    let failureReported = false
    const synchronize = async () => {
      if (disposed || document.hidden || synchronizing) return
      synchronizing = true
      try {
        await syncLocalImTasks(synchronizedTasks(latest.current.tasks))
        if (disposed) return
        const status = await loadLocalImStatus()
        if (disposed) return
        if (!status.enabled) {
          consecutiveFailures = 0
          failureReported = false
          return
        }
        const snapshot = latest.current.tasks
        const merged = mergeImStatusIntoTasks(snapshot, status)
        if (merged.changed.length > 0) {
          await Promise.all(merged.changed.map((task) => persistTaskHistory(employeeId, task)))
          if (disposed) return
          // A local action during persistence wins. Reconcile the next poll instead of
          // replacing newly created, edited or deleted desktop tasks with this snapshot.
          if (latest.current.tasks !== snapshot) return
          latest.current.tasks = merged.tasks
          latest.current.onTasksChanged(merged.tasks)
          const selected = merged.changed.find((task) => task.id === latest.current.currentTaskId)
          if (selected) latest.current.onCurrentTaskChanged(selected)
        }
        consecutiveFailures = 0
        failureReported = false
      } catch (reason) {
        if (disposed) return
        consecutiveFailures += 1
        if (consecutiveFailures >= FAILURE_NOTICE_THRESHOLD && !failureReported) {
          failureReported = true
          latest.current.onSyncError?.(`IM 同步连续失败，请检查频道状态：${message(reason)}`)
        }
      } finally {
        synchronizing = false
      }
    }
    const synchronizeWhenVisible = () => {
      if (!document.hidden) void synchronize()
    }
    void synchronize()
    const timer = window.setInterval(() => void synchronize(), SYNC_INTERVAL_MS)
    document.addEventListener('visibilitychange', synchronizeWhenVisible)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', synchronizeWhenVisible)
    }
  }, [employeeId, enabled])
}

function synchronizedTasks(tasks: LocalTaskRun[]) {
  return tasks.filter((task) => task.sessionId && !task.archivedAt)
    .map((task) => ({ id: task.id, name: task.name, sessionId: task.sessionId! }))
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
