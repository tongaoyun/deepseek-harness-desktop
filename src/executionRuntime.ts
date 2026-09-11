import { applyHarnessNotification, type HarnessNotification } from './harness'
import type {
  ExecutionEvent,
  ExecutionEventType,
  ExecutionItem,
  ExecutionProjectionDelta,
  ExecutionThread,
  ExecutionTurn,
  TaskMonitorState,
} from './types'
import type { TaskOutcome } from './taskOutcome'

type CollectionName = NonNullable<ExecutionProjectionDelta['replaceCollections']>[number]

export interface HarnessExecutionObservation {
  thread: ExecutionThread
  monitor: TaskMonitorState
  event?: ExecutionEvent
  duplicate: boolean
}

export function startExecutionTurn(
  taskId: string,
  sessionId: string,
  monitor: TaskMonitorState,
  previous?: ExecutionThread,
  now = new Date().toISOString(),
  createId: () => string = () => crypto.randomUUID(),
): ExecutionThread {
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
    status: 'running',
    startedAt: now,
    nextSequence: 2,
    sourceCursors: {},
    items: [],
    events: [event],
  }
  return {
    protocolVersion: 1,
    id: previous?.id ?? taskId,
    activeTurnId: turnId,
    turns: [...(previous?.turns ?? []), turn],
  }
}

export function observeHarnessNotification(
  thread: ExecutionThread,
  monitor: TaskMonitorState,
  notification: HarnessNotification,
  reduce: (current: TaskMonitorState, value: HarnessNotification) => TaskMonitorState = applyHarnessNotification,
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
  const reduced = reduce(monitor, notification)
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
  const nextTurn = {
    ...active,
    nextSequence: active.nextSequence + 1,
    sourceCursors,
    items: event.item ? upsertExecutionItem(active.items, event.item) : active.items,
    events: [...active.events, event],
  }
  return {
    thread: replaceTurn(thread, nextTurn),
    monitor: projectExecutionEvent(monitor, event),
    event,
    duplicate: false,
  }
}

export function appendExecutionTransition(
  thread: ExecutionThread,
  before: TaskMonitorState,
  after: TaskMonitorState,
  type: Extract<ExecutionEventType, 'item.completed' | 'turn.completed' | 'turn.failed' | 'turn.interrupted' | 'verification.recorded'>,
  options: { itemId?: string; correlationId?: string; outcome?: TaskOutcome } = {},
): ExecutionThread {
  const active = activeTurn(thread)
  if (!active) return thread
  const projection = monitorDelta(before, after)
  if (!projection && type === 'item.completed') return thread
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
    items: event.item ? upsertExecutionItem(active.items, event.item) : active.items,
    events: [...active.events, event],
  }
  return {
    ...replaceTurn(thread, nextTurn),
    ...(terminal ? { activeTurnId: undefined } : {}),
  }
}

export function projectExecutionTurn(initial: TaskMonitorState, turn: ExecutionTurn): TaskMonitorState {
  return turn.events.reduce(projectExecutionEvent, initial)
}

export function projectExecutionEvent(current: TaskMonitorState, event: ExecutionEvent): TaskMonitorState {
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

function executionItem(
  id: string,
  monitor: TaskMonitorState,
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
  if (type === 'step/start') return { type: 'item.started', itemId: `analysis:${turn}:${step}` }
  if (type === 'text-chunks') return { type: 'item.updated', itemId: `assistant:${turn}:${step}` }
  if (type === 'assistant/message') return { type: 'item.completed', itemId: `assistant:${turn}:${step}` }
  if (type === 'tool/call') return { type: 'item.started', itemId: callId ? `tool:${callId}` : undefined, correlationId: callId }
  if (type === 'tool/result') return { type: reducedItemType(notification), itemId: callId ? `tool:${callId}` : undefined, correlationId: callId }
  if (type === 'approval/request') return { type: 'approval.requested', itemId: approvalId ? `approval:${approvalId}` : undefined, correlationId: approvalId }
  if (type === 'approval/decision') return { type: 'approval.decided', itemId: approvalId ? `approval:${approvalId}` : undefined, correlationId: approvalId }
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

function monitorDelta(before: TaskMonitorState, after: TaskMonitorState): ExecutionProjectionDelta | undefined {
  if (before === after) return undefined
  const replaceCollections: CollectionName[] = []
  const steps = changedCollection(before.steps, after.steps, 'steps', replaceCollections)
  const timeline = changedCollection(before.timeline, after.timeline, 'timeline', replaceCollections)
  const subagents = changedCollection(before.subagents, after.subagents, 'subagents', replaceCollections)
  const changes = changedCollection(before.changes, after.changes, 'changes', replaceCollections)
  const artifacts = changedCollection(before.artifacts, after.artifacts, 'artifacts', replaceCollections)
  const visuals = changedCollection(before.visuals, after.visuals, 'visuals', replaceCollections)
  const knowledgeSources = changedCollection(before.knowledgeSources, after.knowledgeSources, 'knowledgeSources', replaceCollections, knowledgeKey)
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

function fullProjection(monitor: TaskMonitorState): ExecutionProjectionDelta {
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
