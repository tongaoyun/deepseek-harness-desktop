import { useEffect, useRef } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { localSkillCommand, type SkillCommandContext } from './localSkillCommands'
import type { LocalTaskRun } from './types'

export function useLocalSkillTools(owner: string | undefined, context: Omit<SkillCommandContext, 'assertActive'>, tasks: LocalTaskRun[], running: string[]) {
  const current = useRef({ owner, context, tasks, running }); current.current = { owner, context, tasks, running }
  useEffect(() => {
    if (!owner || !isTauri()) return
    let disposed = false
    const handled = new Set<string>()
    const unlisten = listen<{ taskId: string; request: { requestId: string; action: string; input: unknown } }>('xiaoyin://skill-request', ({ payload }) => {
      if (disposed || current.current.owner !== owner) return
      const { request, taskId } = payload
      if (handled.has(request.requestId)) return
      handled.add(request.requestId)
      void (async () => {
        let result: unknown
        try {
          const assertActive = () => {
            const state = current.current
            if (disposed || state.owner !== owner || !state.tasks.some((task) => task.id === taskId) || !state.running.includes(taskId)) throw new Error('任务已停止或账号已切换，技能操作已结束')
          }
          result = await localSkillCommand({ ...current.current.context, assertActive }, request.action, request.input)
        } catch (error) { result = { error: error instanceof Error ? error.message : String(error) } }
        await emit(`xiaoyin://skill-response/${request.requestId}`, result)
      })().catch(() => {})
    })
    return () => { disposed = true; void unlisten.then((stop) => stop()) }
  }, [owner])
}
