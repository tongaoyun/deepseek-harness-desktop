import type { LocalTaskAttachment, TaskQuestionAnswer, TaskQuestionItem } from '../types'
import type { ReasoningEffort } from '../modelReasoning'

/**
 * Product-owned input and queue metadata. The official Harness Session Log,
 * not these records, is the source for conversation rendering and replay.
 */

export interface UserTurn {
  id: string
  role: 'user'
  text: string
  attachments?: LocalTaskAttachment[]
  /** 'steer' marks a message injected into a running turn. */
  source?: 'desktop' | 'dingtalk' | 'schedule' | 'steer'
  /** Context this turn ran with, so the transcript can show what was in play. */
  context?: { knowledgeRefs?: string[]; connectors?: Array<{ id: string; name: string }> }
}

export interface TurnFailure {
  kind: string
  message: string
}

export type TurnStatus = 'streaming' | 'completed' | 'failed' | 'canceled'

export interface TurnTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface TurnMeta {
  model?: string
  reasoningEffort?: ReasoningEffort
  startedAt?: string
  completedAt?: string
  failure?: TurnFailure
  tokenUsage?: TurnTokenUsage
}

export type TextSegment = { kind: 'text'; id: string; text: string; streaming?: boolean }
/** A public progress update emitted before the next action. Never private chain-of-thought. */
export type CommentarySegment = { kind: 'commentary'; id: string; text: string; streaming?: boolean }
/** The model's private reasoning for one step. Collapsed by default in the UI. */
export type ThinkingSegment = { kind: 'thinking'; id: string; text: string; streaming?: boolean }
export type UserSegment = { kind: 'user'; id: string; text: string }
export type StatusSegment = {
  kind: 'status'
  id: string
  statusKind: 'compaction'
  label: string
  status: 'running' | 'completed' | 'failed' | 'canceled'
  startedAt: string
  completedAt?: string
}
export type ToolSegment = {
  kind: 'tool'
  id: string
  toolName: string
  status: 'running' | 'completed' | 'failed' | 'canceled'
  startedAt: string
  completedAt?: string
  label: string
  detail?: string
  command?: string
  path?: string
  secondaryPath?: string
  itemCount?: number
  output?: string
}
export type ApprovalSegment = {
  kind: 'approval'
  id: string
  approvalId: string
  toolName: string
  label: string
  status: 'running' | 'completed' | 'failed'
  detail?: string
}
export type QuestionSegment = {
  kind: 'question'
  id: string
  questionId: string
  label: string
  questions: TaskQuestionItem[]
  status: 'running' | 'completed'
  answers?: TaskQuestionAnswer[]
}

/** Something the employee should know about this turn, e.g. a capability gap. */
export type NoticeSegment = { kind: 'notice'; id: string; level: 'warning' | 'error'; text: string }

export type TurnSegment = TextSegment | CommentarySegment | ThinkingSegment | UserSegment | StatusSegment | ToolSegment | ApprovalSegment | QuestionSegment | NoticeSegment

export interface AssistantTurn {
  id: string
  role: 'assistant'
  status: TurnStatus
  segments: TurnSegment[]
  meta: TurnMeta
}

export type ConversationEntry = UserTurn | AssistantTurn

export const isAssistantTurn = (entry: ConversationEntry): entry is AssistantTurn => entry.role === 'assistant'
export const isUserTurn = (entry: ConversationEntry): entry is UserTurn => entry.role === 'user'

/** Loose validation for a projection/wire value before it enters local state. */
export function parseAssistantTurn(value: unknown): AssistantTurn | undefined {
  const turn = value as Partial<AssistantTurn> | undefined
  if (!turn || turn.role !== 'assistant' || typeof turn.id !== 'string' || !Array.isArray(turn.segments)) return undefined
  const status = ['streaming', 'completed', 'failed', 'canceled'].includes(String(turn.status)) ? turn.status as TurnStatus : 'streaming'
  return { id: turn.id, role: 'assistant', status, segments: turn.segments as TurnSegment[], meta: turn.meta ?? {} }
}

/** Merge a wire transcript turn into an entries array: replace by id, append when new. */
export function mergeAssistantTurn(entries: ConversationEntry[], turn: AssistantTurn): ConversationEntry[] {
  const index = entries.findIndex((entry) => entry.role === 'assistant' && entry.id === turn.id)
  if (index < 0) {
    // Keep user turns above the assistant turn they drive; the wire carries
    // only the assistant turn, so append at the end.
    return [...entries, turn]
  }
  return entries.map((entry, current) => current === index ? turn : entry)
}

/** The visible text of a turn: settled text segments plus the open streaming tail. */
export function turnText(turn: AssistantTurn): string {
  return turn.segments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('')
}
