import type { ConversationEntry } from '../conversation/types'

/** Running status covers the submitted message, even across Harness turns. */
export function activeRunStartedAt(entries: ConversationEntry[], index: number): string | undefined {
  let startedAt: string | undefined
  for (let position = index; position >= 0; position--) {
    const entry = entries[position]!
    if (entry.role === 'user' && entry.source !== 'steer') break
    if (entry.role !== 'assistant' || !entry.meta.startedAt) continue
    if (!startedAt || Date.parse(entry.meta.startedAt) < Date.parse(startedAt)) startedAt = entry.meta.startedAt
  }
  return startedAt
}
