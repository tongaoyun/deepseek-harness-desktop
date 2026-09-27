import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
export type SessionEvent = { type: string; seq?: unknown; time: number; data: unknown }

/**
 * Product projection owned by Xiaoyin. The Harness session log remains the
 * authority; this state is only the complete, wire-safe read model consumed by
 * the desktop, IM and scheduled-task carriers.
 */
export interface XiaoyinTaskView {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'canceled'
  activity: string
  updatedAt: string
  executionStarted: boolean
  startedAt?: string
  completedAt?: string
  steps: Array<Record<string, unknown>>
  timeline: Array<Record<string, unknown>>
  subagents: Array<Record<string, unknown>>
  changes: Array<Record<string, unknown>>
  artifacts: Array<Record<string, unknown>>
  visuals: Array<Record<string, unknown>>
  knowledgeSources: Array<Record<string, unknown>>
  outputRetention: { prunedResults: number; omittedTokens: number }
  compactions: number
  interruption?: Record<string, unknown>
  failure?: Record<string, unknown>
}

export interface XiaoyinTaskState { value: XiaoyinTaskView; toolNames: Record<string, string>; lastSeq?: number }

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionMap { 'xiaoyin.product': XiaoyinTaskView }
  interface SessionProjectionStateMap { 'xiaoyin.product': XiaoyinTaskState }
}

export const name = 'xiaoyin-product-projections'
export const inject = ['sessionProjections']

// Schemastery is the host's schema implementation. The projection payload is
// intentionally open-ended because task item/tool metadata is owned by tools;
// the registry still validates that the value is JSON-serializable at the
// projection boundary.
const jsonSchema = z.any() as never

export const initialXiaoyinTaskView = (): XiaoyinTaskView => ({
  status: 'idle', activity: '等待处理', updatedAt: new Date(0).toISOString(), executionStarted: false,
  steps: [], timeline: [], subagents: [], changes: [], artifacts: [], visuals: [], knowledgeSources: [],
  outputRetention: { prunedResults: 0, omittedTokens: 0 }, compactions: 0,
})

export function apply(ctx: Context): void {
  const definition: ProjectionDefinition<'xiaoyin.product', XiaoyinTaskState> = {
    key: 'xiaoyin.product',
    stateSchema: jsonSchema,
    stateVersion: 2,
    init: () => ({ value: initialXiaoyinTaskView(), toolNames: {}, lastSeq: -1 }),
    apply: (state, event) => {
      const next = reduceEvent(state, event)
      return next === state ? state : next
    },
    wire: { viewSchema: jsonSchema, view: (state) => state.value },
  }
  // The registry's merge-extensible type table is intentionally owned by the
  // upstream package. Keep this product extension isolated at the runtime
  // boundary so an SDK update cannot block the host build on declaration order.
  ;(ctx.sessionProjections as unknown as { register(value: unknown): () => void }).register(definition)
}

export function reduceEvent(state: XiaoyinTaskState, event: SessionEvent): XiaoyinTaskState {
  const seq = sequence(event.seq)
  if (seq !== undefined && seq <= (state.lastSeq ?? -1)) return state
  const next = reduceEventValue(state, event)
  return seq === undefined ? next : { ...next, lastSeq: seq }
}

function reduceEventValue(state: XiaoyinTaskState, event: SessionEvent): XiaoyinTaskState {
  const current = state.value
  const time = eventTime(event.time)
  const data = record(event.data)
  const turn = number(data?.turn) ?? 0
  const step = number(data?.step) ?? 0
  if (event.type === 'turn/start') return nextState(state, changed(current, { status: 'running', activity: '正在分析任务', startedAt: current.startedAt ?? time }))
  if (event.type === 'step/start') {
    const id = `analysis:${turn}:${step}`
    return nextState(state, changed(current, { status: 'running', activity: '正在分析任务', steps: upsert(current.steps, { id, kind: 'analysis', label: step === 1 ? '分析任务' : '整理工具结果', status: 'running', startedAt: time }) }))
  }
  if (event.type === 'tool/call') {
    const callId = text(data?.callId)
    const toolName = text(data?.name)
    if (!callId || !toolName) return state
    const stepId = `tool:${callId}`
    const subagents = toolName.startsWith('subagent')
      ? upsert(current.subagents, { id: callId, label: text(recordValue(data?.arguments)?.description) ?? '委派子任务', status: 'running', startedAt: time })
      : current.subagents
    return { ...nextState(state, changed(current, {
      status: 'running', activity: isOfficialMcpTool(toolName) ? `正在等待连接器 ${connectorLabel(toolName)} 返回` : `正在调用 ${toolName}`, executionStarted: true,
      steps: upsert(upsert(current.steps, { id: `analysis:${turn}:${step}`, kind: 'analysis', label: '分析任务', status: 'completed', startedAt: time, completedAt: time }), { id: stepId, kind: 'tool', label: toolName, toolName, status: 'running', startedAt: time }),
      timeline: upsert(current.timeline, { id: stepId, kind: 'tool', label: toolName, toolName, status: 'running', occurredAt: time }),
      ...(subagents !== current.subagents ? { subagents } : {}),
    })), toolNames: { ...state.toolNames, [callId]: toolName } }
  }
  if (event.type === 'tool/result') {
    const message = record(data?.message)
    const result = message?.content
    const block = typeof message?.toolCallId === 'string'
      ? { toolCallId: message.toolCallId, content: result, ...(message.isError === undefined ? {} : { isError: message.isError }) }
      : Array.isArray(result) ? result.find((item) => record(item) && typeof item.toolCallId === 'string') as Record<string, unknown> | undefined : undefined
    const callId = text(block?.toolCallId)
    if (!callId) return nextState(state, changed(current, { updatedAt: time }))
    const failed = block?.isError === true || Boolean(data?.error)
    const toolName = state.toolNames[callId]
    const parsed = resultValue(block?.content)
    const artifact = !failed && toolName && isArtifactTool(toolName) ? artifactFromValue(toolName, parsed, time) : undefined
    const change = !failed && toolName && isChangeTool(toolName) ? changeFromValue(toolName, parsed, time) : undefined
    const knowledge = !failed && toolName === 'knowledge_search' ? knowledgeFromValue(parsed) : []
    const subagents = toolName?.startsWith('subagent')
      ? current.subagents.map((item) => item.id === callId ? { ...item, status: failed ? 'failed' : 'completed', completedAt: time } : item)
      : current.subagents
    const next = changed(current, {
      activity: '正在整理工具结果', updatedAt: time,
      steps: current.steps.map((item) => item.id === `tool:${callId}` ? { ...item, status: failed ? 'failed' : 'completed', completedAt: time } : item),
      timeline: current.timeline.map((item) => item.id === `tool:${callId}` ? { ...item, status: failed ? 'failed' : 'completed', completedAt: time } : item),
      ...(artifact ? { artifacts: upsertById(current.artifacts, artifact) } : {}),
      ...(change ? { changes: upsertById(current.changes, change) } : {}),
      ...(knowledge.length ? { knowledgeSources: [...(current.knowledgeSources ?? []), ...knowledge].filter((item, index, all) => all.findIndex((candidate) => candidate.sourceId === item.sourceId) === index).slice(-100) } : {}),
      ...(subagents !== current.subagents ? { subagents } : {}),
    })
    return { ...nextState(state, next), toolNames: Object.fromEntries(Object.entries(state.toolNames).filter(([id]) => id !== callId)) }
  }
  if (event.type === 'deliverables/presented') {
    const files = Array.isArray(data?.files) ? data.files : []
    const artifacts = files
      .map((value) => artifactFromPresented(value, time))
      .filter((artifact): artifact is Record<string, unknown> => artifact !== undefined)
    if (artifacts.length === 0) return state
    return nextState(state, changed(current, {
      activity: '已整理交付文件',
      artifacts: artifacts.reduce((items, artifact) => upsertById(items, artifact), current.artifacts),
      timeline: upsert(current.timeline, {
        id: `present:${text(data?.callId) ?? `${turn}:${step}`}`,
        kind: 'artifact', label: `交付 ${artifacts.length} 个文件`, status: 'completed', occurredAt: time, completedAt: time,
      }),
    }))
  }
  if (event.type === 'compaction/start' || event.type === 'compaction/end') {
    const compactionId = text(data?.compactionId) ?? `${turn}:${step}`
    const completed = event.type === 'compaction/end'
    return nextState(state, changed(current, {
      activity: completed ? current.activity : '正在整理上下文',
      compactions: (current.compactions ?? 0) + (completed ? 1 : 0),
      timeline: upsert(current.timeline, {
        id: `compaction:${compactionId}`, kind: 'tool',
        label: completed ? '上下文整理完成' : '整理上下文',
        status: completed ? 'completed' : 'running', occurredAt: time,
        ...(completed ? { completedAt: time } : {}),
      }),
    }))
  }
  if (event.type === 'compaction/prune') {
    const shadowedSeqs = Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs.length : 1
    const shadowedTokenCount = number(data?.shadowedTokenCount) ?? 0
    return nextState(state, changed(current, {
      activity: '正在整理工具结果',
      outputRetention: {
        prunedResults: (current.outputRetention?.prunedResults ?? 0) + shadowedSeqs,
        omittedTokens: (current.outputRetention?.omittedTokens ?? 0) + shadowedTokenCount,
      },
      timeline: upsert(current.timeline, {
        id: `retention:${Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs.join(',') : `${turn}:${step}`}`,
        kind: 'tool', label: '裁剪工具结果', status: 'completed',
        detail: `${shadowedSeqs} 项${shadowedTokenCount > 0 ? `，约 ${shadowedTokenCount} tokens` : ''}`,
        occurredAt: time, completedAt: time,
      },
      ),
    }))
  }
  if (event.type === 'approval/request') {
    const approvalId = text(data?.approvalId)
    const toolName = text(data?.name)
    if (!approvalId || !toolName) return state
    return nextState(state, changed(current, {
      status: 'running', activity: '等待操作确认', executionStarted: true,
      steps: upsert(current.steps, { id: `approval:${approvalId}`, kind: 'approval', label: `确认${toolName}`, toolName, status: 'running', startedAt: time }),
      timeline: upsert(current.timeline, { id: `approval:${approvalId}`, kind: 'approval', label: `需要确认：${toolName}`, toolName, approvalId, ...(boundedText(data?.reason, 2_000) ? { detail: boundedText(data?.reason, 2_000) } : {}), status: 'running', occurredAt: time }),
    }))
  }
  if (event.type === 'approval/decision') {
    const approvalId = text(data?.approvalId)
    const toolName = text(data?.name)
    const decision = text(data?.decision)
    if (!approvalId || !toolName || !['allow', 'reject'].includes(decision ?? '')) return state
    const allowed = decision === 'allow'
    return nextState(state, changed(current, {
      steps: upsert(current.steps, { id: `approval:${approvalId}`, kind: 'approval', label: `${allowed ? '已允许' : '已拒绝'}${toolName}`, toolName, status: allowed ? 'completed' : 'failed', startedAt: time, completedAt: time }),
      timeline: upsert(current.timeline, { id: `approval:${approvalId}`, kind: 'approval', label: `${allowed ? '已允许' : '已拒绝'}${toolName}`, toolName, approvalId, status: allowed ? 'completed' : 'failed', occurredAt: time, completedAt: time }),
    }))
  }
  if (event.type === 'question/request') {
    const questionId = text(data?.questionId)
    const questions = questionsFromValue(data?.questions)
    if (!questionId || questions.length === 0) return state
    return nextState(state, changed(current, {
      status: 'running', activity: '等待补充信息', executionStarted: true,
      timeline: upsert(current.timeline, { id: `question:${questionId}`, kind: 'question', label: '需要你的回答', questionId, questions, status: 'running', occurredAt: time }),
    }))
  }
  if (event.type === 'question/answered') {
    const questionId = text(data?.questionId)
    if (!questionId) return state
    return nextState(state, changed(current, { timeline: current.timeline.map((item) => item.id === `question:${questionId}` ? { ...item, status: 'completed', completedAt: time } : item) }))
  }
  if (event.type === 'assistant/message') return nextState(state, changed(current, { activity: '正在生成回复', steps: current.steps.map((item) => item.status === 'running' && item.kind === 'analysis' ? { ...item, status: 'completed', completedAt: time } : item), timeline: upsert(current.timeline, { id: `assistant:${turn}:${step}`, kind: 'assistant', label: '说明', status: 'completed', occurredAt: time }) }))
  if (event.type === 'turn/end') {
    const reason = record(data?.reason)
    const kind = text(reason?.kind)
    const status = kind === 'completed' ? 'completed' : kind === 'aborted' ? 'canceled' : kind === 'interrupted' ? 'failed' : 'failed'
    const settledStatus = status === 'completed' ? 'completed' : status === 'canceled' ? 'canceled' : 'failed'
    return nextState(state, changed(current, {
      status, activity: status === 'completed' ? '任务已完成' : status === 'canceled' ? '已停止' : '任务执行失败', completedAt: time,
      steps: current.steps.map((item) => item.status === 'running' ? { ...item, status: item.kind === 'tool' && status !== 'completed' ? 'canceled' : settledStatus, completedAt: time } : item),
      timeline: current.timeline.map((item) => item.status === 'running' ? { ...item, status: item.kind === 'tool' && status !== 'completed' ? 'canceled' : settledStatus, completedAt: time } : item),
      subagents: current.subagents.map((item) => item.status === 'running' ? { ...item, status: settledStatus, completedAt: time } : item),
    }))
  }
  return state
}

/** Official dsh-mcp-client names are `mcp__<server>__<tool>`. */
function isOfficialMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp__') && toolName.indexOf('__', 5) > 5
}

function connectorLabel(toolName: string): string {
  if (!isOfficialMcpTool(toolName)) return '连接器'
  return toolName.slice(5, toolName.indexOf('__', 5)) || '连接器'
}

function changed(current: XiaoyinTaskView, patch: Partial<XiaoyinTaskView>): XiaoyinTaskView { return { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() } }
function eventTime(value: unknown): string {
  const date = new Date(typeof value === 'number' ? value : Number.NaN)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}
function nextState(state: XiaoyinTaskState, value: XiaoyinTaskView): XiaoyinTaskState { return value === state.value ? state : { ...state, value } }
function upsert(items: Array<Record<string, unknown>>, item: Record<string, unknown>): Array<Record<string, unknown>> { const index = items.findIndex((value) => value.id === item.id); if (index < 0) return [...items, item].slice(-100); return items.map((value, current) => current === index ? { ...value, ...item } : value).slice(-100) }
function upsertById(items: Array<Record<string, unknown>>, item: Record<string, unknown>): Array<Record<string, unknown>> { const index = items.findIndex((value) => value.id === item.id); return index < 0 ? [...items, item].slice(-100) : items.map((value, current) => current === index ? { ...value, ...item } : value) }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function boundedText(value: unknown, max: number): string | undefined { return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined }
function sequence(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }
function resultValue(value: unknown): Record<string, unknown> | unknown[] | undefined {
  const blocks = Array.isArray(value) ? value : []
  for (const block of blocks) { const item = record(block); const textValue = text(item?.text); if (!textValue) continue; try { const parsed: unknown = JSON.parse(textValue); if (record(parsed) || Array.isArray(parsed)) return parsed as Record<string, unknown> | unknown[] } catch { /* human-readable tool output is not a product receipt */ } }
  return undefined
}
function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return record(value)
  try { return record(JSON.parse(value)) } catch { return undefined }
}
function questionsFromValue(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const question = record(entry)
    const id = boundedText(question?.id, 200)
    const prompt = boundedText(question?.question, 4_000)
    if (!question || !id || !prompt) return []
    const options = Array.isArray(question.options)
      ? question.options.slice(0, 12).flatMap((option) => { const item = record(option); const label = boundedText(item?.label, 500); return item && label ? [{ label, ...(boundedText(item.description, 1_000) ? { description: boundedText(item.description, 1_000) } : {}) }] : [] })
      : undefined
    return [{ id, question: prompt, ...(boundedText(question.header, 200) ? { header: boundedText(question.header, 200) } : {}), ...(boundedText(question.detail, 64 * 1024) ? { detail: boundedText(question.detail, 64 * 1024) } : {}), ...(options?.length ? { options } : {}), ...(question.multiSelect === true ? { multiSelect: true } : {}) }]
  })
}
const localFileWriteTools = new Set([
  'local_files_write_text', 'local_files_copy', 'local_files_move',
  'local_files_delete', 'local_files_create_directory',
])
function isArtifactTool(name: string): boolean { return name === 'local_files_publish' }
function isChangeTool(name: string): boolean { return isArtifactTool(name) || localFileWriteTools.has(name) }
function artifactFromValue(toolName: string, value: Record<string, unknown> | unknown[] | undefined, createdAt: string): Record<string, unknown> | undefined {
  const item = record(value); const rootId = text(item?.rootId); const rootName = text(item?.rootName); const path = text(item?.path) ?? text(item?.destination); if (!rootId || !rootName || !path || path === '.' || path.startsWith('/')) return undefined
  const name = path.split('/').filter(Boolean).at(-1); if (!name) return undefined
  return { id: `${rootId}:${path}`, rootId, rootName, path, name, kind: artifactKind(name), sourceTool: toolName, action: toolName === 'local_files_publish' ? 'published' : 'updated', createdAt }
}
function artifactFromPresented(value: unknown, createdAt: string): Record<string, unknown> | undefined {
  const item = record(value)
  const path = text(item?.path)?.replaceAll('\\', '/')
  if (!path || path.startsWith('/') || path.split('/').some((part) => part === '.' || part === '..' || part === '')) return undefined
  const name = path.split('/').at(-1)
  if (!name || name === '.' || name === '..') return undefined
  const description = boundedText(item?.description, 1_000)
  const rootId = harnessWorkspaceRootId()
  return {
    id: `${rootId}:${path}`, rootId, rootName: 'Harness 工作区', path, name,
    kind: artifactKind(name), sourceTool: 'present', action: 'presented', createdAt,
    ...(description ? { description } : {}),
  }
}
function harnessWorkspaceRootId(): string {
  const employeeId = process.env.XIAOYIN_EMPLOYEE_ID
  return employeeId ? `harness-workspace-employee-${createHash('sha256').update(employeeId).digest('hex')}` : 'harness-workspace'
}
function changeFromValue(toolName: string, value: Record<string, unknown> | unknown[] | undefined, changedAt: string): Record<string, unknown> | undefined {
  const item = record(value); const rootId = text(item?.rootId); const rootName = text(item?.rootName); const path = text(item?.path) ?? text(item?.destination); if (!rootId || !rootName || !path || path === '.' || path.startsWith('/')) return undefined
  const name = path.split('/').filter(Boolean).at(-1); if (!name) return undefined
  const action = toolName.endsWith('_delete') ? 'deleted' : toolName.endsWith('_copy') ? 'copied' : toolName.endsWith('_move') ? 'moved' : item?.backupPath ? 'updated' : 'created'
  return { id: `${rootId}:${path}`, rootId, rootName, path, name, sourceTool: toolName, action, ...(text(item?.backupPath) ? { backupPath: item?.backupPath } : {}), ...(text(item?.afterHash) ? { afterHash: item?.afterHash } : {}), changedAt }
}
function artifactKind(name: string): string { const ext = name.split('.').at(-1)?.toLowerCase(); return ext === 'xlsx' || ext === 'xls' || ext === 'csv' ? 'spreadsheet' : ext === 'docx' ? 'document' : ext === 'pptx' ? 'presentation' : ext === 'pdf' ? 'pdf' : ['png', 'jpg', 'jpeg', 'webp'].includes(ext ?? '') ? 'image' : 'file' }
function knowledgeFromValue(value: Record<string, unknown> | unknown[] | undefined): Array<Record<string, unknown>> {
  let budget = 64_000
  return (Array.isArray(value) ? value : []).slice(-100).flatMap((entry) => {
    const item = record(entry)
    const sourceId = boundedText(item?.sourceId, 500)
    const knowledgeBaseId = boundedText(item?.knowledgeBaseId, 500)
    const documentId = boundedText(item?.documentId, 500)
    const filename = boundedText(item?.filename, 500)
    const content = boundedText(item?.content, Math.min(8_000, budget))
    if (!sourceId || !knowledgeBaseId || !documentId || !filename || !content) return []
    budget -= content.length
    return [{ sourceId, knowledgeBaseId, knowledgeBaseName: boundedText(item?.knowledgeBaseName, 500) ?? '', documentId, filename, locator: boundedText(item?.locator, 2_000) ?? '', content, score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0 }]
  })
}
