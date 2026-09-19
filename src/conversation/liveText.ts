import type { TaskQuestionAnswer, TaskQuestionItem } from '../types'
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
  if (event.type === 'assistant/message') {
    const settled = messageText(event.data)
    return updateOpenTurn(entries, `turn:${turn}`, (open) => ({
      ...open,
      segments: settleText(open.segments, `${turn}:${step}`, settled),
    }))
  }
  if (event.type === 'tool/call') {
    const callId = text(event.data.callId)
    const toolName = text(event.data.name)
    if (!callId || !toolName) return entries
    return updateOpenTurn(entries, `turn:${turn}`, (open) => open.segments.some((segment) => segment.id === `tool:${callId}`)
      ? open
      : { ...open, segments: [...open.segments, {
        kind: 'tool', id: `tool:${callId}`, toolName, label: liveToolLabel(toolName), status: 'running', startedAt: time,
      }] })
  }
  if (event.type === 'tool/result') {
    const content = record(event.data.message)?.content
    if (!Array.isArray(content)) return entries
    return updateOpenTurn(entries, `turn:${turn}`, (open) => ({ ...open, segments: open.segments.map((segment) => {
      if (segment.kind !== 'tool') return segment
      const result = content.map(record).find((block) => block?.type === 'tool-result' && `tool:${block.toolCallId}` === segment.id)
      if (!result) return segment
      return { ...segment, status: result.isError === true || Boolean(event.data.error) ? 'failed' : 'completed', completedAt: time }
    }) }))
  }
  if (event.type === 'approval/request') {
    const approvalId = text(event.data.approvalId)
    const toolName = text(event.data.name)
    if (!approvalId || !toolName) return entries
    return updateCurrentTurn(entries, (open) => ({ ...open, segments: [...open.segments, {
      kind: 'approval', id: `approval:${approvalId}`, approvalId, toolName,
      label: `需要确认：${toolName}`, status: 'running',
      ...(text(event.data.reason) ? { detail: text(event.data.reason)!.slice(0, 2_000) } : {}),
    }] }))
  }
  if (event.type === 'approval/decision') {
    const approvalId = text(event.data.approvalId)
    const decision = text(event.data.decision)
    if (!approvalId || !['allow', 'reject'].includes(decision ?? '')) return entries
    return updateCurrentTurn(entries, (open) => ({ ...open, segments: open.segments.map((segment) =>
      segment.kind === 'approval' && segment.approvalId === approvalId
        ? { ...segment, status: decision === 'allow' ? 'completed' as const : 'failed' as const,
          label: `${decision === 'allow' ? '已允许' : '已拒绝'}：${segment.toolName}` }
        : segment) }))
  }
  if (event.type === 'question/request') {
    const questionId = text(event.data.questionId)
    const questions = liveQuestions(event.data.questions)
    if (!questionId || !questions.length) return entries
    return updateCurrentTurn(entries, (open) => open.segments.some((segment) => segment.kind === 'question' && segment.questionId === questionId)
      ? open
      : { ...open, segments: [...open.segments, {
        kind: 'question', id: `question:${questionId}`, questionId, label: '需要你的回答', questions, status: 'running',
      }] })
  }
  if (event.type === 'question/answered') {
    const questionId = text(event.data.questionId)
    if (!questionId) return entries
    const answers = liveAnswers(event.data.answers)
    return updateCurrentTurn(entries, (open) => ({ ...open, segments: open.segments.map((segment) =>
      segment.kind === 'question' && segment.questionId === questionId
        ? { ...segment, status: 'completed' as const, ...(answers.length ? { answers } : {}) } : segment) }))
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
  if (index < 0) {
    const last = entries.at(-1)
    if (last?.role === 'assistant' && last.id === 'pending' && last.status === 'streaming') {
      return [...entries.slice(0, -1), withEarlierStart(settled, last)]
    }
    return [...entries, settled]
  }
  const current = entries[index]
  if (current.role !== 'assistant') return entries
  // The employee sees the turn start when they sent it; the harness starts a
  // few seconds later. Keep the earlier stamp so the clock never jumps back.
  const merged = withEarlierStart(settled, current)
  const ahead = current.segments.filter((segment) => isStreamingText(segment) || segment.kind === 'notice' || segment.kind === 'user'
    || segment.kind === 'approval' && segment.status === 'running' || segment.kind === 'question')
  // A streaming overlay segment may have text beyond the settled value; keep
  // the longer text until its own assistant/message settles it.
  if (!ahead.length) return entries.map((entry, position) => position === index ? merged : entry)
  const segments: TurnSegment[] = merged.segments.map((segment) => {
    const overlay = ahead.find((item) => item.id === segment.id)
    if (segment.kind === 'approval' && segment.status === 'running') {
      return ahead.find((item) => item.kind === 'approval' && item.toolName === segment.toolName) ?? segment
    }
    if (segment.kind === 'question') {
      return ahead.find((item) => item.kind === 'question' && item.questionId === segment.questionId) ?? segment
    }
    if (!overlay || segment.kind !== 'text') return segment
    return overlay.kind === 'text' && overlay.text.length > segment.text.length ? overlay : segment
  })
  for (const item of ahead) {
    if (segments.some((segment) => segment.id === item.id
      || item.kind === 'approval' && segment.kind === 'approval' && segment.toolName === item.toolName
      || item.kind === 'question' && segment.kind === 'question' && segment.questionId === item.questionId)) continue
    const position = current.segments.indexOf(item)
    const next = current.segments.slice(position + 1).find((candidate) => segments.some((segment) => segment.id === candidate.id))
    if (next) segments.splice(segments.findIndex((segment) => segment.id === next.id), 0, item)
    else segments.push(item)
  }
  return entries.map((entry, position) => position === index ? { ...merged, segments } : entry)
}

function withEarlierStart(settled: AssistantTurn, current: AssistantTurn): AssistantTurn {
  const settledAt = settled.meta.startedAt
  const currentAt = current.meta.startedAt
  if (!currentAt || (settledAt && Date.parse(settledAt) <= Date.parse(currentAt))) return settled
  return { ...settled, meta: { ...settled.meta, startedAt: currentAt } }
}

function liveAnswers(value: unknown): TaskQuestionAnswer[] {
  if (!Array.isArray(value) || value.length > 3) return []
  return value.flatMap((raw) => {
    const answer = record(raw)
    const id = text(answer?.id)
    if (!id || !Array.isArray(answer?.selected) || answer.selected.some((item) => typeof item !== 'string')) return []
    const selected = (answer.selected as string[]).slice(0, 12).map((item) => item.slice(0, 200))
    const custom = text(answer.custom)?.slice(0, 16_000)
    return [{ id, selected, ...(custom ? { custom } : {}) }]
  })
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
  const id = boundedNoticeText(`notice:${notice.kind}:${notice.name}`, 200, 200)
  if (last.segments.some((segment) => segment.id === id)) return entries
  const label = notice.kind === 'connector' ? '连接器' : notice.kind === 'knowledge' ? '知识库' : '能力'
  return [...entries.slice(0, -1), {
    ...last,
    segments: [...last.segments, { kind: 'notice', id, level: 'warning', text: boundedNoticeText(`本轮未使用${label}「${notice.name}」：${notice.reason}`, 2_000, 6_000) }],
  }]
}

function boundedNoticeText(value: string, maxCharacters: number, maxBytes: number): string {
  const encoder = new TextEncoder()
  let result = ''
  let bytes = 0
  for (const character of value) {
    const size = encoder.encode(character).length
    if (result.length + character.length > maxCharacters || bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
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
  if (last?.role === 'assistant' && last.id === id) return entries
  if (last?.role === 'assistant' && last.status === 'streaming' && last.id === 'pending') {
    // First real turn of a newly started run replaces the placeholder.
    return [...entries.slice(0, -1), { id, role: 'assistant', status: 'streaming', segments: last.segments, meta: { ...last.meta, startedAt: last.meta.startedAt ?? time } }]
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

// Native interaction notifications are tied to the running task, not a Harness turn number.
function updateCurrentTurn(entries: ConversationEntry[], change: (turn: AssistantTurn) => AssistantTurn): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant' || last.status !== 'streaming') return entries
  return [...entries.slice(0, -1), change(last)]
}

function settleOpenTurn(entries: ConversationEntry[], status: AssistantTurn['status'], time: string, reasonKind: string): ConversationEntry[] {
  const last = entries.at(-1)
  if (last?.role !== 'assistant' || last.status !== 'streaming') return entries
  const failure = status === 'failed' ? { kind: reasonKind, message: '' } : undefined
  return [...entries.slice(0, -1), { ...last, status, segments: last.segments.map((segment) => segment.kind === 'tool' && segment.status === 'running'
    ? { ...segment, status: status === 'completed' ? 'completed' as const : 'canceled' as const, completedAt: time }
    : segment.kind === 'approval' && segment.status === 'running'
      ? { ...segment, status: 'failed' as const, label: `已结束：${segment.toolName}` }
      : segment), meta: { ...last.meta, completedAt: time, ...(failure ? { failure } : {}) } }]
}

function liveToolLabel(name: string): string {
  const labels: Record<string, string> = {
    local_files_roots: '检查可用工作目录', local_files_list: '查看目录', local_files_read_text: '读取文件',
    local_files_search: '搜索文件', local_files_publish: '准备交付文件', local_files_write_text: '写入文件',
    office_document_read: '读取 Office 文档', office_document_check: '检查文档结构',
    office_xlsx_create: '生成表格', task_report: '整理交付结果', knowledge_search: '检索企业知识库',
  }
  return labels[name] ?? name
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

function liveQuestions(value: unknown): TaskQuestionItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return []
  const questions = value.map((item) => {
    const raw = record(item)
    const id = text(raw?.id)
    const question = text(raw?.question)
    if (!id || !question) return undefined
    const options = Array.isArray(raw?.options) ? raw.options.map((option) => {
      const item = record(option)
      const label = text(item?.label)
      return label ? { label, ...(text(item?.description) ? { description: text(item?.description) } : {}) } : undefined
    }) : undefined
    if (options?.some((option) => !option)) return undefined
    const intent = record(raw?.intent)
    return {
      id, question,
      ...(text(raw?.header) ? { header: text(raw?.header) } : {}),
      ...(text(raw?.detail) ? { detail: text(raw?.detail) } : {}),
      ...(options ? { options: options as NonNullable<TaskQuestionItem['options']> } : {}),
      ...(raw?.multiSelect === true ? { multiSelect: true } : {}),
      ...(intent?.kind === 'plan-review' && text(intent.approve)
        ? { intent: { kind: 'plan-review' as const, approve: text(intent.approve)! } } : {}),
    }
  })
  return questions.every(Boolean) ? questions as TaskQuestionItem[] : []
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
