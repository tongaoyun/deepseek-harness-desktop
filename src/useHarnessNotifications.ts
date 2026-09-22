import { useEffect, useRef, type RefObject } from 'react'
import { harnessLiveEvent, harnessProjectionUpdate, listenHarnessNotifications, normalizeHarnessProjection } from './harness'
import { appendCapabilityNotice, applyLiveEvent, mergeSettledTurn } from './conversation/liveText'
import { captureCapabilityNotices, type StoredCapabilityNotice } from './conversation/capabilityNotices'
import { parseAssistantTurn, type ConversationEntry } from './conversation/types'
import type { LocalTaskRun, XiaoyinTaskProjection } from './types'

export interface StreamingTaskState {
  phase?: 'preparing' | 'running'
  sessionId: string
  projection: XiaoyinTaskProjection
  projectionSeq?: number
  projectionSeqByKey?: Record<string, number>
  entries: ConversationEntry[]
  task?: LocalTaskRun
  cancellationRequested: boolean
  stopFallback?: number
}

export function useHarnessNotifications({
  currentTaskIdRef,
  onCurrentUpdate,
  onTaskUpdate,
  onCapabilityNotice,
  streamingTasksRef,
}: {
  currentTaskIdRef: RefObject<string>
  onCurrentUpdate: (projection: XiaoyinTaskProjection, entries?: ConversationEntry[]) => void
  onTaskUpdate: (taskId: string, projection: XiaoyinTaskProjection, entries: ConversationEntry[]) => void
  onCapabilityNotice?: (taskId: string, notice: StoredCapabilityNotice) => void
  streamingTasksRef: RefObject<Map<string, StreamingTaskState>>
}) {
  const latest = useRef({ onCurrentUpdate, onTaskUpdate, onCapabilityNotice })
  latest.current = { onCurrentUpdate, onTaskUpdate, onCapabilityNotice }

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
        if (projectionUpdate.key === 'xiaoyin.capabilityNotice') {
          const lastSeq = streaming.projectionSeqByKey?.['xiaoyin.capabilityNotice'] ?? -1
          if (projectionUpdate.seq <= lastSeq) return
          const notice = projectionUpdate.value as { kind?: unknown; name?: unknown; reason?: unknown } | undefined
          if (!notice || typeof notice.name !== 'string' || typeof notice.reason !== 'string') return
          streaming.projectionSeqByKey = { ...streaming.projectionSeqByKey, 'xiaoyin.capabilityNotice': projectionUpdate.seq }
          const entries = appendCapabilityNotice(streaming.entries, { kind: String(notice.kind ?? ''), name: notice.name, reason: notice.reason })
          if (entries === streaming.entries) return
          streaming.entries = entries
          latest.current.onTaskUpdate(taskId, streaming.projection, streaming.entries)
          if (currentTaskIdRef.current === taskId) latest.current.onCurrentUpdate(streaming.projection, streaming.entries)
          const stored = captureCapabilityNotices(streaming.sessionId, entries).at(-1)
          if (stored) latest.current.onCapabilityNotice?.(taskId, stored)
          return
        }
        if (projectionUpdate.key === 'xiaoyin.transcript') {
          const lastSeq = streaming.projectionSeqByKey?.['xiaoyin.transcript'] ?? -1
          if (projectionUpdate.seq <= lastSeq) return
          // The wire view carries only the current turn: settled text, tool
          // cards, approvals and questions in event order.
          const turn = parseAssistantTurn((projectionUpdate.value as { turn?: unknown })?.turn)
          if (turn) {
            streaming.projectionSeqByKey = { ...streaming.projectionSeqByKey, 'xiaoyin.transcript': projectionUpdate.seq }
            streaming.entries = mergeSettledTurn(streaming.entries, turn)
            latest.current.onTaskUpdate(taskId, streaming.projection, streaming.entries)
            if (currentTaskIdRef.current === taskId) latest.current.onCurrentUpdate(streaming.projection, streaming.entries)
          }
          return
        }
        const lastSeq = projectionUpdate.key === 'xiaoyin.task' ? streaming.projectionSeq ?? -1 : streaming.projectionSeqByKey?.[projectionUpdate.key] ?? -1
        if (projectionUpdate.seq <= lastSeq) return
        const projected = projectionForKey(streaming.projection, projectionUpdate.key, projectionUpdate.value)
        if (!projected) return
        streaming.projectionSeqByKey = { ...streaming.projectionSeqByKey, [projectionUpdate.key]: projectionUpdate.seq }
        if (projectionUpdate.key === 'xiaoyin.task') streaming.projectionSeq = projectionUpdate.seq
        const nextProjection = streaming.cancellationRequested && projectionUpdate.key === 'xiaoyin.task'
          ? mergeStoppingProjection(streaming.projection, projected)
          : streaming.projection.retry && projected.status === 'running'
            ? { ...projected, retry: streaming.projection.retry }
            : projected
        streaming.projection = nextProjection
        latest.current.onTaskUpdate(taskId, nextProjection, streaming.entries)
        if (currentTaskIdRef.current === taskId) latest.current.onCurrentUpdate(nextProjection)
        return
      }
      // Live overlay: raw root-session events keep the open text segment
      // typing between `assistant/message` settlements.
      const live = harnessLiveEvent(notification)
      if (!live) return
      const entries = applyLiveEvent(streaming.entries, live)
      if (entries === streaming.entries) return
      streaming.entries = entries
      latest.current.onTaskUpdate(taskId, streaming.projection, streaming.entries)
      if (currentTaskIdRef.current === taskId) latest.current.onCurrentUpdate(streaming.projection, streaming.entries)
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
    else merged[index] = { ...merged[index]!, ...item }
  }
  return merged
}

function mergeByKey<T>(left: T[], right: T[], keyOf: (item: T) => string): T[] {
  const merged = [...left]
  for (const item of right) {
    const key = keyOf(item)
    const index = merged.findIndex((candidate) => keyOf(candidate) === key)
    if (index < 0) merged.push(item)
    else merged[index] = { ...merged[index]!, ...item }
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
