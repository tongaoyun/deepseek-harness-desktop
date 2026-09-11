import { capabilitySnapshotChanged } from './capabilitySnapshot'
import { splitComposerPrompt } from './composerInput'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import type { ExtensionInvocation } from './extensionInvocations'
import { beginExecutionTurn } from './executionRuntime'
import { resolveHarnessSessionId } from './harnessSession'
import type { CapabilitySnapshot, LocalTaskAttachment, LocalTaskRun, TaskMessage, TaskMonitorState } from './types'

type TurnContext = {
  taskId: string
  input: string
  now: string
  existingTask?: LocalTaskRun
  sessionId: string
  model: string
  executionMode?: 'agent' | 'plan'
  directories: NonNullable<LocalTaskRun['localDirectories']>
  directoriesChanged: boolean
  capabilities: CapabilitySnapshot
  invocations: ExtensionInvocation[]
  invocationTokens?: string[]
  messages: TaskMessage[]
  monitor: TaskMonitorState
  attachments: LocalTaskAttachment[]
}

/** Session selection and persisted turn state must use the same immutable context. */
export function prepareTaskTurn(context: TurnContext) {
  const { existingTask, invocations, sessionId, messages, input, now, capabilities } = context
  const executionMode = context.executionMode ?? 'agent'
  const invocationTokens = context.invocationTokens ?? invocations.map((item) => item.token)
  const fresh = context.directoriesChanged
    || Boolean(existingTask && (existingTask.model !== context.model
      || capabilitySnapshotChanged(existingTask.capabilitySnapshot, capabilities)))
    || (!sessionId && !existingTask?.sessionId && messages.length > 0)
    || (!sessionId && Boolean(existingTask?.sessionId))
    || context.monitor.status === 'failed' || context.monitor.status === 'canceled'
  const rootSessionId = resolveHarnessSessionId(sessionId, existingTask?.sessionId, fresh,
    () => `session-${crypto.randomUUID().replaceAll('-', '')}`)
  const replay = harnessPromptWithConversationReplay(splitComposerPrompt(input).text, messages, fresh)
  const harnessPrompt = replay
  const operationScope = context.monitor.interruption && context.monitor.operationScope
    ? context.monitor.operationScope : crypto.randomUUID()
  const runtime = beginExecutionTurn({
    taskId: context.taskId, sessionId: rootSessionId, operationScope, previous: existingTask?.execution, now,
  })
  const { thread: execution, monitor: runningMonitor } = runtime
  const pendingMessages: TaskMessage[] = [...messages,
    { role: 'user', text: input, ...(context.attachments.length ? { attachments: context.attachments } : {}) },
    { role: 'assistant', text: '', pending: true, executionTurnId: execution.activeTurnId },
  ]
  const runningTask: LocalTaskRun = {
    id: context.taskId, source: 'DESKTOP',
    name: existingTask?.name ?? (splitComposerPrompt(input).text || invocations.map((item) => item.name).join('、') || input).slice(0, 60),
    status: 'RUNNING', createdAt: existingTask?.createdAt ?? now, updatedAt: now,
    sessionId: rootSessionId, model: context.model, executionMode, invocationTokens,
    localDirectories: context.directories,
    capabilitySnapshot: capabilities, execution, monitor: runningMonitor, messages: pendingMessages,
  }
  return { rootSessionId, harnessPrompt, pendingMessages, runningMonitor, execution, runningTask }
}
