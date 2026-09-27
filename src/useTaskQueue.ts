import { invoke, isTauri } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import type { LocalTaskRun } from './types'

export interface QueuedPrompt { id: string; text: string }
export interface TaskQueue { items: QueuedPrompt[]; paused: boolean }
type Queues = Record<string, TaskQueue>
type Outcome = 'completed' | 'failed' | 'blocked'
const storageKey = (owner: string) => `xiaoyin:task-queue:${owner}`

function parseTaskQueues(value: unknown): Queues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本机消息队列数据无法读取，原始数据保留')
  const entries = Object.entries(value)
  if (entries.length > 200) throw new Error('本机消息队列数据无法读取，原始数据保留')
  const queues: Queues = {}
  for (const [taskId, queue] of entries) {
    if (!taskId.trim() || taskId.length > 200 || !queue || typeof queue !== 'object' || Array.isArray(queue)) throw new Error('本机消息队列数据无法读取，原始数据保留')
    const input = queue as Partial<TaskQueue>
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20 || input.items.some((item) => !item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 20_000)) {
      throw new Error('本机消息队列数据无法读取，原始数据保留')
    }
    queues[taskId] = { items: input.items, paused: true }
  }
  return queues
}

export async function readTaskQueues(owner: string): Promise<Queues> {
  const key = storageKey(owner)
  if (!isTauri()) return parseTaskQueues(JSON.parse(window.localStorage.getItem(key) ?? '{}'))
  return parseTaskQueues(await invoke<unknown>('load_local_task_queues', { employeeId: owner }))
}

async function saveTaskQueues(owner: string, queues: Queues) {
  if (isTauri()) await invoke('save_local_task_queues', { employeeId: owner, queues })
  else window.localStorage.setItem(storageKey(owner), JSON.stringify(queues))
}

/** How many tasks the desktop starts on its own. An employee opens as many conversations as they
 *  want, but a queue continuation or a schedule firing is not their decision in the moment, so
 *  background work stays within a bound they can still reason about. */
export const AUTOMATIC_TASK_LIMIT = 3

export function useTaskQueue({ owner, ready, tasks, runningIds, run }: {
  owner?: string; ready: boolean; tasks: LocalTaskRun[]; runningIds: string[]
  run: (task: LocalTaskRun, item: QueuedPrompt, accepted: () => Promise<void>) => Promise<Outcome>
}) {
  const [state, setState] = useState<{ owner: string; queues: Queues }>({ owner: '', queues: {} })
  const [error, setError] = useState('')
  const stateRef = useRef(state)
  const busy = useRef(new Set<string>())
  const reconciling = useRef(new Set<string>())
  const storageBlocked = useRef(false)
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const runRef = useRef(run)
  useEffect(() => { runRef.current = run }, [run])
  useEffect(() => {
    let disposed = false
    const empty = { owner: '', queues: {} }
    stateRef.current = empty; storageBlocked.current = false; setState(empty); setError('')
    if (owner) void readTaskQueues(owner).then((queues) => {
      if (disposed) return
      const next = { owner, queues }
      stateRef.current = next; setState(next)
    }, (reason) => {
      if (disposed) return
      storageBlocked.current = true
      setError(`消息队列加载失败，自动执行已暂停：${reason instanceof Error ? reason.message : String(reason)}`)
    })
    return () => { disposed = true }
  }, [owner])

  function update(taskId: string, change: (queue: TaskQueue) => TaskQueue): Promise<boolean> {
    const operation = writeChain.current.then(async () => {
      const current = stateRef.current
      if (!owner || current.owner !== owner) return false
      const queue = change(current.queues[taskId] ?? { items: [], paused: false })
      const queues = { ...current.queues }
      if (queue.items.length) queues[taskId] = queue
      else delete queues[taskId]
      try { await saveTaskQueues(owner, queues) }
      catch {
        storageBlocked.current = true
        const paused = { owner, queues: Object.fromEntries(Object.entries(current.queues).map(([id, entry]) => [id, { ...entry, paused: true }])) }
        if (stateRef.current.owner === owner) { stateRef.current = paused; setState(paused); setError('消息队列保存失败，自动执行已暂停，请检查本机存储空间后重试。') }
        return false
      }
      if (stateRef.current.owner !== owner) return false
      storageBlocked.current = false
      const next = { owner, queues }
      stateRef.current = next; setState(next); setError('')
      return true
    })
    writeChain.current = operation.then(() => undefined, () => undefined)
    return operation
  }

  useEffect(() => {
    if (!owner || state.owner !== owner || storageBlocked.current) return
    for (const [taskId, queue] of Object.entries(state.queues)) {
      const first = queue.items[0]
      if (!first || !tasks.find((task) => task.id === taskId)?.entries.some((entry) => entry.role === 'user' && entry.id === first.id)) continue
      const key = JSON.stringify([owner, taskId, first.id])
      if (reconciling.current.has(key)) return
      reconciling.current.add(key)
      void update(taskId, (current) => ({ ...current, paused: true, items: current.items[0]?.id === first.id ? current.items.slice(1) : current.items }))
        .finally(() => reconciling.current.delete(key))
      return
    }
  }, [owner, state, tasks])

  useEffect(() => {
    if (!ready || !owner || state.owner !== owner || runningIds.length >= AUTOMATIC_TASK_LIMIT || storageBlocked.current) return
    // One queued continuation at a time, alongside existing interactive tasks.
    if (busy.current.size) return
    const task = tasks.find((task) => !task.archivedAt && task.status !== 'RUNNING' && !runningIds.includes(task.id) && state.queues[task.id]?.items.length && !state.queues[task.id]?.paused
      && !task.entries.some((entry) => entry.role === 'user' && entry.id === state.queues[task.id].items[0]?.id))
    if (!task) return
    const item = state.queues[task.id].items[0]
    busy.current.add(task.id)
    let accepted = false
    void (async () => {
      try {
        const outcome = await runRef.current(task, item, async () => {
          const current = stateRef.current.queues[task.id]
          if (stateRef.current.owner !== owner || current?.paused || current?.items[0]?.id !== item.id || current.items[0].text !== item.text) throw new Error('队列已调整，本条消息未发送')
          if (!await update(task.id, (queue) => ({ ...queue, items: queue.items.filter((entry) => entry.id !== item.id) }))) throw new Error('无法保存队列，未发送消息')
          accepted = true
        })
        if (outcome !== 'completed' || !accepted) await update(task.id, (queue) => ({ ...queue, paused: true }))
      } catch { await update(task.id, (queue) => ({ ...queue, paused: true })) }
      finally { busy.current.delete(task.id); setState({ ...stateRef.current }) }
    })()
  }, [owner, ready, runningIds, state, tasks])

  return {
    queues: state.owner === owner ? state.queues : {}, error,
    async enqueue(taskId: string, text: string, requestedId?: string) {
      if (!text.trim() || text.length > 20_000) { setError('每条排队消息限 20000 字符'); return false }
      if ((stateRef.current.queues[taskId]?.items.length ?? 0) >= 20) { setError('每个任务最多排队 20 条消息'); return false }
      const id = requestedId?.trim() || crypto.randomUUID()
      if (requestedId && stateRef.current.queues[taskId]?.items.some((item) => item.id === id)) return true
      return await update(taskId, (queue) => ({ ...queue, items: [...queue.items, { id, text: text.trim() }] }))
    },
    remove: (taskId: string, id: string) => update(taskId, (queue) => ({ ...queue, items: queue.items.filter((item) => item.id !== id) })),
    edit: async (taskId: string, id: string, text: string) => text.trim().length > 0 && text.length <= 20_000 && await update(taskId, (queue) => ({ ...queue, items: queue.items.map((item) => item.id === id ? { ...item, text: text.trim() } : item) })),
    pause: (taskId: string) => update(taskId, (queue) => ({ ...queue, paused: true })),
    resume: (taskId: string) => update(taskId, (queue) => ({ ...queue, paused: false })),
    clear: (taskId: string) => update(taskId, () => ({ items: [], paused: true })),
  }
}
