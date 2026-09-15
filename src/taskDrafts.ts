import { invoke, isTauri } from '@tauri-apps/api/core'
import type { AuthorizedLocalDirectory } from './harness'
import type { LocalTaskAttachment } from './types'

export interface TaskDraft {
  prompt: string
  attachments: LocalTaskAttachment[]
  directories: AuthorizedLocalDirectory[]
  knowledgeRefs: string[]
  connectorIds: string[]
  model: string
  reasoningEffort?: import('./modelReasoning').ReasoningEffort
  executionMode?: 'agent' | 'plan'
  updatedAt: number
}

interface WorkspaceState {
  drafts: Record<string, TaskDraft>
  recentDirectories: AuthorizedLocalDirectory[]
}

const draftStorageKey = (owner: string) => `xiaoyin.task-drafts.${owner}`
const pendingDraftKey = (owner: string) => `xiaoyin.pending-task-draft.${owner}`
const directoryStorageKey = (owner: string) => `xiaoyin.recent-directories.${owner}`
const taskKey = (id: string) => id || 'new-task'
const cache = new Map<string, WorkspaceState>()
const writes = new Map<string, Promise<void>>()

interface PendingDraft { id: string; draft: TaskDraft; nonce: string }

function pendingDraft(owner: string): PendingDraft | undefined {
  let raw: string | null
  try { raw = localStorage.getItem(pendingDraftKey(owner)) } catch { return undefined }
  if (raw === null) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && 'id' in value && 'nonce' in value && 'draft' in value
      && typeof value.id === 'string' && value.id.length <= 200 && typeof value.nonce === 'string'
      && value.nonce.length <= 100 && parseDraft(value.draft)) return value as PendingDraft
  } catch { /* Preserve the invalid emergency record for inspection. */ }
  throw new Error('本机待恢复草稿无法读取，原始数据保留')
}

export function stageTaskDraft(owner: string, id: string, draft: TaskDraft): string {
  const nonce = crypto.randomUUID()
  localStorage.setItem(pendingDraftKey(owner), JSON.stringify({ id, draft, nonce } satisfies PendingDraft))
  return nonce
}

export function clearStagedTaskDraft(owner: string, id: string, nonce: string): void {
  try {
    const staged = pendingDraft(owner)
    if (staged?.id === id && staged.nonce === nonce) localStorage.removeItem(pendingDraftKey(owner))
  } catch { /* A failed cleanup cannot overwrite the durable draft. */ }
}

function parseDraft(value: unknown): value is TaskDraft {
  if (!value || typeof value !== 'object') return false
  const item = value as TaskDraft
  return typeof item.prompt === 'string' && item.prompt.length <= 20_000 && typeof item.model === 'string'
    && (item.executionMode === undefined || item.executionMode === 'agent' || item.executionMode === 'plan') && Number.isFinite(item.updatedAt)
    && [item.attachments, item.directories, item.knowledgeRefs, item.connectorIds].every(Array.isArray)
    && item.knowledgeRefs.every((entry) => typeof entry === 'string') && item.connectorIds.every((entry) => typeof entry === 'string')
    && item.directories.every((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && (entry.path === undefined || typeof entry.path === 'string'))
    && item.attachments.every((entry) => entry && ['id', 'name', 'path', 'rootId', 'rootName'].every((field) => typeof entry[field as keyof LocalTaskAttachment] === 'string') && ['file', 'image'].includes(entry.kind) && (entry.rootPath === undefined || typeof entry.rootPath === 'string'))
}

function parseWorkspaceState(value: unknown): WorkspaceState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本机草稿数据无法读取，原始数据保留')
  const input = value as Partial<WorkspaceState>
  if (!input.drafts || typeof input.drafts !== 'object' || Array.isArray(input.drafts) || Object.keys(input.drafts).length > 100
    || Object.values(input.drafts).some((draft) => !parseDraft(draft))
    || !Array.isArray(input.recentDirectories) || input.recentDirectories.length > 8
    || input.recentDirectories.some((entry) => !entry || typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.path !== 'string')) {
    throw new Error('本机草稿数据无法读取，原始数据保留')
  }
  return { drafts: input.drafts as Record<string, TaskDraft>, recentDirectories: input.recentDirectories }
}

function browserState(owner: string): WorkspaceState {
  try {
    const drafts: unknown = JSON.parse(localStorage.getItem(draftStorageKey(owner)) ?? '{}')
    const recentDirectories: unknown = JSON.parse(localStorage.getItem(directoryStorageKey(owner)) ?? '[]')
    return parseWorkspaceState({ drafts, recentDirectories })
  } catch { throw new Error('本机草稿数据无法读取，原始数据保留') }
}

export async function loadTaskDraftState(owner: string): Promise<void> {
  await writes.get(owner)
  if (!isTauri()) {
    try { cache.set(owner, browserState(owner)) }
    catch { cache.set(owner, { drafts: {}, recentDirectories: [] }) }
    await restorePendingDraft(owner)
    return
  }
  let draftRaw: string | null = null, directoryRaw: string | null = null
  try { draftRaw = localStorage.getItem(draftStorageKey(owner)) } catch { /* Native state remains available. */ }
  try { directoryRaw = localStorage.getItem(directoryStorageKey(owner)) } catch { /* Native state remains available. */ }
  let value = await invoke<unknown>('load_local_workspace_state', { employeeId: owner })
  if (value === null) {
    let legacy: WorkspaceState
    try {
      legacy = parseWorkspaceState({ drafts: JSON.parse(draftRaw ?? '{}'), recentDirectories: JSON.parse(directoryRaw ?? '[]') })
    } catch { throw new Error('本机草稿数据无法读取，原始数据保留') }
    value = await invoke<unknown>('load_local_workspace_state', { employeeId: owner, legacy })
  }
  const state = parseWorkspaceState(value)
  cache.set(owner, state)
  await restorePendingDraft(owner)
  if (draftRaw !== null) try { localStorage.removeItem(draftStorageKey(owner)) } catch { /* Native state takes precedence. */ }
  if (directoryRaw !== null) try { localStorage.removeItem(directoryStorageKey(owner)) } catch { /* Native state takes precedence. */ }
}

async function restorePendingDraft(owner: string): Promise<void> {
  const staged = pendingDraft(owner)
  if (!staged) return
  await saveTaskDraft(owner, staged.id, staged.draft)
  clearStagedTaskDraft(owner, staged.id, staged.nonce)
}

function currentState(owner: string): WorkspaceState {
  const existing = cache.get(owner)
  if (existing) return existing
  if (!isTauri()) {
    const state = browserState(owner)
    cache.set(owner, state)
    return state
  }
  throw new Error('本机草稿尚未加载，请稍后重试')
}

async function mutateState(owner: string, update: (state: WorkspaceState) => WorkspaceState) {
  const previous = writes.get(owner) ?? Promise.resolve()
  const operation = previous.then(async () => {
    const next = update(currentState(owner))
    if (isTauri()) await invoke('save_local_workspace_state', { employeeId: owner, state: next })
    else {
      localStorage.setItem(draftStorageKey(owner), JSON.stringify(next.drafts))
      localStorage.setItem(directoryStorageKey(owner), JSON.stringify(next.recentDirectories))
    }
    cache.set(owner, next)
    return next
  })
  writes.set(owner, operation.then(() => undefined, () => undefined))
  return operation
}

export function readTaskDraft(owner: string, id: string): TaskDraft | undefined {
  return currentState(owner).drafts[taskKey(id)]
}

export async function saveTaskDraft(owner: string, id: string, draft?: TaskDraft): Promise<void> {
  await mutateState(owner, (state) => {
    const drafts = { ...state.drafts }
    if (draft && (draft.prompt || draft.attachments.length || draft.directories.length || draft.knowledgeRefs.length || draft.connectorIds.length)) drafts[taskKey(id)] = draft
    else delete drafts[taskKey(id)]
    const recent = Object.entries(drafts).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, 100)
    return { ...state, drafts: Object.fromEntries(recent) }
  })
}

export function draftRootPaths(draft: TaskDraft): string[] {
  return [...new Set([...draft.directories.map((item) => item.path), ...draft.attachments.map((item) => item.rootPath)].filter((path): path is string => Boolean(path)))]
}

export function recentWorkDirectories(owner: string): AuthorizedLocalDirectory[] {
  return currentState(owner).recentDirectories
}

export async function rememberWorkDirectory(owner: string, directory: AuthorizedLocalDirectory): Promise<void> {
  if (!directory.path) return
  await mutateState(owner, (state) => ({
    ...state,
    recentDirectories: [directory, ...state.recentDirectories.filter((item) => item.path !== directory.path)].slice(0, 8),
  }))
}
