import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
export type SessionEvent = { type: string; seq?: unknown; time: number; data: unknown }

/**
 * Product projection owned by Xiaoyin. The Harness session log remains the
 * authority for execution state, trajectory, approvals and questions. This
 * projection contains only product-owned receipts that are not represented by
 * the official Conversation surface.
 */
export interface XiaoyinTaskView {
  updatedAt: string
  changes: Array<Record<string, unknown>>
  artifacts: Array<Record<string, unknown>>
  visuals: Array<Record<string, unknown>>
  knowledgeSources: Array<Record<string, unknown>>
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
  updatedAt: new Date(0).toISOString(), changes: [], artifacts: [], visuals: [], knowledgeSources: [],
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
  if (event.type === 'tool/call') {
    const callId = text(data?.callId)
    const toolName = text(data?.name)
    if (!callId || !toolName) return state
    return { ...nextState(state, changed(current, { updatedAt: time })), toolNames: { ...state.toolNames, [callId]: toolName } }
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
    const next = changed(current, {
      updatedAt: time,
      ...(artifact ? { artifacts: upsertById(current.artifacts, artifact) } : {}),
      ...(change ? { changes: upsertById(current.changes, change) } : {}),
      ...(knowledge.length ? { knowledgeSources: [...(current.knowledgeSources ?? []), ...knowledge].filter((item, index, all) => all.findIndex((candidate) => candidate.sourceId === item.sourceId) === index).slice(-100) } : {}),
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
      updatedAt: time,
      artifacts: artifacts.reduce((items, artifact) => upsertById(items, artifact), current.artifacts),
    }))
  }
  return state
}

function changed(current: XiaoyinTaskView, patch: Partial<XiaoyinTaskView>): XiaoyinTaskView { return { ...current, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() } }
function eventTime(value: unknown): string {
  const date = new Date(typeof value === 'number' ? value : Number.NaN)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}
function nextState(state: XiaoyinTaskState, value: XiaoyinTaskView): XiaoyinTaskState { return value === state.value ? state : { ...state, value } }
function upsertById(items: Array<Record<string, unknown>>, item: Record<string, unknown>): Array<Record<string, unknown>> { const index = items.findIndex((value) => value.id === item.id); return index < 0 ? [...items, item].slice(-100) : items.map((value, current) => current === index ? { ...value, ...item } : value) }
function record(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
function boundedText(value: unknown, max: number): string | undefined { return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined }
function sequence(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined }
function resultValue(value: unknown): Record<string, unknown> | unknown[] | undefined {
  const blocks = Array.isArray(value) ? value : []
  for (const block of blocks) { const item = record(block); const textValue = text(item?.text); if (!textValue) continue; try { const parsed: unknown = JSON.parse(textValue); if (record(parsed) || Array.isArray(parsed)) return parsed as Record<string, unknown> | unknown[] } catch { /* human-readable tool output is not a product receipt */ } }
  return undefined
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
