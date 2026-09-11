import type { AuthorizedLocalDirectory } from './harness'
import type { LocalTaskAttachment } from './types'

export interface TaskDraft {
  prompt: string
  attachments: LocalTaskAttachment[]
  directories: AuthorizedLocalDirectory[]
  knowledgeRefs: string[]
  connectorIds: string[]
  model: string
  executionMode?: 'agent' | 'plan'
  updatedAt: number
}

const key = (owner: string) => `xiaoyin.task-drafts.${owner}`
const taskKey = (id: string) => id || 'new-task'
export function readTaskDraft(owner: string, id: string): TaskDraft | undefined { return readDrafts(owner)[taskKey(id)] }
function readDrafts(owner: string): Record<string, TaskDraft> {
  try {
    const value = JSON.parse(localStorage.getItem(key(owner)) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, draft]) => {
      const item = draft as TaskDraft
      return item && typeof item.prompt === 'string' && typeof item.model === 'string'
        && (item.executionMode === undefined || item.executionMode === 'agent' || item.executionMode === 'plan') && Number.isFinite(item.updatedAt)
        && [item.attachments, item.directories, item.knowledgeRefs, item.connectorIds].every(Array.isArray)
        && item.knowledgeRefs.every((entry) => typeof entry === 'string') && item.connectorIds.every((entry) => typeof entry === 'string')
        && item.directories.every((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && (entry.path === undefined || typeof entry.path === 'string'))
        && item.attachments.every((entry) => entry && ['id', 'name', 'path', 'rootId', 'rootName'].every((field) => typeof entry[field as keyof LocalTaskAttachment] === 'string') && ['file', 'image'].includes(entry.kind) && (entry.rootPath === undefined || typeof entry.rootPath === 'string'))
    })) as Record<string, TaskDraft>
  } catch { return {} }
}

export function saveTaskDraft(owner: string, id: string, draft?: TaskDraft): void {
  const drafts = readDrafts(owner)
  if (draft && (draft.prompt || draft.attachments.length || draft.directories.length || draft.knowledgeRefs.length || draft.connectorIds.length)) drafts[taskKey(id)] = draft
  else delete drafts[taskKey(id)]
  const recent = Object.entries(drafts).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, 100)
  localStorage.setItem(key(owner), JSON.stringify(Object.fromEntries(recent)))
}

export function draftRootPaths(draft: TaskDraft): string[] {
  return [...new Set([...draft.directories.map((item) => item.path), ...draft.attachments.map((item) => item.rootPath)].filter((path): path is string => Boolean(path)))]
}

export function recentWorkDirectories(owner: string): AuthorizedLocalDirectory[] {
  try {
    const items: AuthorizedLocalDirectory[] = JSON.parse(localStorage.getItem(`xiaoyin.recent-directories.${owner}`) ?? '[]')
    return Array.isArray(items) ? items.filter((item) => item && typeof item.path === 'string' && typeof item.name === 'string' && typeof item.id === 'string').slice(0, 8) : []
  } catch { return [] }
}
export function rememberWorkDirectory(owner: string, directory: AuthorizedLocalDirectory): void {
  if (!directory.path) return
  const items = [directory, ...recentWorkDirectories(owner).filter((item) => item.path !== directory.path)].slice(0, 8)
  localStorage.setItem(`xiaoyin.recent-directories.${owner}`, JSON.stringify(items))
}
