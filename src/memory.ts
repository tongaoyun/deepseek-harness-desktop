import { invoke, isTauri } from '@tauri-apps/api/core'
import { resolveControlPlaneEndpoint } from './api'

export interface MemoryProfile {
  enabled: boolean
  collaborationStyle: string
  workManual: string
  updatedAt?: string
}

export const emptyMemoryProfile: MemoryProfile = {
  enabled: true,
  collaborationStyle: '',
  workManual: '',
  updatedAt: '',
}

export async function loadMemoryProfile(employeeId: string): Promise<MemoryProfile> {
  if (!isTauri()) return emptyMemoryProfile
  return invoke<MemoryProfile>('load_memory_profile', { employeeId })
}

export async function saveMemoryProfile(employeeId: string, profile: MemoryProfile): Promise<MemoryProfile> {
  if (!isTauri()) throw new Error('记忆设置只能在小胤桌面客户端中保存')
  return cacheMemoryProfile(employeeId, { ...profile, updatedAt: new Date().toISOString() })
}

export async function loadSyncedMemoryProfile(
  employeeId: string,
  endpoint: string,
  accessToken: string,
): Promise<MemoryProfile> {
  const local = await loadMemoryProfile(employeeId)
  const remote = await requestMemoryProfile(endpoint, employeeId, accessToken).catch(() => undefined)
  const localHasContent = Boolean(local.collaborationStyle.trim() || local.workManual.trim())
  const localTime = timestamp(local.updatedAt)
  const remoteTime = timestamp(remote?.updatedAt)
  if (remote && remoteTime > localTime) {
    if (isTauri()) await cacheMemoryProfile(employeeId, remote)
    return remote
  }
  if (localHasContent && (!remote || localTime >= remoteTime)) {
    const saved = await putMemoryProfile(endpoint, employeeId, accessToken, local).catch(() => undefined)
    if (saved && isTauri()) await cacheMemoryProfile(employeeId, saved)
    return saved ?? local
  }
  if (remote) {
    if (isTauri()) await cacheMemoryProfile(employeeId, remote)
    return remote
  }
  return local
}

async function cacheMemoryProfile(employeeId: string, profile: MemoryProfile): Promise<MemoryProfile> {
  if (!isTauri()) return profile
  return invoke<MemoryProfile>('save_memory_profile', { employeeId, profile })
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
  const local = await saveMemoryProfile(employeeId, profile)
  const remote = await putMemoryProfile(endpoint, employeeId, accessToken, local)
  return cacheMemoryProfile(employeeId, remote)
}

export function memoryInstruction(input: string): string {
  return input.match(/^记住\s*[：:]\s*(.+)$/s)?.[1]?.trim() ?? ''
}

export async function rememberInstruction(
  employeeId: string,
  endpoint: string,
  accessToken: string,
  instruction: string,
): Promise<MemoryProfile> {
  const current = await loadSyncedMemoryProfile(employeeId, endpoint, accessToken)
  if (current.workManual.split('\n').map((value) => value.trim()).includes(instruction)) return current
  const workManual = [current.workManual.trim(), instruction].filter(Boolean).join('\n')
  if (workManual.length > 16_000) throw new Error('工作手册已达到 16000 字上限，请先整理后再记忆')
  return saveSyncedMemoryProfile(employeeId, endpoint, accessToken, { ...current, enabled: true, workManual })
}

async function requestMemoryProfile(endpoint: string, employeeId: string, accessToken: string): Promise<MemoryProfile> {
  const response = await fetch(resolveControlPlaneEndpoint(endpoint), {
    headers: enterpriseHeaders(employeeId, accessToken),
  })
  if (!response.ok) throw new Error(`记忆同步返回 ${response.status}`)
  return response.json() as Promise<MemoryProfile>
}

async function putMemoryProfile(
  endpoint: string,
  employeeId: string,
  accessToken: string,
  profile: MemoryProfile,
): Promise<MemoryProfile> {
  const response = await fetch(resolveControlPlaneEndpoint(endpoint), {
    method: 'PUT', headers: { ...enterpriseHeaders(employeeId, accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  })
  if (!response.ok) throw new Error(`记忆同步返回 ${response.status}`)
  return response.json() as Promise<MemoryProfile>
}

function enterpriseHeaders(employeeId: string, accessToken: string): Record<string, string> {
  return {
    'X-Xiaoyin-Employee-Id': employeeId,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  }
}
