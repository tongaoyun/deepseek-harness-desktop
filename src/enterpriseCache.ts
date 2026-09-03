import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ConnectorCatalogEntry, ExpertKitCatalogEntry, KnowledgeBaseEntry, SkillCatalogEntry } from './types'
import { connectorSecretTemplate } from './connectorSecrets'

export const ENTERPRISE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

export interface EnterpriseCatalogCache {
  savedAt: string
  catalog: ExpertKitCatalogEntry[]
  skills: SkillCatalogEntry[]
  connectors: ConnectorCatalogEntry[]
  knowledge: KnowledgeBaseEntry[]
}

export async function loadEnterpriseCatalogCache(employeeId: string): Promise<EnterpriseCatalogCache | undefined> {
  if (isTauri()) {
    const cache = (await invoke<EnterpriseCatalogCache | null>('load_enterprise_catalog_cache', { employeeId })) ?? undefined
    return cache ? withoutConnectorSecrets(cache) : undefined
  }
  try {
    const value = JSON.parse(window.localStorage.getItem(key(employeeId)) ?? 'null')
    return isCache(value) ? withoutConnectorSecrets(value) : undefined
  } catch {
    return undefined
  }
}

export async function saveEnterpriseCatalogCache(employeeId: string, cache: EnterpriseCatalogCache): Promise<void> {
  const sanitized = withoutConnectorSecrets(cache)
  if (isTauri()) {
    await invoke('save_enterprise_catalog_cache', { employeeId, cache: sanitized })
    return
  }
  window.localStorage.setItem(key(employeeId), JSON.stringify(sanitized))
}

export function cacheAge(savedAt: string, now = Date.now()): { stale: boolean; ageDays: number } {
  const timestamp = Date.parse(savedAt)
  if (!Number.isFinite(timestamp)) return { stale: true, ageDays: Number.POSITIVE_INFINITY }
  const age = Math.max(0, now - timestamp)
  return { stale: age > ENTERPRISE_CACHE_MAX_AGE_MS, ageDays: Math.floor(age / 86_400_000) }
}

function isCache(value: unknown): value is EnterpriseCatalogCache {
  if (!value || typeof value !== 'object') return false
  const cache = value as Partial<EnterpriseCatalogCache>
  return typeof cache.savedAt === 'string' && Array.isArray(cache.catalog) && Array.isArray(cache.skills)
    && Array.isArray(cache.connectors) && Array.isArray(cache.knowledge)
}

function key(employeeId: string) { return `xiaoyin.enterprise-catalog.${employeeId}` }

function withoutConnectorSecrets(cache: EnterpriseCatalogCache): EnterpriseCatalogCache {
  return { ...cache, connectors: cache.connectors.map(connectorSecretTemplate) }
}
