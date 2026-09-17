import type { AssistantTurn, ConversationEntry, TurnSegment } from './types'

/**
 * Live transcript overlay. `text-chunks` never reaches the durable session
 * log, so the projection settles text only at `assistant/message` boundaries.
 * These reducers keep the open segment typing between boundaries; the settled
 * projection value wins wherever it has caught up.
 */

export function applyLiveEvent(entries: ConversationEntry[], event: { type: string; data: Record<string, unknown> }): ConversationEntry[] {
  const turn = number(event.data.turn) ?? 0
  const step = number(event.data.step) ?? 0
  const time = new Date().toISOString()

  if (event.type === 'turn/start') return withOpenTurn(entries, `turn:${turn}`, time)
  if (event.type === 'text-chunks') {
    const delta = texts(event.data.texts)
    if (!delta) return entries
    return updateOpenTurn(entries, `turn:${turn}`, (open) => ({
      ...open,
      segments: appendText(open.segments, `${turn}:${step}`, delta),
    }))
  }
  if (event.type === 'reasoning-chunks') {
    const delta = texts(event.data.texts)
    if (!delta) return entries
    return updateOpenTurn(entries, `turn:${turn}`, (open) => ({
      ...open,
      segments: appendThinking(open.segments, `${turn}:${step}:thinking`, delta),
    }))
  }
  if (event.type === 'assistant/stream') {
    const chunk = record(event.data.chunk)
    if (chunk?.type !== 'reasoning-delta') return entries
    const delta = text(chunk.text)
    if (!delta) return entries
    return updateOpenTurn(entries, `turn:${turn}`, (open) => ({
      ...open,
      segments: appendThinking(open.segments, `${turn}:${step}:thinking`, delta),
    }))
  }
  if (event.type === 'assistant/message') {
    const settled = messageText(event.data)
    return updateOpenTurn(entries, `turn:${turn}`, (open) => ({
      ...open,
      segments: settleText(open.segments, `${turn}:${step}`, settled),
    }))
  }
  if (event.type === 'turn/end') {
    const reason = record(event.data.reason)
    const kind = text(reason?.kind) ?? 'unknown'
    const status = kind === 'completed' ? 'completed' : kind === 'aborted' ? 'canceled' : 'failed'
    return settleOpenTurn(entries, status, time, kind)
  }
  return entries
}

/** Keep the local streaming overlay when the settled projection lags behind it. */
export function mergeSettledTurn(entries: ConversationEntry[], settled: AssistantTurn): ConversationEntry[] {
  const index = entries.findIndex((entry) => entry.role === 'assistant' && entry.id === settled.id)
  if (index < 0) return [...entries, settled]
  const current = entries[index]
  if (current.role !== 'assistant') return entries
  // The employee sees the turn start when they sent it; the harness starts a
  // few seconds later. Keep the earlier stamp so the clock never jumps back.
  const merged = withEarlierStart(settled, current)
  const ahead = current.segments.filter(isStreamingText)
  // A streaming overlay segment may have text beyond the settled value; keep
  // the longer text until its own assistant/message settles it.
  if (!ahead.length) return entries.map((entry, position) => position === index ? merged : entry)
  const segments: TurnSegment[] = merged.segments.map((segment) => {
    const overlay = ahead.find((item) => item.id === segment.id)
    if (!overlay || segment.kind !== 'text') return segment
    return overlay.text.length > segment.text.length ? overlay : segment
  }).concat(ahead.filter((item) => !settled.segments.some((segment) => segment.id === item.id)))
  return entries.map((entry, position) => position === index ? { ...merged, segments } : entry)
}

function withEarlierStart(settled: AssistantTurn, current: AssistantTurn): AssistantTurn {
  const settledAt = settled.meta.startedAt
  const currentAt = current.meta.startedAt
  if (!currentAt || (settledAt && Date.parse(settledAt) <= Date.parse(currentAt))) return settled
  return { ...settled, meta: { ...settled.meta, startedAt: currentAt } }
}

function isStreamingText(segment: TurnSegment): segment is Extract<TurnSegment, { kind: 'text' }> {
  return segment.kind === 'text' && segment.streaming === true
}

function appendText(segments: TurnSegment[], id: string, delta: string): TurnSegment[] {
  const index = segments.findIndex((segment) => segment.kind === 'text' && segment.id === id)
  if (index < 0) return [...segments, { kind: 'text', id, text: delta, streaming: true }]
  return segments.map((segment, position) => position === index && segment.kind === 'text'
    ? { ...segment, text: segment.text + delta, streaming: true }
    : segment)
}

/** A capability the runtime could not provide rides the open turn as a notice. */
export function appendCapabilityNotice(entries: ConversationEntry[], notice: { kind: string; name: string; reason: string }): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant') return entries
  const id = `notice:${notice.kind}:${notice.name}`
  if (last.segments.some((segment) => segment.id === id)) return entries
  const label = notice.kind === 'connector' ? '连接器' : notice.kind === 'knowledge' ? '知识库' : '能力'
  return [...entries.slice(0, -1), {
    ...last,
    segments: [...last.segments, { kind: 'notice', id, level: 'warning', text: `本轮未使用${label}「${notice.name}」：${notice.reason}` }],
  }]
}

function appendThinking(segments: TurnSegment[], id: string, delta: string): TurnSegment[] {
  const index = segments.findIndex((segment) => segment.kind === 'thinking' && segment.id === id)
  if (index < 0) return [...segments, { kind: 'thinking', id, text: delta, streaming: true }]
  return segments.map((segment, position) => position === index && segment.kind === 'thinking'
    ? { ...segment, text: segment.text + delta, streaming: true }
    : segment)
}

function settleText(segments: TurnSegment[], id: string, settled: string): TurnSegment[] {
  const exact = segments.findIndex((segment) => segment.kind === 'text' && segment.id === id)
  // A settled message without step identity belongs to the segment still
  // streaming; settling it there keeps the text from appearing twice.
  const index = exact >= 0 ? exact : segments.findLastIndex((segment) => segment.kind === 'text' && segment.streaming)
  if (index < 0) return settled.trim() ? [...segments, { kind: 'text', id, text: settled }] : segments
  return segments.map((segment, position) => position === index && segment.kind === 'text'
    ? { ...segment, text: settled, streaming: false }
    : segment)
}

function withOpenTurn(entries: ConversationEntry[], id: string, time: string): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role === 'assistant' && last.id === id && last.status === 'streaming') return entries
  if (last?.role === 'assistant' && last.status === 'streaming' && last.id === 'pending') {
    // First real turn of a newly started run replaces the placeholder.
    return [...entries.slice(0, -1), { id, role: 'assistant', status: 'streaming', segments: last.segments, meta: { ...last.meta, startedAt: time } }]
  }
  return [...entries, { id, role: 'assistant', status: 'streaming', segments: [], meta: { startedAt: time } }]
}

function updateOpenTurn(entries: ConversationEntry[], id: string, change: (turn: AssistantTurn) => AssistantTurn): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant' || last.status !== 'streaming') return entries
  // A placeholder turn adopts the first real turn identity if events race ahead.
  if (last.id === 'pending') return [...entries.slice(0, -1), change({ ...last, id })]
  if (last.id !== id) return entries
  return [...entries.slice(0, -1), change(last)]
}

function settleOpenTurn(entries: ConversationEntry[], status: AssistantTurn['status'], time: string, reasonKind: string): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant' || last.status !== 'streaming') return entries
  const failure = status === 'failed' ? { kind: reasonKind, message: '' } : undefined
  return [...entries.slice(0, -1), { ...last, status, meta: { ...last.meta, completedAt: time, ...(failure ? { failure } : {}) } }]
}

function texts(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join('') : ''
}

function messageText(data: Record<string, unknown>): string {
  const content = record(data.message)?.content
  if (!Array.isArray(content)) return ''
  // Reasoning blocks also carry `text`; only visible text belongs in the reply.
  return content.map((block) => {
    const value = record(block)
    return value?.type === 'text' ? text(value.text) ?? '' : ''
  }).join('')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}
