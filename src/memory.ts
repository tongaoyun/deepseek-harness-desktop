import { readServerData } from './serverResponse'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { resolveServerEndpoint } from './api'
import { normalizeMemory, relatedMemories } from './memoryEditing'

const operations = new Map<string, Promise<unknown>>()
function serialized<T>(owner: string, action: () => Promise<T>): Promise<T> {
  const pending = (operations.get(owner) ?? Promise.resolve()).catch(() => undefined).then(action)
  operations.set(owner, pending)
  void pending.finally(() => { if (operations.get(owner) === pending) operations.delete(owner) }).catch(() => undefined)
  return pending
}

export interface MemoryProfile {
  enabled: boolean
  collaborationStyle: string
  workManual: string
  updatedAt?: string
  automaticMemory?: boolean
  entries?: MemoryEntry[]
  syncPending?: boolean
  version?: number
  syncConflict?: boolean
}

export interface MemoryEntry {
  id: string
  kind: 'preference' | 'fact'
  text: string
  source: string
  taskId: string
  updatedAt: string
}

export const memorySaveMessage = (profile: MemoryProfile) => profile.syncConflict
  ? '本机修改已保留，但云端有另一份更新。请在记忆设置中选择版本，未自动覆盖。'
  : profile.syncPending
  ? '已在本机生效，云端同步未完成；可稍后点击保存重试。'
  : '已保存并同步，后续任务将按需使用这些记忆。'

export function validateMemoryProfile(value: unknown): asserts value is MemoryProfile {
  const profile = value as MemoryProfile | undefined
  if (!profile || typeof profile.enabled !== 'boolean' || typeof profile.collaborationStyle !== 'string' || typeof profile.workManual !== 'string'
    || profile.collaborationStyle.length > 8000 || profile.workManual.length > 16000
    || (profile.version !== undefined && (!Number.isSafeInteger(profile.version) || profile.version < 0))
    || (profile.automaticMemory !== undefined && typeof profile.automaticMemory !== 'boolean')
    || (profile.entries !== undefined && (!Array.isArray(profile.entries) || profile.entries.length > 100))) throw new Error('记忆文件格式或长度无效')
  const ids = new Set<string>()
  for (const entry of profile.entries ?? []) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 100 || ids.has(entry.id)
      || !['preference', 'fact'].includes(entry.kind) || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 800
      || typeof entry.source !== 'string' || entry.source.length > 120 || typeof entry.taskId !== 'string' || entry.taskId.length > 200
      || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error('记忆条目格式无效')
    ids.add(entry.id)
  }
}

export interface MemoryRevision {
  id: string
  savedAt: string
  profile: MemoryProfile
}

export const emptyMemoryProfile: MemoryProfile = {
  enabled: true,
  collaborationStyle: '',
  workManual: '',
  updatedAt: '',
  automaticMemory: false,
  entries: [],
}

export async function loadMemoryProfile(employeeId: string): Promise<MemoryProfile> {
  if (!isTauri()) return emptyMemoryProfile
  return invoke<MemoryProfile>('load_memory_profile', { employeeId })
}

export async function saveMemoryProfile(employeeId: string, profile: MemoryProfile): Promise<MemoryProfile> {
  if (!isTauri()) throw new Error('记忆设置只能在小胤桌面客户端中保存')
  const current = await loadMemoryProfile(employeeId)
  return cacheMemoryProfile(employeeId, { ...profile, updatedAt: new Date(Math.max(Date.now(), timestamp(current.updatedAt) + 1)).toISOString(), syncPending: true })
}

export async function loadMemoryHistory(employeeId: string): Promise<MemoryRevision[]> {
  if (!isTauri()) return []
  return invoke<MemoryRevision[]>('load_memory_history', { employeeId })
}

export async function loadSyncedMemoryProfile(
  employeeId: string,
  endpoint: string,
  accessToken: string,
): Promise<MemoryProfile> {
  return serialized(employeeId, () => loadSyncedProfile(employeeId, endpoint, accessToken))
}

async function loadSyncedProfile(employeeId: string, endpoint: string, accessToken: string): Promise<MemoryProfile> {
  const local = await loadMemoryProfile(employeeId)
  const remote = await requestMemoryProfile(endpoint, employeeId, accessToken).catch(() => undefined)
  if (local.syncPending) {
    if (remote && memoryContents(remote) === memoryContents(local)) return cacheMemoryProfile(employeeId, { ...remote, syncPending: false, syncConflict: false })
    if (remote && (remote.version ?? 0) !== (local.version ?? 0)) return cacheMemoryProfile(employeeId, { ...local, syncConflict: true })
    return local
  }
  const localTime = timestamp(local.updatedAt)
  const remoteTime = timestamp(remote?.updatedAt)
  if (remote && ((remote.version ?? 0) > (local.version ?? 0) || remoteTime > localTime)) {
    if (isTauri()) await cacheMemoryProfile(employeeId, remote)
    return remote
  }
  if (localTime > remoteTime) return local
  if (remote) {
    if (isTauri()) await cacheMemoryProfile(employeeId, remote)
    return remote
  }
  return local
}

async function cacheMemoryProfile(employeeId: string, profile: MemoryProfile): Promise<MemoryProfile> {
  if (!isTauri()) return profile
  const saved = await invoke<MemoryProfile>('save_memory_profile', { employeeId, profile })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('xiaoyin:memory-updated', { detail: { employeeId, profile: saved } }))
  return saved
}

export function memoryContents(profile: MemoryProfile): string {
  return JSON.stringify([profile.enabled, profile.automaticMemory ?? false, profile.collaborationStyle, profile.workManual, profile.entries ?? []])
}

class MemorySyncConflict extends Error {}

async function syncPendingProfile(employeeId: string, endpoint: string, accessToken: string, local: MemoryProfile): Promise<MemoryProfile> {
  if (local.syncConflict) return local
  try {
    const remote = await putMemoryProfile(endpoint, employeeId, accessToken, local)
    return await cacheMemoryProfile(employeeId, { ...remote, syncPending: false, syncConflict: false })
  } catch (error) {
    if (error instanceof MemorySyncConflict) {
      // A timed-out PUT may already have succeeded. A retry must not create a false conflict.
      const remote = await requestMemoryProfile(endpoint, employeeId, accessToken).catch(() => undefined)
      if (remote && memoryContents(remote) === memoryContents(local)) return cacheMemoryProfile(employeeId, { ...remote, syncPending: false, syncConflict: false })
      return cacheMemoryProfile(employeeId, { ...local, syncConflict: true })
    }
    return local
  }
}

export async function syncMemoryProfile(employeeId: string, endpoint: string, accessToken: string): Promise<MemoryProfile> {
  return serialized(employeeId, async () => {
    const local = await loadMemoryProfile(employeeId)
    return local.syncPending ? syncPendingProfile(employeeId, endpoint, accessToken, local) : loadSyncedProfile(employeeId, endpoint, accessToken)
  })
}

export async function resolveMemoryConflict(employeeId: string, endpoint: string, accessToken: string, useLocal: boolean, expectedLocalUpdatedAt?: string): Promise<MemoryProfile> {
  return serialized(employeeId, async () => {
    const local = await loadMemoryProfile(employeeId)
    if (local.updatedAt !== expectedLocalUpdatedAt) throw new Error('本机记忆又有更新，请重新读取后选择版本')
    const remote = await requestMemoryProfile(endpoint, employeeId, accessToken)
    if (!useLocal) return cacheMemoryProfile(employeeId, { ...remote, syncPending: false, syncConflict: false })
    const next = await cacheMemoryProfile(employeeId, { ...local, version: remote.version ?? 0, syncPending: true, syncConflict: false })
    return syncPendingProfile(employeeId, endpoint, accessToken, next)
  })
}

function timestamp(value: string | undefined): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

export async function saveSyncedMemoryProfile(
  employeeId: string,
  endpoint: string,
  accessToken: string,
  profile: MemoryProfile,
): Promise<MemoryProfile> {
  return serialized(employeeId, () => saveSyncedProfile(employeeId, endpoint, accessToken, profile))
}

async function saveSyncedProfile(employeeId: string, endpoint: string, accessToken: string, profile: MemoryProfile): Promise<MemoryProfile> {
  validateMemoryProfile(profile)
  const latest = await loadMemoryProfile(employeeId)
  if (latest.updatedAt && latest.updatedAt !== profile.updatedAt) throw new Error('记忆已被其他任务更新，请重新读取后再修改；当前输入仍保留。')
  const local = await saveMemoryProfile(employeeId, profile)
  return syncPendingProfile(employeeId, endpoint, accessToken, local)
}

export function memoryInstruction(input: string): string {
  const command = parseMemoryCommand(input)
  return command?.action === 'remember' ? command.text : ''
}

export function parseMemoryCommand(input: string): { action: 'remember' | 'forget' | 'replace'; text: string; replacement?: string } | undefined {
  const replacement = input.trim().match(/^(?:请)?(?:把|将)(?:记忆[：:]?)?(.+?)(?:改成|改为|替换为)[：:]?(.+)$/s)
  if (replacement && (/记忆|刚才那条|刚才说的/.test(input))) return { action: 'replace', text: replacement[1].trim(), replacement: replacement[2].trim().replace(/[。！!]+$/, '') }
  const match = input.trim().match(/^(?:请|帮我)?(记住|记一下|忘记|删除记忆)\s*[：:，,]?\s*(.+)$/s)
  if (!match) return undefined
  const text = match[2].trim().replace(/[。！!]+$/, '')
  // Ambiguous references need a normal conversation, never guess which memory to delete.
  if (!text || (['记住', '记一下'].includes(match[1]) && /^(这个|这件事|这些|它|刚才说的|一下)$/.test(text))) return undefined
  return { action: ['忘记', '删除记忆'].includes(match[1]) ? 'forget' : 'remember', text }
}

export function upsertMemoryEntry(profile: MemoryProfile, text: string, source: string, taskId: string, kind: MemoryEntry['kind'] = 'fact'): MemoryProfile {
  const normalized = text.trim()
  if (!normalized || normalized.length > 800) throw new Error('每条记忆需要 1–800 个字')
  const entries = profile.entries ?? []
  if (entries.some((entry) => normalizeMemory(entry.text) === normalizeMemory(normalized))) return profile
  if (entries.length >= 100) throw new Error('已达到 100 条记忆，请先整理后再添加')
  return { ...profile, entries: [...entries, { id: crypto.randomUUID(), kind, text: normalized, source: source.slice(0, 120), taskId, updatedAt: new Date().toISOString() }] }
}

export function automaticMemoryCandidate(input: string): string | undefined {
  // Only user-declared durable preferences, not model conclusions, quoted documents or temporary requests.
  const value = input.trim()
  if (value.length > 300 || /[\n`“”"「」]|这次|本次|今天|暂时|如果|假设|例如|比如|不要记|别记|密码|密钥|token|api.?key/i.test(value)) return undefined
  return /^(我习惯|我偏好|我的偏好是|以后请|以后都|今后请|默认请).{2,}/.test(value) ? value : undefined
}

export async function learnCompletedTask(employeeId: string, endpoint: string, accessToken: string, input: string, taskId: string): Promise<MemoryProfile | undefined> {
  const text = automaticMemoryCandidate(input)
  if (!text) return undefined
  return serialized(employeeId, async () => {
    const current = await loadMemoryProfile(employeeId)
    if (!current.enabled || !current.automaticMemory) return undefined
    if ((current.entries ?? []).some((entry) => normalizeMemory(entry.text) === normalizeMemory(text))) return undefined
    if (relatedMemories(current.entries ?? [], text).length) throw new Error('这条偏好与已有记忆相似，请在记忆设置中确认是否替换')
    const next = upsertMemoryEntry(current, text, '自动记忆 · 用户明确偏好', taskId, 'preference')
    if (next === current) return undefined
    return saveSyncedProfile(employeeId, endpoint, accessToken, next)
  })
}

export async function changeMemoryEntry(employeeId: string, endpoint: string, accessToken: string, entry: MemoryEntry, replacement?: string): Promise<MemoryProfile> {
  return serialized(employeeId, async () => {
    const current = await loadSyncedProfile(employeeId, endpoint, accessToken)
    if (!current.entries?.some((item) => item.id === entry.id && item.text === entry.text && item.updatedAt === entry.updatedAt)) throw new Error('这条记忆已更新，请重新选择')
    const entries = replacement === undefined ? current.entries.filter((item) => item.id !== entry.id)
      : current.entries.map((item) => item.id === entry.id ? { ...item, text: replacement.trim(), source: '用户对话修改', updatedAt: new Date().toISOString() } : item)
    return saveSyncedProfile(employeeId, endpoint, accessToken, { ...current, entries })
  })
}

export async function forgetInstruction(employeeId: string, endpoint: string, accessToken: string, text: string): Promise<MemoryProfile> {
  return serialized(employeeId, async () => {
    const current = await loadSyncedProfile(employeeId, endpoint, accessToken)
    const entries = (current.entries ?? []).filter((entry) => entry.text !== text)
    if (entries.length === (current.entries ?? []).length) throw new Error('没有找到完全匹配的记忆，请在设置 → 记忆中选择要删除的条目。')
    return saveSyncedProfile(employeeId, endpoint, accessToken, { ...current, entries })
  })
}

export async function rememberInstruction(
  employeeId: string,
  endpoint: string,
  accessToken: string,
  instruction: string,
  taskId = '',
): Promise<MemoryProfile> {
  return serialized(employeeId, async () => {
    const current = await loadSyncedProfile(employeeId, endpoint, accessToken)
    return saveSyncedProfile(employeeId, endpoint, accessToken, upsertMemoryEntry(current, instruction, '用户主动记住', taskId))
  })
}

async function requestMemoryProfile(endpoint: string, employeeId: string, accessToken: string): Promise<MemoryProfile> {
  const response = await fetch(resolveServerEndpoint(endpoint), {
    signal: AbortSignal.timeout(10_000),
    headers: enterpriseHeaders(employeeId, accessToken),
  })
  if (!response.ok) throw new Error(`记忆同步返回 ${response.status}`)
  const profile: unknown = await readServerData(response)
  validateMemoryProfile(profile)
  return profile
}

async function putMemoryProfile(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  profile: MemoryProfile,
): Promise<MemoryProfile> {
  const response = await fetch(resolveServerEndpoint(endpoint), {
    signal: AbortSignal.timeout(10_000),
    method: 'PUT', headers: { ...enterpriseHeaders(employeeId, accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: profile.enabled, collaborationStyle: profile.collaborationStyle, workManual: profile.workManual, automaticMemory: profile.automaticMemory ?? false, entries: profile.entries ?? [], expectedVersion: profile.version ?? 0 }),
  })
  if (response.status === 409) throw new MemorySyncConflict('记忆版本冲突')
  if (!response.ok) throw new Error(`记忆同步返回 ${response.status}`)
  const saved: unknown = await readServerData(response)
  validateMemoryProfile(saved)
  return saved
}

function enterpriseHeaders(employeeId: string, accessToken: string): Record<string, string> {
  return {
    'X-Xiaoyin-Employee-Id': employeeId,
    'X-Requested-With': 'XMLHttpRequest',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  }
}
