import { invoke, isTauri } from '@tauri-apps/api/core'

export interface MemoryProfile {
  enabled: boolean
  collaborationStyle: string
  workManual: string
}

export const emptyMemoryProfile: MemoryProfile = {
  enabled: true,
  collaborationStyle: '',
  workManual: '',
}

export async function loadMemoryProfile(employeeId: string): Promise<MemoryProfile> {
  if (!isTauri()) return emptyMemoryProfile
  return invoke<MemoryProfile>('load_memory_profile', { employeeId })
}

export async function saveMemoryProfile(employeeId: string, profile: MemoryProfile): Promise<MemoryProfile> {
  if (!isTauri()) throw new Error('意识设置只能在小胤桌面客户端中保存')
  return invoke<MemoryProfile>('save_memory_profile', { employeeId, profile })
}
