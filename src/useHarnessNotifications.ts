import { useEffect, useRef, type RefObject } from 'react'
import { harnessResponseUpdate, listenHarnessNotifications } from './harness'
import { observeHarnessNotification } from './executionRuntime'
import { applyHarnessResponseToMessages } from './streamingMessages'
import type { ExecutionThread, TaskMessage, TaskMonitorState } from './types'

export interface StreamingTaskState {
  monitor: TaskMonitorState
  execution: ExecutionThread
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
  onTaskUpdate: (taskId: string, monitor: TaskMonitorState, messages: TaskMessage[], execution: ExecutionThread) => void
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
        const observed = observeHarnessNotification(streaming.execution, streaming.monitor, notification, { stopping: true })
        if (!observed.event) return
        streaming.execution = observed.thread
        streaming.monitor = observed.monitor
        latest.current.onTaskUpdate(taskId, observed.monitor, streaming.messages, observed.thread)
        if (currentTaskIdRef.current === taskId) latest.current.onCurrentUpdate(observed.monitor)
        return
      }
      const observed = observeHarnessNotification(streaming.execution, streaming.monitor, notification)
      if (observed.duplicate) return
      streaming.execution = observed.thread
      streaming.monitor = observed.monitor
      const response = harnessResponseUpdate(notification)
      if (response) {
        const update = applyHarnessResponseToMessages(streaming.messages, response, streaming.responseKey)
        streaming.messages = update.messages
        streaming.responseKey = update.responseKey
      }
      latest.current.onTaskUpdate(taskId, observed.monitor, streaming.messages, observed.thread)
      if (currentTaskIdRef.current === taskId) {
        latest.current.onCurrentUpdate(observed.monitor, response ? streaming.messages : undefined)
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
