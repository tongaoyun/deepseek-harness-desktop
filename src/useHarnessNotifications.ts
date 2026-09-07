import { useEffect, useRef, type RefObject } from 'react'
import { applyHarnessNotification, applyStoppingHarnessNotification, harnessResponseUpdate, listenHarnessNotifications } from './harness'
import { applyHarnessResponseToMessages } from './streamingMessages'
import type { TaskMessage, TaskMonitorState } from './types'

export interface StreamingTaskState {
  monitor: TaskMonitorState
  messages: TaskMessage[]
  responseKey: string
  cancellationRequested: boolean
}

export function useHarnessNotifications({
  currentTaskIdRef,
  onCurrentUpdate,
  onTaskUpdate,
  streamingTasksRef,
}: {
  currentTaskIdRef: RefObject<string>
  onCurrentUpdate: (monitor: TaskMonitorState, messages?: TaskMessage[]) => void
  onTaskUpdate: (taskId: string, monitor: TaskMonitorState, messages: TaskMessage[]) => void
  streamingTasksRef: RefObject<Map<string, StreamingTaskState>>
}) {
  const latest = useRef({ onCurrentUpdate, onTaskUpdate })
  latest.current = { onCurrentUpdate, onTaskUpdate }

  useEffect(() => {
    let disposed = false
    let unlisten: () => void = () => undefined
    void listenHarnessNotifications((notification) => {
      if (disposed) return
      const taskId = notification.taskId
      if (!taskId) return
      const streaming = streamingTasksRef.current.get(taskId)
      if (!streaming) return
      if (streaming.cancellationRequested) {
        const nextMonitor = applyStoppingHarnessNotification(streaming.monitor, notification)
        if (nextMonitor === streaming.monitor) return
        streaming.monitor = nextMonitor
        latest.current.onTaskUpdate(taskId, nextMonitor, streaming.messages)
        if (currentTaskIdRef.current === taskId) latest.current.onCurrentUpdate(nextMonitor)
        return
      }
      const nextMonitor = applyHarnessNotification(streaming.monitor, notification)
      streaming.monitor = nextMonitor
      const response = harnessResponseUpdate(notification)
      if (response) {
        const update = applyHarnessResponseToMessages(streaming.messages, response, streaming.responseKey)
        streaming.messages = update.messages
        streaming.responseKey = update.responseKey
      }
      latest.current.onTaskUpdate(taskId, nextMonitor, streaming.messages)
      if (currentTaskIdRef.current === taskId) {
        latest.current.onCurrentUpdate(nextMonitor, response ? streaming.messages : undefined)
      }
    }).then((dispose) => { if (disposed) disposeSilently(dispose); else unlisten = dispose })
    return () => { disposed = true; disposeSilently(unlisten) }
  }, [currentTaskIdRef, streamingTasksRef])
}

function disposeSilently(dispose: () => void): void {
  try {
    const pending = (dispose as unknown as () => Promise<void> | void)()
    if (pending) void pending.catch(() => undefined)
  } catch { /* Tauri may already have disposed the listener during hot reload. */ }
}
