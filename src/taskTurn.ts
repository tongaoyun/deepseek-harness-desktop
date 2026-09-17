import { splitComposerPrompt } from './composerInput'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import type { ExtensionInvocation } from './extensionInvocations'
import { resolveHarnessSessionId } from './harnessSession'
import type { AssistantTurn, ConversationEntry } from './conversation/types'
import type { CapabilitySnapshot, LocalTaskAttachment, LocalTaskRun, XiaoyinTaskProjection } from './types'

type TurnContext = {
  taskId: string
  input: string
  now: string
  existingTask?: LocalTaskRun
  scheduleId?: string
  scheduleRunId?: string
  sessionId: string
  model: string
  reasoningEffort?: import('./modelReasoning').ReasoningEffort
  executionMode?: 'agent' | 'plan'
  directories: NonNullable<LocalTaskRun['localDirectories']>
  directoriesChanged: boolean
  capabilities: CapabilitySnapshot
  invocations: ExtensionInvocation[]
  invocationTokens?: string[]
  entries: ConversationEntry[]
  projection: XiaoyinTaskProjection
  attachments: LocalTaskAttachment[]
  queuedItemId?: string
}

/** The placeholder assistant turn shown from send until the first session event. */
export function pendingAssistantTurn(model: string, reasoningEffort: import('./modelReasoning').ReasoningEffort | undefined, now: string): AssistantTurn {
  return { id: 'pending', role: 'assistant', status: 'streaming', segments: [], meta: { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), startedAt: now } }
}

/**
 * A rebuilt session loses the model's own view of the conversation, so it is
 * reserved for the one change the Harness session cannot absorb: a different
 * authorized workspace, whose root the session header pins. Everything else —
 * model, reasoning effort, the capability set — restarts the host process and
 * resumes the same session, which the acceptance check proves keeps the
 * history intact.
 */
export function sessionMustRestart(context: Pick<TurnContext, 'directoriesChanged'>): boolean {
  return context.directoriesChanged
}

/** Session selection and persisted turn state must use the same immutable context. */
export function prepareTaskTurn(context: TurnContext) {
  const { existingTask, invocations, sessionId, entries, input, now, capabilities } = context
  const executionMode = context.executionMode ?? 'agent'
  const invocationTokens = context.invocationTokens ?? invocations.map((item) => item.token)
  const fresh = sessionMustRestart(context)
    || (!sessionId && !existingTask?.sessionId && entries.length > 0)
    || (!sessionId && Boolean(existingTask?.sessionId))
  const rootSessionId = resolveHarnessSessionId(sessionId, existingTask?.sessionId, fresh,
    () => `session-${crypto.randomUUID().replaceAll('-', '')}`)
  const replay = harnessPromptWithConversationReplay(splitComposerPrompt(input).text, entries, fresh)
  const harnessPrompt = replay
  const operationScope = context.projection.interruption && context.projection.operationScope
    ? context.projection.operationScope : crypto.randomUUID()
  const runningProjection: XiaoyinTaskProjection = {
    ...context.projection,
    operationScope,
    status: 'running',
    activity: '正在处理',
    executionStarted: false,
    updatedAt: now,
    // Each submitted message is a new turn. Reusing the previous projection's
    // timestamp makes a second message appear to run since the first one.
    startedAt: now,
  }
  const userTurnId = context.queuedItemId ?? `user-${crypto.randomUUID().replaceAll('-', '')}`
  const pendingEntries: ConversationEntry[] = [...entries,
    { id: userTurnId, role: 'user', text: input, ...(context.attachments.length ? { attachments: context.attachments } : {}) },
    pendingAssistantTurn(context.model, context.reasoningEffort, now),
  ]
  const runningTask: LocalTaskRun = {
    id: context.taskId, source: 'DESKTOP',
    name: existingTask?.name ?? (splitComposerPrompt(input).text || invocations.map((item) => item.name).join('、') || input).slice(0, 60),
    status: 'RUNNING', createdAt: existingTask?.createdAt ?? now, updatedAt: now,
    sessionId: rootSessionId, model: context.model, reasoningEffort: context.reasoningEffort, executionMode, invocationTokens,
    ...(context.scheduleId ? { scheduleId: context.scheduleId } : existingTask?.scheduleId ? { scheduleId: existingTask.scheduleId } : {}),
    ...(context.scheduleRunId ? { scheduleRunId: context.scheduleRunId } : existingTask?.scheduleRunId ? { scheduleRunId: existingTask.scheduleRunId } : {}),
    localDirectories: context.directories,
    capabilitySnapshot: capabilities, projection: runningProjection, entries: pendingEntries,
  }
  return { rootSessionId, harnessPrompt, pendingEntries, userTurnId, runningProjection, runningTask }
}
