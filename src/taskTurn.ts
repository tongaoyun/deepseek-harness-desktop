import { capabilitySnapshotChanged } from './capabilitySnapshot'
import { splitComposerPrompt } from './composerInput'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import type { ExtensionInvocation } from './extensionInvocations'
import { resolveHarnessSessionId } from './harnessSession'
import type { CapabilitySnapshot, LocalTaskAttachment, LocalTaskRun, TaskMessage, XiaoyinTaskProjection } from './types'

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
  messages: TaskMessage[]
  projection: XiaoyinTaskProjection
  attachments: LocalTaskAttachment[]
  queuedItemId?: string
}

/** Session selection and persisted turn state must use the same immutable context. */
export function prepareTaskTurn(context: TurnContext) {
  const { existingTask, invocations, sessionId, messages, input, now, capabilities } = context
  const executionMode = context.executionMode ?? 'agent'
  const invocationTokens = context.invocationTokens ?? invocations.map((item) => item.token)
  const fresh = context.directoriesChanged
    || Boolean(existingTask && (existingTask.model !== context.model
      || existingTask.reasoningEffort !== context.reasoningEffort
      || capabilitySnapshotChanged(existingTask.capabilitySnapshot, capabilities)))
    || (!sessionId && !existingTask?.sessionId && messages.length > 0)
    || (!sessionId && Boolean(existingTask?.sessionId))
    || context.projection.status === 'failed' || context.projection.status === 'canceled'
  const rootSessionId = resolveHarnessSessionId(sessionId, existingTask?.sessionId, fresh,
    () => `session-${crypto.randomUUID().replaceAll('-', '')}`)
  const replay = harnessPromptWithConversationReplay(splitComposerPrompt(input).text, messages, fresh)
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
  const pendingMessages: TaskMessage[] = [...messages,
    { role: 'user', text: input, ...(context.queuedItemId ? { id: context.queuedItemId } : {}), ...(context.attachments.length ? { attachments: context.attachments } : {}) },
    { role: 'assistant', text: '', pending: true },
  ]
  const runningTask: LocalTaskRun = {
    id: context.taskId, source: 'DESKTOP',
    name: existingTask?.name ?? (splitComposerPrompt(input).text || invocations.map((item) => item.name).join('、') || input).slice(0, 60),
    status: 'RUNNING', createdAt: existingTask?.createdAt ?? now, updatedAt: now,
    sessionId: rootSessionId, model: context.model, reasoningEffort: context.reasoningEffort, executionMode, invocationTokens,
    ...(context.scheduleId ? { scheduleId: context.scheduleId } : existingTask?.scheduleId ? { scheduleId: existingTask.scheduleId } : {}),
    ...(context.scheduleRunId ? { scheduleRunId: context.scheduleRunId } : existingTask?.scheduleRunId ? { scheduleRunId: existingTask.scheduleRunId } : {}),
    localDirectories: context.directories,
    capabilitySnapshot: capabilities, projection: runningProjection, messages: pendingMessages,
  }
  return { rootSessionId, harnessPrompt, pendingMessages, runningProjection, runningTask }
}
