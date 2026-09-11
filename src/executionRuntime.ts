import { applyHarnessNotification, applyStoppingHarnessNotification, createTaskMonitor, type HarnessFailure, type HarnessNotification } from './harness'
import { taskInterruption } from './taskInterruption'
import type {
  ExecutionEvent,
  ExecutionEventType,
  ExecutionItem,
  ExecutionProjectionDelta,
  ExecutionThread,
  ExecutionTurn,
  TaskMonitorProjection,
} from './types'
import { taskOutcomeLabel, type TaskOutcome } from './taskOutcome'

type CollectionName = NonNullable<ExecutionProjectionDelta['replaceCollections']>[number]

export interface HarnessExecutionObservation {
  thread: ExecutionThread
  monitor: TaskMonitorProjection
  event?: ExecutionEvent
  duplicate: boolean
}

export interface ExecutionRuntimeProjection {
  thread: ExecutionThread
  monitor: TaskMonitorProjection
}

export function beginExecutionTurn({
  taskId,
  sessionId,
  operationScope,
  previous,
  now = new Date().toISOString(),
  createId = () => crypto.randomUUID(),
}: {
  taskId: string
  sessionId: string
  operationScope: string
  previous?: ExecutionThread
  now?: string
  createId?: () => string
}): ExecutionRuntimeProjection {
  const monitor: TaskMonitorProjection = {
    ...createTaskMonitor(now), operationScope, status: 'running', activity: '正在处理', updatedAt: now, startedAt: now,
  }
  return initializeExecutionTurn(taskId, sessionId, monitor, previous, now, createId)
}

/** Converts pre-v1 persisted state once; normal runtime code must use domain transitions. */
export function migrateLegacyExecution(
  taskId: string,
  sessionId: string,
  monitor: TaskMonitorProjection,
  now = monitor.startedAt || monitor.updatedAt,
  createId: () => string = () => crypto.randomUUID(),
): ExecutionRuntimeProjection {
  return initializeExecutionTurn(taskId, sessionId, monitor, undefined, now, createId)
}

function initializeExecutionTurn(
  taskId: string,
  sessionId: string,
  monitor: TaskMonitorProjection,
  previous: ExecutionThread | undefined,
  now: string,
  createId: () => string,
): ExecutionRuntimeProjection {
  const turnId = `turn-${createId()}`
  const event: ExecutionEvent = {
    id: `${turnId}:1`,
    sequence: 1,
    turnId,
    type: 'turn.started',
    occurredAt: now,
    projection: fullProjection(monitor),
  }
  const turn: ExecutionTurn = {
    id: turnId,
    sessionId,
    status: monitor.status === 'completed' ? 'completed'
      : monitor.status === 'failed' ? 'failed'
        : monitor.status === 'canceled' ? 'canceled' : 'running',
    startedAt: now,
    ...(monitor.completedAt ? { completedAt: monitor.completedAt } : {}),
    nextSequence: 2,
    sourceCursors: {},
    items: [],
    events: [event],
  }
  const thread: ExecutionThread = {
    protocolVersion: 1,
    id: previous?.id ?? taskId,
    ...(monitor.status === 'running' || monitor.status === 'idle' ? { activeTurnId: turnId } : {}),
    turns: [...(previous?.turns ?? []), turn],
  }
  return { thread, monitor: projectExecutionTurn(createTaskMonitor(now), turn) }
}

export function observeHarnessNotification(
  thread: ExecutionThread,
  monitor: TaskMonitorProjection,
  notification: HarnessNotification,
  options: { stopping?: boolean } = {},
): HarnessExecutionObservation {
  const active = activeTurn(thread)
  if (!active) return { thread, monitor, duplicate: false }
  const cursor = sourceCursor(notification)
  if (cursor && (active.sourceCursors[cursor.streamId] ?? 0) >= cursor.sequence) {
    return { thread, monitor, duplicate: true }
  }
  const sourceCursors = cursor
    ? { ...active.sourceCursors, [cursor.streamId]: cursor.sequence }
    : active.sourceCursors
  const reduced = options.stopping
    ? applyStoppingHarnessNotification(monitor, notification)
    : applyHarnessNotification(monitor, notification)
  const projection = monitorDelta(monitor, reduced)
  if (!projection) {
    return { thread: replaceTurn(thread, { ...active, sourceCursors }), monitor, duplicate: false }
  }
  const identity = harnessEventIdentity(notification)
  const event: ExecutionEvent = {
    id: `${active.id}:${active.nextSequence}`,
    sequence: active.nextSequence,
    turnId: active.id,
    type: identity.type,
    occurredAt: projection.updatedAt,
    ...(identity.itemId ? { itemId: identity.itemId } : {}),
    ...(identity.itemId ? { item: executionItem(identity.itemId, reduced, identity.type, projection.updatedAt, identity.correlationId) } : {}),
    ...(identity.correlationId ? { correlationId: identity.correlationId } : {}),
    ...(cursor ? { sourceCursor: cursor } : {}),
    projection,
  }
  const previousEvent = active.events.at(-1)
  const coalesced = identity.type === 'item.updated' && Boolean(identity.itemId)
    && previousEvent?.type === identity.type && previousEvent.itemId === identity.itemId
  if (coalesced && previousEvent) {
    event.id = previousEvent.id
    event.sequence = previousEvent.sequence
    event.projection = mergeProjectionDelta(previousEvent.projection, event.projection)
  }
  const nextTurn = {
    ...active,
    nextSequence: coalesced ? active.nextSequence : active.nextSequence + 1,
    sourceCursors,
    items: event.item
      ? upsertExecutionItem(synchronizeExecutionItems(active.items, reduced), event.item)
      : synchronizeExecutionItems(active.items, reduced),
    events: coalesced ? [...active.events.slice(0, -1), event] : [...active.events, event],
  }
  return {
    thread: replaceTurn(thread, nextTurn),
    monitor: projectExecutionEvent(monitor, event),
    event,
    duplicate: false,
  }
}

function mergeProjectionDelta(previous: ExecutionProjectionDelta, next: ExecutionProjectionDelta): ExecutionProjectionDelta {
  const replaceCollections = [...new Set([...(previous.replaceCollections ?? []), ...(next.replaceCollections ?? [])])]
  return { ...previous, ...next, ...(replaceCollections.length ? { replaceCollections } : {}) }
}

export function retryExecutionTurn(
  thread: ExecutionThread,
  current: TaskMonitorProjection,
  sessionId: string,
  now = new Date().toISOString(),
): ExecutionRuntimeProjection {
  const next: TaskMonitorProjection = {
    operationScope: current.operationScope,
    status: 'running',
    activity: '模型服务短暂异常，正在自动重试',
    startedAt: current.startedAt ?? now,
    updatedAt: now,
    steps: [],
    subagents: [],
    changes: current.changes ?? [],
    artifacts: current.artifacts,
    timeline: [{
      id: `retry:${now}`,
      kind: 'warning',
      label: '模型服务短暂异常，已自动重试一次',
      status: 'completed',
      occurredAt: now,
      completedAt: now,
    }],
  }
  return appendProjectionEvent(thread, current, next, 'turn.retry.started', { correlationId: `retry:${sessionId}` })
}

export function requestExecutionInterrupt(
  thread: ExecutionThread,
  current: TaskMonitorProjection,
  now = new Date().toISOString(),
): ExecutionRuntimeProjection {
  return appendProjectionEvent(thread, current, { ...current, activity: '正在停止', updatedAt: now }, 'turn.interrupt.requested')
}

export function failExecutionInterruptRequest(
  thread: ExecutionThread,
  current: TaskMonitorProjection,
  now = new Date().toISOString(),
): ExecutionRuntimeProjection {
  return appendProjectionEvent(thread, current, { ...current, activity: '停止失败，可重试', updatedAt: now }, 'turn.interrupt.failed')
}

export function updateExecutionProgress(
  thread: ExecutionThread,
  current: TaskMonitorProjection,
  activity: string,
  now = new Date().toISOString(),
): ExecutionRuntimeProjection {
  return appendProjectionEvent(thread, current, { ...current, status: 'running', activity, updatedAt: now }, 'turn.progress.updated')
}

export function recordExecutionFileChanges(
  thread: ExecutionThread,
  current: TaskMonitorProjection,
  changes: NonNullable<TaskMonitorProjection['changes']>,
  options: { now?: string; targetTurnId?: string } = {},
): ExecutionRuntimeProjection {
  const now = options.now ?? new Date().toISOString()
  const turnId = options.targetTurnId
    ?? thread.turns.findLast((turn) => turn.events[0]?.projection.operationScope === current.operationScope)?.id
  return appendProjectionEvent(thread, current, { ...current, changes, updatedAt: now }, 'file.changes.updated', {
    allowTerminal: true, targetTurnId: turnId,
  })
}

export function completeExecutionTurn(
  thread: ExecutionThread,
  current: TaskMonitorProjection,
  outcome: TaskOutcome,
  now = new Date().toISOString(),
  options: { activity?: string } = {},
): ExecutionRuntimeProjection {
  const completed: TaskMonitorProjection = {
    ...current,
    outcome,
    status: 'completed',
    activity: options.activity ?? taskOutcomeLabel(outcome),
    updatedAt: now,
    completedAt: now,
  }
  const verified = appendProjectionEvent(thread, current, completed, 'verification.recorded', { outcome })
  return appendProjectionEvent(verified.thread, verified.monitor, verified.monitor, 'turn.completed')
}

export function failExecutionTurn(
  thread: ExecutionThread,
  current: TaskMonitorProjection,
  {
    cause,
    failure,
    now = new Date().toISOString(),
    checkpointAt,
  }: {
    cause: 'exit' | 'failure' | 'canceled'
    failure?: Pick<HarnessFailure, 'code' | 'category' | 'message'>
    now?: string
    checkpointAt?: string
  },
): ExecutionRuntimeProjection {
  const canceled = cause === 'canceled'
  const interruption = taskInterruption(current, cause, checkpointAt ?? current.updatedAt)
  const settledAt = cause === 'exit' ? checkpointAt ?? current.updatedAt : now
  const next: TaskMonitorProjection = {
    ...current,
    interruption,
    steps: current.steps.map((step) => step.status === 'running'
      ? { ...step, label: `${step.label}（结果待核对）`, status: 'canceled', completedAt: settledAt }
      : step),
    timeline: current.timeline?.map((entry) => entry.status === 'running'
      ? { ...entry, label: `${entry.label}（结果待核对）`, status: 'canceled', completedAt: settledAt }
      : entry),
    subagents: current.subagents?.map((agent) => agent.status === 'running'
      ? { ...agent, status: 'canceled', completedAt: settledAt }
      : agent),
    status: canceled ? 'canceled' : 'failed',
    activity: cause === 'exit' ? '上次运行已中断' : canceled ? '已停止' : '任务执行失败',
    updatedAt: now,
    completedAt: settledAt,
    failure: canceled ? undefined : failure
      ? { code: failure.code, category: failure.category, detail: failure.message.slice(0, 500) }
      : { code: 'XY-INTERRUPTED', category: 'local-agent', detail: '应用关闭或本地执行进程中断，已保留最近保存的进度与成果。' },
  }
  return appendProjectionEvent(thread, current, next, cause === 'failure' ? 'turn.failed' : 'turn.interrupted')
}

function appendProjectionEvent(
  thread: ExecutionThread,
  before: TaskMonitorProjection,
  after: TaskMonitorProjection,
  type: Exclude<ExecutionEventType, 'turn.started' | 'item.started' | 'item.updated' | 'item.failed' | 'approval.requested' | 'approval.decided'>,
  options: { itemId?: string; correlationId?: string; outcome?: TaskOutcome; allowTerminal?: boolean; targetTurnId?: string } = {},
): ExecutionRuntimeProjection {
  const active = options.targetTurnId
    ? thread.turns.find((turn) => turn.id === options.targetTurnId)
    : activeTurn(thread) ?? (options.allowTerminal ? thread.turns.at(-1) : undefined)
  if (!active) return { thread, monitor: before }
  const projection = monitorDelta(before, after)
  if (!projection && type !== 'turn.completed') return { thread, monitor: before }
  const event: ExecutionEvent = {
    id: `${active.id}:${active.nextSequence}`,
    sequence: active.nextSequence,
    turnId: active.id,
    type,
    occurredAt: after.updatedAt,
    ...(options.itemId ? { itemId: options.itemId } : {}),
    ...(type === 'verification.recorded' && options.outcome ? {
      itemId: `verification:${active.nextSequence}`,
      item: verificationItem(`verification:${active.nextSequence}`, options.outcome, after.updatedAt),
    } : {}),
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options.outcome ? { verification: verificationFromOutcome(options.outcome) } : {}),
    projection: projection ?? { updatedAt: after.updatedAt },
  }
  const terminal = ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(type)
  const status = type === 'turn.completed' ? 'completed'
    : type === 'turn.failed' || type === 'turn.interrupted' ? (after.status === 'canceled' ? 'canceled' : 'failed')
      : active.status
  const nextTurn: ExecutionTurn = {
    ...active,
    status,
    ...(terminal ? { completedAt: after.completedAt ?? after.updatedAt } : {}),
    nextSequence: active.nextSequence + 1,
    items: event.item
      ? upsertExecutionItem(synchronizeExecutionItems(active.items, after), event.item)
      : synchronizeExecutionItems(active.items, after),
    events: [...active.events, event],
  }
  const nextThread = {
    ...replaceTurn(thread, nextTurn),
    ...(terminal ? { activeTurnId: undefined } : {}),
  }
  return { thread: nextThread, monitor: projectExecutionEvent(before, event) }
}

export function projectExecutionTurn(initial: TaskMonitorProjection, turn: ExecutionTurn): TaskMonitorProjection {
  return turn.events.reduce(projectExecutionEvent, initial)
}

export function projectExecutionThread(thread: ExecutionThread): TaskMonitorProjection | undefined {
  const turn = thread.turns.at(-1)
  return turn ? projectExecutionTurn(createTaskMonitor(turn.startedAt), turn) : undefined
}

export function projectExecutionEvent(current: TaskMonitorProjection, event: ExecutionEvent): TaskMonitorProjection {
  const delta = event.projection
  const replace = new Set(delta.replaceCollections ?? [])
  return {
    ...current,
    ...(delta.executionStarted === undefined ? {} : { executionStarted: delta.executionStarted }),
    ...(delta.operationScope === undefined ? {} : { operationScope: delta.operationScope }),
    ...(delta.status === undefined ? {} : { status: delta.status }),
    ...(delta.activity === undefined ? {} : { activity: delta.activity }),
    updatedAt: delta.updatedAt,
    ...(delta.startedAt === undefined ? {} : { startedAt: delta.startedAt }),
    ...(delta.completedAt === undefined ? {} : { completedAt: delta.completedAt }),
    steps: projectCollection(current.steps, delta.steps, replace.has('steps')),
    timeline: projectOptionalCollection(current.timeline, delta.timeline, replace.has('timeline')),
    subagents: projectOptionalCollection(current.subagents, delta.subagents, replace.has('subagents')),
    changes: projectOptionalCollection(current.changes, delta.changes, replace.has('changes')),
    artifacts: projectCollection(current.artifacts, delta.artifacts, replace.has('artifacts')),
    visuals: projectOptionalCollection(current.visuals, delta.visuals, replace.has('visuals')),
    knowledgeSources: projectOptionalCollection(current.knowledgeSources, delta.knowledgeSources, replace.has('knowledgeSources'), knowledgeKey),
    ...(delta.interruption === undefined ? {} : { interruption: delta.interruption }),
    ...(delta.outcome === undefined ? {} : { outcome: delta.outcome }),
    ...(delta.failure === undefined ? {} : { failure: delta.failure }),
  }
}

export function verificationFromOutcome(outcome: TaskOutcome): NonNullable<ExecutionEvent['verification']> {
  if (outcome.status === 'completed') return {
    status: outcome.checks.length > 0 ? 'verified' : 'claimed',
    summary: outcome.summary,
    evidenceCount: outcome.checks.filter((check) => check.result === 'passed').length,
  }
  if (outcome.status === 'partial') return { status: 'partial', summary: outcome.summary, evidenceCount: outcome.checks.length }
  if (outcome.status === 'unverified') return { status: 'uncertain', summary: outcome.summary, evidenceCount: 0 }
  return { status: 'blocked', summary: outcome.summary, evidenceCount: outcome.checks.length }
}

function activeTurn(thread: ExecutionThread): ExecutionTurn | undefined {
  return thread.turns.find((turn) => turn.id === thread.activeTurnId)
}

function replaceTurn(thread: ExecutionThread, turn: ExecutionTurn): ExecutionThread {
  return { ...thread, turns: thread.turns.map((candidate) => candidate.id === turn.id ? turn : candidate) }
}

function upsertExecutionItem(items: ExecutionItem[], item: ExecutionItem): ExecutionItem[] {
  const index = items.findIndex((candidate) => candidate.id === item.id)
  if (index < 0) return [...items, item]
  return items.map((candidate, current) => current === index ? item : candidate)
}

function synchronizeExecutionItems(items: ExecutionItem[], monitor: TaskMonitorProjection): ExecutionItem[] {
  return items.map((item) => {
    const step = monitor.steps.find((candidate) => candidate.id === item.id)
    const timeline = monitor.timeline?.find((candidate) => candidate.id === item.id)
    const subagent = monitor.subagents?.find((candidate) => candidate.id === item.correlationId || `tool:${candidate.id}` === item.id)
    const status = step?.status ?? timeline?.status ?? subagent?.status
    if (!status) return item
    const completedAt = step?.completedAt ?? timeline?.completedAt ?? subagent?.completedAt
    return { ...item, status, ...(completedAt ? { completedAt } : {}) }
  })
}

function executionItem(
  id: string,
  monitor: TaskMonitorProjection,
  eventType: ExecutionEventType,
  occurredAt: string,
  correlationId?: string,
): ExecutionItem {
  const step = monitor.steps.find((candidate) => candidate.id === id)
  const timeline = monitor.timeline?.find((candidate) => candidate.id === id)
  if (step) return {
    id,
    kind: timeline?.kind === 'subagent' ? 'subagent'
      : step.kind === 'analysis' ? 'analysis' : step.kind === 'approval' ? 'approval' : 'tool-call',
    status: step.status,
    label: step.label,
    startedAt: step.startedAt,
    ...(step.completedAt ? { completedAt: step.completedAt } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(step.toolName ? { toolName: step.toolName } : {}),
  }
  if (timeline) return {
    id,
    kind: timeline.kind === 'assistant' ? 'assistant'
      : timeline.kind === 'approval' ? 'approval'
        : timeline.kind === 'question' ? 'question'
          : timeline.kind === 'subagent' ? 'subagent'
          : timeline.kind === 'warning' ? 'warning'
            : timeline.kind === 'error' ? 'error' : 'tool-call',
    status: timeline.status,
    label: timeline.label,
    startedAt: timeline.occurredAt,
    ...(timeline.completedAt ? { completedAt: timeline.completedAt } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(timeline.toolName ? { toolName: timeline.toolName } : {}),
  }
  return {
    id,
    kind: id === 'provider-turn' ? 'provider-turn' : eventType === 'item.failed' ? 'error' : 'analysis',
    status: eventType === 'item.failed' ? 'failed' : eventType === 'item.completed' ? 'completed' : 'running',
    label: id === 'provider-turn' ? '模型本轮执行' : '执行事项',
    startedAt: occurredAt,
    ...(['item.completed', 'item.failed'].includes(eventType) ? { completedAt: occurredAt } : {}),
    ...(correlationId ? { correlationId } : {}),
  }
}

function verificationItem(id: string, outcome: TaskOutcome, occurredAt: string): ExecutionItem {
  const verification = verificationFromOutcome(outcome)
  return {
    id,
    kind: 'verification',
    status: verification.status === 'blocked' ? 'failed' : 'completed',
    label: verification.summary,
    startedAt: occurredAt,
    completedAt: occurredAt,
  }
}

function sourceCursor(notification: HarnessNotification): ExecutionEvent['sourceCursor'] | undefined {
  return typeof notification.streamId === 'string' && notification.streamId.length > 0
    && Number.isSafeInteger(notification.requestId) && Number.isSafeInteger(notification.sequence) && notification.sequence! > 0
    ? { streamId: notification.streamId, requestId: notification.requestId, sequence: notification.sequence! }
    : undefined
}

function harnessEventIdentity(notification: HarnessNotification): Pick<ExecutionEvent, 'type' | 'itemId' | 'correlationId'> {
  const envelope = record(notification.event)
  const wire = record(envelope?.event)
  const params = record(wire?.params)
  const event = record(params?.event)
  const data = record(event?.data) ?? {}
  const type = typeof event?.type === 'string' ? event.type : ''
  const turn = integer(data.turn) ?? 0
  const step = integer(data.step) ?? 0
  const callId = string(data.callId) ?? toolResultCallId(data)
  const approvalId = string(data.approvalId)
  const questionId = string(data.questionId)
  if (type === 'step/start') return { type: 'item.started', itemId: `analysis:${turn}:${step}` }
  if (type === 'text-chunks') return { type: 'item.updated', itemId: `assistant:${turn}:${step}` }
  if (type === 'assistant/message') return { type: 'item.completed', itemId: `assistant:${turn}:${step}` }
  if (type === 'tool/call') return { type: 'item.started', itemId: callId ? `tool:${callId}` : undefined, correlationId: callId }
  if (type === 'tool/result') return { type: reducedItemType(notification), itemId: callId ? `tool:${callId}` : undefined, correlationId: callId }
  if (type === 'approval/request') return { type: 'approval.requested', itemId: approvalId ? `approval:${approvalId}` : undefined, correlationId: approvalId }
  if (type === 'approval/decision') return { type: 'approval.decided', itemId: approvalId ? `approval:${approvalId}` : undefined, correlationId: approvalId }
  if (type === 'question/request') return { type: 'question.requested', itemId: questionId ? `question:${questionId}` : undefined, correlationId: questionId }
  if (type === 'question/answered') return { type: 'question.answered', itemId: questionId ? `question:${questionId}` : undefined, correlationId: questionId }
  if (type === 'turn/end') return {
    type: string(record(data.reason)?.kind) === 'completed' ? 'item.completed' : 'item.failed',
    itemId: 'provider-turn',
  }
  return { type: type.includes('error') ? 'item.failed' : 'item.updated' }
}

function reducedItemType(notification: HarnessNotification): ExecutionEventType {
  const envelope = record(notification.event)
  const event = record(record(record(envelope?.event)?.params)?.event)
  const data = record(event?.data)
  const content = record(data?.message)?.content
  if (!Array.isArray(content)) return 'item.completed'
  return content.some((value) => record(value)?.type === 'tool-result' && record(value)?.isError === true)
    ? 'item.failed' : 'item.completed'
}

function toolResultCallId(data: Record<string, unknown>): string | undefined {
  const content = record(data.message)?.content
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    const block = record(value)
    if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') return block.toolCallId
  }
  return undefined
}

function monitorDelta(before: TaskMonitorProjection, after: TaskMonitorProjection): ExecutionProjectionDelta | undefined {
  if (before === after) return undefined
  const replaceCollections: CollectionName[] = []
  const steps = changedCollection(before.steps, after.steps, 'steps', replaceCollections)
  const timeline = changedCollection(before.timeline, after.timeline, 'timeline', replaceCollections)
  const subagents = changedCollection(before.subagents, after.subagents, 'subagents', replaceCollections)
  const changes = changedCollection(before.changes, after.changes, 'changes', replaceCollections)
  const artifacts = changedCollection(before.artifacts, after.artifacts, 'artifacts', replaceCollections)
  const visuals = changedCollection(before.visuals, after.visuals, 'visuals', replaceCollections)
  const knowledgeSources = changedCollection(before.knowledgeSources, after.knowledgeSources, 'knowledgeSources', replaceCollections, knowledgeKey)
  const scalarChanged = before.executionStarted !== after.executionStarted
    || before.operationScope !== after.operationScope || before.status !== after.status
    || before.activity !== after.activity || before.updatedAt !== after.updatedAt
    || before.startedAt !== after.startedAt || before.completedAt !== after.completedAt
    || before.interruption !== after.interruption || before.outcome !== after.outcome || before.failure !== after.failure
  if (!scalarChanged && steps === undefined && timeline === undefined && subagents === undefined
    && changes === undefined && artifacts === undefined && visuals === undefined && knowledgeSources === undefined) return undefined
  return {
    ...(before.executionStarted === after.executionStarted ? {} : { executionStarted: after.executionStarted }),
    ...(before.operationScope === after.operationScope ? {} : { operationScope: after.operationScope }),
    ...(before.status === after.status ? {} : { status: after.status }),
    ...(before.activity === after.activity ? {} : { activity: after.activity }),
    updatedAt: after.updatedAt,
    ...(before.startedAt === after.startedAt || after.startedAt === undefined ? {} : { startedAt: after.startedAt }),
    ...(before.completedAt === after.completedAt || after.completedAt === undefined ? {} : { completedAt: after.completedAt }),
    ...(steps === undefined ? {} : { steps }),
    ...(timeline === undefined ? {} : { timeline }),
    ...(subagents === undefined ? {} : { subagents }),
    ...(changes === undefined ? {} : { changes }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(visuals === undefined ? {} : { visuals }),
    ...(knowledgeSources === undefined ? {} : { knowledgeSources }),
    ...(before.interruption === after.interruption || after.interruption === undefined ? {} : { interruption: after.interruption }),
    ...(before.outcome === after.outcome || after.outcome === undefined ? {} : { outcome: after.outcome }),
    ...(before.failure === after.failure || after.failure === undefined ? {} : { failure: after.failure }),
    ...(replaceCollections.length ? { replaceCollections } : {}),
  }
}

function fullProjection(monitor: TaskMonitorProjection): ExecutionProjectionDelta {
  return {
    executionStarted: monitor.executionStarted,
    operationScope: monitor.operationScope,
    status: monitor.status,
    activity: monitor.activity,
    updatedAt: monitor.updatedAt,
    startedAt: monitor.startedAt,
    completedAt: monitor.completedAt,
    steps: monitor.steps,
    timeline: monitor.timeline,
    subagents: monitor.subagents,
    changes: monitor.changes,
    artifacts: monitor.artifacts,
    visuals: monitor.visuals,
    knowledgeSources: monitor.knowledgeSources,
    interruption: monitor.interruption,
    outcome: monitor.outcome,
    failure: monitor.failure,
    replaceCollections: ['steps', 'timeline', 'subagents', 'changes', 'artifacts', 'visuals', 'knowledgeSources'],
  }
}

function changedCollection<T>(
  before: T[] | undefined,
  after: T[] | undefined,
  name: CollectionName,
  replaceCollections: CollectionName[],
  key: (value: T) => string = defaultKey,
): T[] | undefined {
  if (before === after) return undefined
  const previous = before ?? []
  const next = after ?? []
  const previousKeys = new Set(previous.map(key))
  if (previous.some((value) => !next.some((candidate) => key(candidate) === key(value)))) {
    replaceCollections.push(name)
    return next
  }
  const changed = next.filter((value) => {
    const existing = previous.find((candidate) => key(candidate) === key(value))
    return !existing || JSON.stringify(existing) !== JSON.stringify(value)
  })
  return changed.length || (next.length === 0 && previous.length > 0) || next.some((value) => !previousKeys.has(key(value))) ? changed : undefined
}

function projectCollection<T>(current: T[], changed: T[] | undefined, replace: boolean, key: (value: T) => string = defaultKey): T[] {
  if (replace) return changed ?? []
  if (!changed?.length) return current
  const next = [...current]
  for (const value of changed) {
    const index = next.findIndex((candidate) => key(candidate) === key(value))
    if (index < 0) next.push(value)
    else next[index] = value
  }
  return next
}

function projectOptionalCollection<T>(current: T[] | undefined, changed: T[] | undefined, replace: boolean, key: (value: T) => string = defaultKey): T[] | undefined {
  if (replace && changed === undefined) return undefined
  if (!replace && changed === undefined) return current
  return projectCollection(current ?? [], changed, replace, key)
}

function defaultKey<T>(value: T): string {
  return String((value as { id?: unknown }).id ?? '')
}

function knowledgeKey(value: { sourceId?: string; documentId: string; locator: string }): string {
  return value.sourceId ?? `${value.documentId}:${value.locator}`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function integer(value: unknown): number | undefined { return Number.isInteger(value) ? value as number : undefined }
