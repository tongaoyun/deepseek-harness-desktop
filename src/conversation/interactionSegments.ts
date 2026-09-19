import type { ConversationEntry, QuestionSegment, UserSegment } from './types'

export interface StoredInteractionSegment {
  sessionId: string
  turnId: string
  afterTurnId?: string
  index: number
  segment: QuestionSegment | UserSegment
}

/** Desktop interactions are not events in the durable Harness transcript. */
export function captureInteractionSegments(sessionId: string | undefined, entries: ConversationEntry[], saved: StoredInteractionSegment[] = []): StoredInteractionSegment[] {
  if (!sessionId) return []
  const items = new Map<string, StoredInteractionSegment>()
  for (const item of saved) if (item.sessionId === sessionId && validInteraction(item)) items.set(key(item), item)
  let previousTurnId: string | undefined
  for (const entry of entries) {
    if (entry.role !== 'assistant') continue
    entry.segments.forEach((segment, index) => {
      if (segment.kind !== 'question' && segment.kind !== 'user') return
      const item: StoredInteractionSegment = { sessionId, turnId: entry.id, index, segment,
        ...(entry.id === 'pending' && previousTurnId ? { afterTurnId: previousTurnId } : {}) }
      if (validInteraction(item)) items.set(key(item), item)
    })
    if (entry.id !== 'pending') previousTurnId = entry.id
  }
  return [...items.values()].slice(-100)
}

export function restoreInteractionSegments(sessionId: string | undefined, entries: ConversationEntry[], saved: StoredInteractionSegment[] = []): ConversationEntry[] {
  if (!sessionId || !saved.length) return entries
  const byTurn = new Map<string, Map<string, StoredInteractionSegment>>()
  for (const item of saved) {
    if (item.sessionId !== sessionId || !validInteraction(item)) continue
    const preceding = item.afterTurnId ? entries.findIndex((entry) => entry.role === 'assistant' && entry.id === item.afterTurnId) : -1
    const turnId = item.turnId === 'pending'
      ? entries.slice(preceding + 1).find((entry) => entry.role === 'assistant')?.id
      : item.turnId
    if (!turnId) continue
    const segments = byTurn.get(turnId) ?? new Map<string, StoredInteractionSegment>()
    segments.set(item.segment.id, item)
    byTurn.set(turnId, segments)
  }
  return entries.map((entry) => {
    if (entry.role !== 'assistant') return entry
    const additions = [...(byTurn.get(entry.id)?.values() ?? [])].sort((left, right) => left.index - right.index)
    if (!additions?.length) return entry
    const segments = [...entry.segments]
    for (const item of additions) {
      if (segments.some((segment) => segment.id === item.segment.id)) continue
      segments.splice(Math.min(item.index, segments.length), 0, item.segment)
    }
    return segments.length === entry.segments.length ? entry : { ...entry, segments }
  })
}

function key(item: StoredInteractionSegment): string {
  return JSON.stringify([item.turnId, item.afterTurnId, item.segment.id])
}

function validInteraction(item: StoredInteractionSegment): boolean {
  if (typeof item.sessionId !== 'string' || item.sessionId.length > 256
    || typeof item.turnId !== 'string' || item.turnId.length > 200
    || item.afterTurnId !== undefined && (typeof item.afterTurnId !== 'string' || item.afterTurnId.length > 200)
    || !Number.isSafeInteger(item.index) || item.index < 0 || item.index > 1000) return false
  const segment = item.segment
  if (typeof segment?.id !== 'string' || segment.id.length > 200) return false
  if (segment.kind === 'user') return typeof segment.text === 'string' && segment.text.length <= 16_000
  return segment.kind === 'question' && typeof segment.questionId === 'string' && segment.questionId.length <= 200
    && Array.isArray(segment.questions) && segment.questions.length > 0 && segment.questions.length <= 3
}
