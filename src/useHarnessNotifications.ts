import { useEffect, useRef, type RefObject } from 'react'
import { harnessProjectionUpdate, harnessResponseUpdate, listenHarnessNotifications, normalizeHarnessProjection } from './harness'
import { applyHarnessResponseToMessages } from './streamingMessages'
import type { TaskMessage, XiaoyinTaskProjection } from './types'

export interface StreamingTaskState {
  sessionId: string
  projection: XiaoyinTaskProjection
  projectionSeq?: number
  projectionSeqByKey?: Record<string, number>
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
  onCurrentUpdate: (projection: XiaoyinTaskProjection, messages?: TaskMessage[]) => void
  onTaskUpdate: (taskId: string, projection: XiaoyinTaskProjection, messages: TaskMessage[]) => void
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
      const projectionUpdate = harnessProjectionUpdate(notification)
      if (projectionUpdate) {
        if (projectionUpdate.sessionId !== streaming.sessionId) return
        const lastSeq = streaming.projectionSeqByKey?.[projectionUpdate.key] ?? (projectionUpdate.key === 'xiaoyin.task' ? streaming.projectionSeq ?? -1 : -1)
        if (projectionUpdate.seq <= lastSeq) return
        const projected = projectionForKey(streaming.projection, projectionUpdate.key, projectionUpdate.value)
        if (!projected) return
        streaming.projectionSeqByKey = { ...streaming.projectionSeqByKey, [projectionUpdate.key]: projectionUpdate.seq }
        if (projectionUpdate.key === 'xiaoyin.task') streaming.projectionSeq = projectionUpdate.seq
        const nextProjection = streaming.cancellationRequested && projectionUpdate.key === 'xiaoyin.task'
          ? mergeStoppingProjection(streaming.projection, projected)
          : projected
        streaming.projection = nextProjection
        latest.current.onTaskUpdate(taskId, nextProjection, streaming.messages)
        if (currentTaskIdRef.current === taskId) latest.current.onCurrentUpdate(nextProjection)
        return
      }
      const response = harnessResponseUpdate(notification)
      if (!response) return
      if (response) {
        const update = applyHarnessResponseToMessages(streaming.messages, response, streaming.responseKey)
        streaming.messages = update.messages
        streaming.responseKey = update.responseKey
      }
      latest.current.onTaskUpdate(taskId, streaming.projection, streaming.messages)
      if (currentTaskIdRef.current === taskId) {
        latest.current.onCurrentUpdate(streaming.projection, response ? streaming.messages : undefined)
      }
    }).then((dispose) => { if (disposed) disposeSilently(dispose); else unlisten = dispose })
    return () => { disposed = true; disposeSilently(unlisten) }
  }, [currentTaskIdRef, streamingTasksRef])
}

function projectionForKey(current: XiaoyinTaskProjection, key: string, value: unknown): XiaoyinTaskProjection | undefined {
  if (key === 'xiaoyin.task') return normalizeHarnessProjection(value)
  if (key === 'tokenUsage' && isTokenUsage(value)) return { ...current, tokenUsage: value }
  if (key === 'contextPressure' && isContextPressure(value)) return { ...current, contextPressure: value }
  return undefined
}

/**
 * Stop is an intent, not a request to discard receipts from tools already in
 * flight. Merge only updates for records that were already visible, while
 * preserving the stopping status and suppressing late assistant text/new work.
 */
function mergeStoppingProjection(current: XiaoyinTaskProjection, incoming: XiaoyinTaskProjection): XiaoyinTaskProjection {
  const mergeExisting = <T extends { id: string }>(left: T[], right: T[]): T[] => left.map((item) => {
    const update = right.find((candidate) => candidate.id === item.id)
    return update ? { ...item, ...update } : item
  })
  return {
    ...current,
    updatedAt: incoming.updatedAt,
    executionStarted: current.executionStarted || incoming.executionStarted,
    steps: mergeExisting(current.steps, incoming.steps.filter((item) => item.kind === 'tool' || item.kind === 'approval')),
    timeline: mergeExisting(current.timeline ?? [], (incoming.timeline ?? []).filter((item) => item.kind !== 'assistant')),
    subagents: mergeExisting(current.subagents ?? [], incoming.subagents ?? []),
    artifacts: mergeById(current.artifacts, incoming.artifacts),
    visuals: mergeById(current.visuals ?? [], incoming.visuals ?? []),
    changes: mergeById(current.changes ?? [], incoming.changes ?? []),
    knowledgeSources: mergeByKey(current.knowledgeSources ?? [], incoming.knowledgeSources ?? [], (item) => `${item.sourceId ?? ''}:${item.documentId}:${item.locator}`),
    outputRetention: incoming.outputRetention ?? current.outputRetention,
    ...(incoming.tokenUsage ? { tokenUsage: incoming.tokenUsage } : {}),
    ...(incoming.contextPressure ? { contextPressure: incoming.contextPressure } : {}),
    ...(incoming.compactions !== undefined ? { compactions: incoming.compactions } : {}),
  }
}

function mergeById<T extends { id: string }>(left: T[], right: T[]): T[] {
  const merged = [...left]
  for (const item of right) {
    const index = merged.findIndex((candidate) => candidate.id === item.id)
    if (index < 0) merged.push(item)
    else merged[index] = { ...merged[index], ...item }
  }
  return merged
}

function mergeByKey<T>(left: T[], right: T[], keyOf: (item: T) => string): T[] {
  const merged = [...left]
  for (const item of right) {
    const key = keyOf(item)
    const index = merged.findIndex((candidate) => keyOf(candidate) === key)
    if (index < 0) merged.push(item)
    else merged[index] = { ...merged[index], ...item }
  }
  return merged
}

function isTokenUsage(value: unknown): value is NonNullable<XiaoyinTaskProjection['tokenUsage']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return metricInteger(item.uncachedInputTokens) && metricInteger(item.outputTokens)
    && (item.cacheReadTokens === undefined || metricInteger(item.cacheReadTokens))
    && (item.cacheWriteTokens === undefined || metricInteger(item.cacheWriteTokens))
}

function isContextPressure(value: unknown): value is NonNullable<XiaoyinTaskProjection['contextPressure']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return ['contextWindow', 'pressureTokens', 'projectedTokens'].every((key) => item[key] === undefined || metricInteger(item[key]))
}

function metricInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function disposeSilently(dispose: () => void): void {
  try {
    const pending = (dispose as unknown as () => Promise<void> | void)()
    if (pending) void pending.catch(() => undefined)
  } catch { /* Tauri may already have disposed the listener during hot reload. */ }
}
