import { capabilitySnapshotChanged } from './capabilitySnapshot'
import { splitComposerPrompt } from './composerInput'
import { harnessPromptWithConversationReplay } from './conversationReplay'
import type { ExtensionInvocation } from './extensionInvocations'
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
  const fresh = context.directoriesChanged
    || Boolean(existingTask && (existingTask.model !== context.model || capabilitySnapshotChanged(existingTask.capabilitySnapshot, capabilities)))
    || (!sessionId && !existingTask?.sessionId && messages.length > 0)
    || JSON.stringify(invocationTokens) !== JSON.stringify(existingTask?.invocationTokens ?? [])
    || (!sessionId && Boolean(existingTask?.sessionId))
    || context.monitor.status === 'failed' || context.monitor.status === 'canceled'
  const rootSessionId = resolveHarnessSessionId(sessionId, existingTask?.sessionId, fresh,
    () => `session-${crypto.randomUUID().replaceAll('-', '')}`)
  const replay = harnessPromptWithConversationReplay(input, messages, fresh)
  const harnessPrompt = invocationTokens.length && !replay.startsWith(invocationTokens.join(' ')) ? `${invocationTokens.join(' ')}\n${replay}` : replay
  const pendingMessages: TaskMessage[] = [...messages,
    { role: 'user', text: input, ...(context.attachments.length ? { attachments: context.attachments } : {}) },
    { role: 'assistant', text: '', pending: true },
  ]
  const operationScope = context.monitor.interruption && context.monitor.operationScope
    ? context.monitor.operationScope : crypto.randomUUID()
  const runningMonitor: TaskMonitorState = { ...createTaskMonitor(now), operationScope, status: 'running', activity: '正在处理', updatedAt: now, startedAt: now }
  const runningTask: LocalTaskRun = {
    id: context.taskId, source: 'DESKTOP',
    name: existingTask?.name ?? (splitComposerPrompt(input).text || invocations.map((item) => item.name).join('、') || input).slice(0, 60),
    status: 'RUNNING', createdAt: existingTask?.createdAt ?? now, updatedAt: now,
    sessionId: rootSessionId, model: context.model, invocationTokens,
    composerConnectorIds: context.connectorIds, localDirectories: context.directories,
    capabilitySnapshot: capabilities, monitor: runningMonitor, messages: pendingMessages,
  }
  return { rootSessionId, harnessPrompt, pendingMessages, runningMonitor, runningTask }
}
