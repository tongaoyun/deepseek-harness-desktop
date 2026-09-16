import type { AssistantTurn, ConversationEntry, TurnMeta, TurnSegment, UserTurn } from './types'
import type { LocalTaskAttachment } from '../types'

/** Test fixtures for the transcript model. Not imported by application code. */

export function userEntry(id: string, text: string, attachments?: LocalTaskAttachment[]): UserTurn {
  return { id, role: 'user', text, ...(attachments?.length ? { attachments } : {}) }
}

export function assistantEntry(id: string, segments: TurnSegment[] | string, meta: TurnMeta = {}, status: AssistantTurn['status'] = 'completed'): AssistantTurn {
  const resolved = typeof segments === 'string'
    ? (segments ? [{ kind: 'text' as const, id: `${id}:1`, text: segments }] : [])
    : segments
  return { id, role: 'assistant', status, segments: resolved, meta }
}

export function toolSegment(id: string, toolName: string, overrides: Partial<Extract<TurnSegment, { kind: 'tool' }>> = {}): Extract<TurnSegment, { kind: 'tool' }> {
  return { kind: 'tool', id: `tool:${id}`, toolName, status: 'completed', startedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:00:01.000Z', label: toolName, ...overrides }
}

/** Render an assistant turn's visible text the way the UI does. */
export function entryText(entry: ConversationEntry | undefined): string {
  if (!entry || entry.role === 'user') return entry?.text ?? ''
  return entry.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('')
}

export function lastEntryText(entries: ConversationEntry[]): string {
  return entryText(entries.at(-1))
}
