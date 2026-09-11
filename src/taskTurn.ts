import { capabilitySnapshotChanged } from './capabilitySnapshot'
import { splitComposerPrompt } from './composerInput'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import { sameInvocationSpec, type ExtensionInvocation } from './extensionInvocations'
import { startExecutionTurn } from './executionRuntime'
import { createTaskMonitor } from './harness'
import { resolveHarnessSessionId } from './harnessSession'
import type { CapabilitySnapshot, LocalTaskAttachment, LocalTaskRun, TaskMessage, TaskMonitorState } from './types'

type TurnContext = {
  taskId: string
  input: string
  now: string
  existingTask?: LocalTaskRun
  sessionId: string
  model: string
  directories: NonNullable<LocalTaskRun['localDirectories']>
  directoriesChanged: boolean
  connectorIds: string[]
  capabilities: CapabilitySnapshot
  invocations: ExtensionInvocation[]
  messages: TaskMessage[]
  monitor: TaskMonitorState
  attachments: LocalTaskAttachment[]
}

/** Session selection and persisted turn state must use the same immutable context. */
export function prepareTaskTurn(context: TurnContext) {
  const { existingTask, invocations, sessionId, messages, input, now, capabilities } = context
  const invocationTokens = invocations.map((item) => item.token)
  const invocationSpecs = invocations.map((item) => item.spec)
  const previousInvocations = existingTask?.invocationSpecs
  const invocationsChanged = previousInvocations
    ? invocationSpecs.length !== previousInvocations.length
      || invocationSpecs.some((spec, index) => !sameInvocationSpec(spec, previousInvocations[index]!))
    : JSON.stringify(invocationTokens) !== JSON.stringify(existingTask?.invocationTokens ?? [])
  const fresh = context.directoriesChanged
    || Boolean(existingTask && (existingTask.model !== context.model || capabilitySnapshotChanged(existingTask.capabilitySnapshot, capabilities)))
    || (!sessionId && !existingTask?.sessionId && messages.length > 0)
    || invocationsChanged
    || (!sessionId && Boolean(existingTask?.sessionId))
    || context.monitor.status === 'failed' || context.monitor.status === 'canceled'
  const rootSessionId = resolveHarnessSessionId(sessionId, existingTask?.sessionId, fresh,
    () => `session-${crypto.randomUUID().replaceAll('-', '')}`)
  const replay = harnessPromptWithConversationReplay(splitComposerPrompt(input).text, messages, fresh)
  const harnessPrompt = replay
  const pendingMessages: TaskMessage[] = [...messages,
    { role: 'user', text: input, ...(context.attachments.length ? { attachments: context.attachments } : {}) },
    { role: 'assistant', text: '', pending: true },
  ]
  const operationScope = context.monitor.interruption && context.monitor.operationScope
    ? context.monitor.operationScope : crypto.randomUUID()
  const runningMonitor: TaskMonitorState = { ...createTaskMonitor(now), operationScope, status: 'running', activity: '正在处理', updatedAt: now, startedAt: now }
  const execution = startExecutionTurn(context.taskId, rootSessionId, runningMonitor, existingTask?.execution, now)
  const runningTask: LocalTaskRun = {
    id: context.taskId, source: 'DESKTOP',
    name: existingTask?.name ?? (splitComposerPrompt(input).text || invocations.map((item) => item.name).join('、') || input).slice(0, 60),
    status: 'RUNNING', createdAt: existingTask?.createdAt ?? now, updatedAt: now,
    sessionId: rootSessionId, model: context.model, invocationTokens, invocationSpecs,
    composerConnectorIds: context.connectorIds, localDirectories: context.directories,
    capabilitySnapshot: capabilities, execution, monitor: runningMonitor, messages: pendingMessages,
  }
  return { rootSessionId, harnessPrompt, pendingMessages, runningMonitor, execution, runningTask }
}
