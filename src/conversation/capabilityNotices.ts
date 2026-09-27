import type { AssistantTurn, ConversationEntry, NoticeSegment } from './types'

export interface StoredCapabilityNotice {
  sessionId: string
  turnId: string
  /** The placeholder is replaced by the next official turn after this one. */
  afterTurnId?: string
  segment: NoticeSegment
}

/** The product owns these small notices; Harness owns the transcript itself. */
export function captureCapabilityNotices(sessionId: string | undefined, entries: ConversationEntry[], saved: StoredCapabilityNotice[] = []): StoredCapabilityNotice[] {
  if (!sessionId) return []
  const notices = new Map<string, StoredCapabilityNotice>()
  for (const item of saved) {
    if (item.sessionId !== sessionId || !validNotice(item)) continue
    notices.set(JSON.stringify([item.turnId, item.afterTurnId, item.segment.id]), item)
  }
  let previousTurnId: string | undefined
  for (const entry of entries) {
    if (entry.role !== 'assistant') continue
    for (const segment of entry.segments) {
      if (segment.kind !== 'notice') continue
      const item: StoredCapabilityNotice = { sessionId, turnId: entry.id,
        ...(entry.id === 'pending' && previousTurnId ? { afterTurnId: previousTurnId } : {}),
        segment: { ...segment, text: segment.text.slice(0, 2_000) } }
      if (validNotice(item)) notices.set(JSON.stringify([item.turnId, item.afterTurnId, item.segment.id]), item)
    }
    if (entry.id !== 'pending') previousTurnId = entry.id
  }
  return [...notices.values()].slice(-100)
}

export function restoreCapabilityNotices(sessionId: string | undefined, entries: ConversationEntry[], saved: StoredCapabilityNotice[] = [], missingTurnStatus?: AssistantTurn['status']): ConversationEntry[] {
  if (!sessionId || !saved.length) return entries
  const byTurn = new Map<string, Map<string, NoticeSegment>>()
  const missingTurn = new Map<string, NoticeSegment>()
  for (const item of saved) {
    if (item.sessionId !== sessionId || !validNotice(item)) continue
    let turnId = item.turnId
    if (turnId === 'pending') {
      const preceding = item.afterTurnId ? entries.findIndex((entry) => entry.role === 'assistant' && entry.id === item.afterTurnId) : -1
      const next = entries.slice(preceding + 1).find((entry) => entry.role === 'assistant')
      if (!next) {
        if (missingTurnStatus && entries.at(-1)?.role === 'user' && (!item.afterTurnId || preceding >= 0)) {
          missingTurn.set(item.segment.id, item.segment)
        }
        continue
      }
      turnId = next.id
    }
    const notices = byTurn.get(turnId) ?? new Map<string, NoticeSegment>()
    notices.set(item.segment.id, item.segment)
    byTurn.set(turnId, notices)
  }
  const restored = entries.map((entry) => {
    if (entry.role !== 'assistant') return entry
    const notices = [...(byTurn.get(entry.id)?.values() ?? [])].filter((notice) => !entry.segments.some((segment) => segment.id === notice.id))
    return notices.length ? { ...entry, segments: [...notices, ...entry.segments] } : entry
  })
  return missingTurnStatus && missingTurn.size
    ? [...restored, { id: 'pending', role: 'assistant', status: missingTurnStatus, segments: [...missingTurn.values()], meta: {} }]
    : restored
}

function validNotice(item: StoredCapabilityNotice): boolean {
  return typeof item.sessionId === 'string' && item.sessionId.length <= 256
    && typeof item.turnId === 'string' && item.turnId.length <= 200
    && (item.afterTurnId === undefined || (typeof item.afterTurnId === 'string' && item.afterTurnId.length <= 200))
    && item.segment?.kind === 'notice' && ['warning', 'error'].includes(item.segment.level)
    && typeof item.segment.id === 'string' && item.segment.id.length <= 200
    && typeof item.segment.text === 'string' && item.segment.text.length <= 2_000
}

export function appendStoredCapabilityNotice(saved: StoredCapabilityNotice[], notice: StoredCapabilityNotice): StoredCapabilityNotice[] {
  if (!validNotice(notice)) throw new Error('能力告警格式无效')
  return [...saved.filter((item) => validNotice(item) && item.sessionId === notice.sessionId
    && !(item.turnId === notice.turnId && item.afterTurnId === notice.afterTurnId && item.segment.id === notice.segment.id)), notice].slice(-100)
}

/** Product-only capability warning; the official Conversation owns all turns and tool cards. */
export function appendCapabilityNotice(entries: ConversationEntry[], notice: { kind: string; name: string; reason: string }): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant') return entries
  const id = `notice:${notice.kind}:${notice.name}`.slice(0, 200)
  if (last.segments.some((segment) => segment.id === id)) return entries
  const label = notice.kind === 'connector' ? '连接器' : notice.kind === 'knowledge' ? '知识库' : '能力'
  return [...entries.slice(0, -1), {
    ...last,
    segments: [...last.segments, { kind: 'notice', id, level: 'warning', text: `本轮未使用${label}「${notice.name}」：${notice.reason}`.slice(0, 2_000) }],
  }]
}
