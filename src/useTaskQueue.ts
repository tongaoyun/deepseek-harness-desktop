import { useEffect, useRef, useState } from 'react'
import type { LocalTaskRun } from './types'

export interface QueuedPrompt { id: string; text: string }
export interface TaskQueue { items: QueuedPrompt[]; paused: boolean }
type Queues = Record<string, TaskQueue>
type Outcome = 'completed' | 'failed' | 'blocked'
const storageKey = (owner: string) => `xiaoyin:task-queue:${owner}`

export function readTaskQueues(owner: string): Queues {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(storageKey(owner)) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).slice(0, 200).flatMap(([id, queue]) => {
      const items = Array.isArray(queue?.items) ? queue.items.filter((item: QueuedPrompt) => item && typeof item.id === 'string' && typeof item.text === 'string' && item.text.trim() && item.text.length <= 20_000).slice(0, 20) : []
      return items.length ? [[id, { items, paused: true }]] : []
    }))
  } catch { return {} }
}

/** How many tasks the desktop starts on its own. An employee opens as many conversations as they
 *  want, but a queue continuation or a schedule firing is not their decision in the moment, so
 *  background work stays within a bound they can still reason about. */
export const AUTOMATIC_TASK_LIMIT = 3

export function useTaskQueue({ owner, ready, tasks, runningIds, run }: {
  owner?: string; ready: boolean; tasks: LocalTaskRun[]; runningIds: string[]
  run: (task: LocalTaskRun, item: QueuedPrompt, accepted: () => void) => Promise<Outcome>
}) {
  const [state, setState] = useState<{ owner: string; queues: Queues }>({ owner: '', queues: {} })
  const [error, setError] = useState('')
  const stateRef = useRef(state)
  const busy = useRef(new Set<string>())
  const storageBlocked = useRef(false)
  const runRef = useRef(run)
  useEffect(() => { runRef.current = run }, [run])
  useEffect(() => {
    const next = { owner: owner ?? '', queues: owner ? readTaskQueues(owner) : {} }
    stateRef.current = next; storageBlocked.current = false; setState(next); setError('')
  }, [owner])

  function update(taskId: string, change: (queue: TaskQueue) => TaskQueue) {
    const current = stateRef.current
    if (!owner || current.owner !== owner) return false
    const queue = change(current.queues[taskId] ?? { items: [], paused: false })
    const queues = { ...current.queues }
    if (queue.items.length) queues[taskId] = queue
    else delete queues[taskId]
    try { window.localStorage.setItem(storageKey(owner), JSON.stringify(queues)) }
    catch {
      storageBlocked.current = true
      const paused = { owner, queues: Object.fromEntries(Object.entries(current.queues).map(([id, entry]) => [id, { ...entry, paused: true }])) }
      stateRef.current = paused; setState(paused)
      setError('消息队列保存失败，自动执行已暂停，请检查本机存储空间后重试。')
      return false
    }
    storageBlocked.current = false
    const next = { owner, queues }
    stateRef.current = next; setState(next); setError('')
    return true
  }

  useEffect(() => {
    if (!ready || !owner || state.owner !== owner || runningIds.length >= AUTOMATIC_TASK_LIMIT || storageBlocked.current) return
    // One queued continuation at a time, alongside existing interactive tasks.
    if (busy.current.size) return
    const task = tasks.find((task) => !task.archivedAt && task.status !== 'RUNNING' && !runningIds.includes(task.id) && state.queues[task.id]?.items.length && !state.queues[task.id]?.paused)
    if (!task) return
    const item = state.queues[task.id].items[0]
    busy.current.add(task.id)
    let accepted = false
    void runRef.current(task, item, () => {
      const current = stateRef.current.queues[task.id]
      if (stateRef.current.owner !== owner || current?.paused || current?.items[0]?.id !== item.id || current.items[0].text !== item.text) throw new Error('队列已调整，本条消息未发送')
      if (!update(task.id, (queue) => ({ ...queue, items: queue.items.filter((entry) => entry.id !== item.id) }))) throw new Error('无法保存队列，未发送消息')
      accepted = true
    }).then((outcome) => {
      if (outcome !== 'completed' || !accepted) update(task.id, (queue) => ({ ...queue, paused: true }))
    }, () => { update(task.id, (queue) => ({ ...queue, paused: true })) }).finally(() => {
      busy.current.delete(task.id)
      setState({ ...stateRef.current })
    })
  }, [owner, ready, runningIds, state, tasks])

  return {
    queues: state.owner === owner ? state.queues : {}, error,
    enqueue(taskId: string, text: string) {
      if (!text.trim() || text.length > 20_000) { setError('每条排队消息限 20000 字符'); return false }
      if ((stateRef.current.queues[taskId]?.items.length ?? 0) >= 20) { setError('每个任务最多排队 20 条消息'); return false }
      return update(taskId, (queue) => ({ ...queue, items: [...queue.items, { id: crypto.randomUUID(), text: text.trim() }] }))
    },
    remove: (taskId: string, id: string) => update(taskId, (queue) => ({ ...queue, items: queue.items.filter((item) => item.id !== id) })),
    edit: (taskId: string, id: string, text: string) => text.trim().length > 0 && text.length <= 20_000 && update(taskId, (queue) => ({ ...queue, items: queue.items.map((item) => item.id === id ? { ...item, text: text.trim() } : item) })),
    pause: (taskId: string) => update(taskId, (queue) => ({ ...queue, paused: true })),
    resume: (taskId: string) => update(taskId, (queue) => ({ ...queue, paused: false })),
    clear: (taskId: string) => update(taskId, () => ({ items: [], paused: true })),
  }
}
