import type { ConversationEntry, TurnMeta, TurnStatus, UserTurn } from './types'

/** Keep a mid-turn employee message inside the turn that is still running. */
export function appendSteerToOpenTurn(entries: ConversationEntry[], message: UserTurn): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant' || last.status !== 'streaming') return [...entries, message]
  return [...entries.slice(0, -1), { ...last, segments: [...last.segments, { kind: 'user' as const, id: message.id, text: message.text }] }]
}

/** Normalize a steer message into the assistant turn that is still open. */
export function reconcileTaskConversation(entries: ConversationEntry[], status: TurnStatus | 'running' | 'idle', completedAt?: string): ConversationEntry[] {
  const normalized: ConversationEntry[] = []
  for (const entry of entries) {
    if (entry.role === 'user' && entry.source === 'steer' && normalized.at(-1)?.role === 'assistant') {
      const previous = normalized.pop()!
      normalized.push(previous.role === 'assistant'
        ? { ...previous, segments: [...previous.segments, { kind: 'user', id: entry.id, text: entry.text }] }
        : previous)
    } else normalized.push(entry)
  }
  return status === 'completed' || status === 'canceled' || status === 'failed'
    ? settleOpenTurn(normalized, status, completedAt ?? new Date().toISOString())
    : normalized
}

/** Settle the open assistant turn with facts from the official turn lifecycle. */
export function settleOpenTurn(
  entries: ConversationEntry[],
  status: TurnStatus,
  completedAt: string,
  meta: Partial<TurnMeta> = {},
): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant' || last.status !== 'streaming') return entries
  return [...entries.slice(0, -1), {
    ...last,
    status,
    segments: last.segments.map((segment) => (segment.kind === 'tool' || segment.kind === 'status') && segment.status === 'running'
      ? { ...segment, status: status === 'completed' ? 'completed' as const : 'canceled' as const, completedAt }
      : segment),
    meta: { ...last.meta, ...meta, completedAt },
  }]
}

/**
 * Guarantee the settled turn carries final visible text even if live events
 * never delivered it (mocked harness, a silent provider that only returns the
 * run result). Prefers existing streamed text; falls back to the final response.
 */
export function ensureFinalText(entries: ConversationEntry[], finalResponse: string): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant') return entries
  if (last.segments.some((segment) => segment.kind === 'text' && segment.text.trim())) return entries
  if (!finalResponse.trim()) return entries
  return [...entries.slice(0, -1), { ...last, segments: [...last.segments, { kind: 'text' as const, id: `final:${last.id}`, text: finalResponse }] }]
}

/**
 * A retried turn runs in a rebuilt session, so its identity and segments
 * restart: keep the user turn, reset the assistant turn to a placeholder.
 */
export function resetOpenTurn(entries: ConversationEntry[], now: string): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant') return entries
  return [...entries.slice(0, -1), { id: 'pending', role: 'assistant' as const, status: 'streaming' as const, segments: [], meta: { ...last.meta, startedAt: last.meta.startedAt ?? now } }]
}
