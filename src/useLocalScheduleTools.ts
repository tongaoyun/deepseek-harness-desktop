import { useEffect, useRef } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { localScheduleCommand } from './localScheduleCommands'
import type { LocalSchedulesController } from './useLocalSchedules'
import type { LocalTaskRun } from './types'

export function useLocalScheduleTools(owner: string | undefined, controller: LocalSchedulesController, tasks: LocalTaskRun[], running: string[]) {
  const current = useRef({ owner, controller, tasks, running }); current.current = { owner, controller, tasks, running }
  useEffect(() => {
    if (!owner || !isTauri()) return
    let disposed = false
    const handled = new Set<string>()
    const unlisten = listen<{ taskId: string; request: { requestId: string; action: string; input: unknown } }>('xiaoyin://schedule-request', ({ payload }) => {
      if (disposed || current.current.owner !== owner) return
      const { request, taskId } = payload
      if (handled.has(request.requestId)) return
      handled.add(request.requestId)
      void (async () => {
        let result: unknown
        try {
          const state = current.current
          const task = state.tasks.find((item) => item.id === taskId)
          if (!task || !state.running.includes(taskId)) throw new Error('任务已停止或不属于当前桌面对话，未修改计划')
          result = await localScheduleCommand(owner, state.controller, task, request.action, request.input)
        } catch (error) { result = { error: error instanceof Error ? error.message : String(error) } }
        await emit(`xiaoyin://schedule-response/${request.requestId}`, result)
      })().catch(() => {})
    })
    return () => { disposed = true; void unlisten.then((stop) => stop()) }
  }, [owner])
}
