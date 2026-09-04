import { useEffect, useRef } from 'react'
import { loadLocalImStatus, startLocalIm, syncLocalImTasks, type LocalImHarnessContext } from './localIm'
import { mergeImStatusIntoTasks } from './imTaskSync'
import { persistTaskHistory } from './taskHistory'
import type { LocalTaskRun } from './types'

const SYNC_INTERVAL_MS = 10_000
const FAILURE_NOTICE_THRESHOLD = 3

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

  useEffect(() => {
    if (!enabled || !context) return
    void startLocalIm(context).then(async (status) => {
      if (status.enabled) await syncLocalImTasks(synchronizedTasks(latest.current.tasks))
    }).catch((reason) => latest.current.onSyncError?.(`IM 连接启动失败：${message(reason)}`))
  }, [context, enabled])

  useEffect(() => {
    if (!enabled || !employeeId) return
    let disposed = false
    let synchronizing = false
    let consecutiveFailures = 0
    let failureReported = false
    const synchronize = async () => {
      if (document.hidden || synchronizing) return
      synchronizing = true
      try {
        await syncLocalImTasks(synchronizedTasks(latest.current.tasks))
        const status = await loadLocalImStatus()
        if (disposed) return
        if (!status.enabled) {
          consecutiveFailures = 0
          failureReported = false
          return
        }
        const merged = mergeImStatusIntoTasks(latest.current.tasks, status)
        if (merged.changed.length > 0) {
          await Promise.all(merged.changed.map((task) => persistTaskHistory(employeeId, task)))
          if (disposed) return
          latest.current.tasks = merged.tasks
          latest.current.onTasksChanged(merged.tasks)
          const selected = merged.changed.find((task) => task.id === latest.current.currentTaskId)
          if (selected) latest.current.onCurrentTaskChanged(selected)
        }
        consecutiveFailures = 0
        failureReported = false
      } catch (reason) {
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
