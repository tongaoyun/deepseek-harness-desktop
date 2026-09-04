import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ConnectorCatalogEntry } from './types'

export interface ConnectorSecretValues {
  environment: Record<string, string>
  headers: Record<string, string>
}

export type ConnectorSecretStore = Record<string, ConnectorSecretValues>

const PREFIX = 'xiaoyin.connector-secrets.'
const browserSessionSecrets = new Map<string, ConnectorSecretStore>()

export function connectorSecretTemplate(connector: ConnectorCatalogEntry): ConnectorCatalogEntry {
  return {
    ...connector,
    environment: emptyValues(connector.environment),
    headers: emptyValues(connector.headers),
  }
}

export function connectorSecretValues(connector: ConnectorCatalogEntry): ConnectorSecretValues {
  return {
    environment: { ...connector.environment },
    headers: { ...connector.headers },
  }
}

export function applyConnectorSecrets(
  connector: ConnectorCatalogEntry,
  secrets?: ConnectorSecretValues,
): ConnectorCatalogEntry {
  return {
    ...connector,
    environment: overlayValues(connector.environment, secrets?.environment),
    headers: overlayValues(connector.headers, secrets?.headers),
  }
}

export function missingConnectorSecretKeys(
  connector: Pick<ConnectorCatalogEntry, 'environment' | 'headers'>,
  secrets?: ConnectorSecretValues,
): string[] {
  const environment = overlayValues(connector.environment, secrets?.environment)
  const headers = overlayValues(connector.headers, secrets?.headers)
  return [
    ...Object.entries(environment).filter(([, value]) => !value.trim()).map(([key]) => `环境变量 ${key}`),
    ...Object.entries(headers).filter(([, value]) => !value.trim()).map(([key]) => `Header ${key}`),
  ]
}

export async function loadConnectorSecrets(employeeId: string): Promise<ConnectorSecretStore> {
  if (!employeeId) return {}
  const legacy = mergeStores(browserSessionSecrets.get(employeeId) ?? {}, loadLegacySecrets(employeeId))
  if (isTauri()) {
    const stored = Object.keys(legacy).length > 0
      ? await invoke<ConnectorSecretStore>('migrate_connector_secrets', { employeeId, legacy })
      : await invoke<ConnectorSecretStore>('load_connector_secrets', { employeeId })
    if (Object.keys(legacy).length > 0) clearLegacySecrets(employeeId)
    return normalizeStore(stored)
  }
  browserSessionSecrets.set(employeeId, legacy)
  clearLegacySecrets(employeeId)
  return legacy
}

export async function saveConnectorSecrets(
  employeeId: string,
  connectorId: string,
  values: ConnectorSecretValues,
): Promise<ConnectorSecretStore> {
  if (isTauri()) {
    return normalizeStore(await invoke<ConnectorSecretStore>('save_connector_secret', {
      employeeId, connectorId, values: normalizeValues(values),
    }))
  }
  const store = { ...browserSessionSecrets.get(employeeId), [connectorId]: normalizeValues(values) }
  browserSessionSecrets.set(employeeId, store)
  return store
}

export async function deleteConnectorSecrets(employeeId: string, connectorId: string): Promise<ConnectorSecretStore> {
  if (isTauri()) {
    return normalizeStore(await invoke<ConnectorSecretStore>('delete_connector_secret', { employeeId, connectorId }))
  }
  const store = { ...browserSessionSecrets.get(employeeId) }
  delete store[connectorId]
  browserSessionSecrets.set(employeeId, store)
  return store
}

function loadLegacySecrets(employeeId: string): ConnectorSecretStore {
  const stored = loadStoredSecrets(employeeId)
  const drafts = personalConnectorSecrets(employeeId)
  return mergeStores(stored, drafts)
}

function loadStoredSecrets(employeeId: string): ConnectorSecretStore {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`${PREFIX}${employeeId}`) ?? '{}')
    return normalizeStore(parsed)
  } catch {
    return {}
  }
}

function personalConnectorSecrets(employeeId: string): ConnectorSecretStore {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`xiaoyin.personal-connectors.${employeeId}`) ?? '[]')
    if (!Array.isArray(parsed)) return {}
    return Object.fromEntries(parsed.flatMap((item) => {
      if (!isRecord(item) || typeof item.id !== 'string') return []
      const values = normalizeValues({ environment: stringRecord(item.environment), headers: stringRecord(item.headers) })
      return hasSecret(values) ? [[item.id, values]] : []
    }))
  } catch {
    return {}
  }
}

function clearLegacySecrets(employeeId: string): void {
  window.localStorage.removeItem(`${PREFIX}${employeeId}`)
  sanitizePersonalConnectorDrafts(employeeId)
}

function sanitizePersonalConnectorDrafts(employeeId: string): void {
  const key = `xiaoyin.personal-connectors.${employeeId}`
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(parsed)) return
    const sanitized = parsed.map((item) => isRecord(item) ? {
      ...item,
      environment: emptyValues(stringRecord(item.environment)),
      headers: emptyValues(stringRecord(item.headers)),
    } : item)
    window.localStorage.setItem(key, JSON.stringify(sanitized))
  } catch {
    // A malformed legacy draft is ignored; the catalog loader reports it separately.
  }
}

function mergeStores(current: ConnectorSecretStore, legacy: ConnectorSecretStore): ConnectorSecretStore {
  const merged = structuredClone(current)
  for (const [id, values] of Object.entries(legacy)) {
    const target = merged[id] ?? { environment: {}, headers: {} }
    merged[id] = {
      environment: { ...values.environment, ...target.environment },
      headers: { ...values.headers, ...target.headers },
    }
  }
  return merged
}

function normalizeStore(value: unknown): ConnectorSecretStore {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([id, item]) => {
    if (!isRecord(item)) return []
    return [[id, normalizeValues({ environment: stringRecord(item.environment), headers: stringRecord(item.headers) })]]
  }))
}

function normalizeValues(values: ConnectorSecretValues): ConnectorSecretValues {
  return { environment: stringRecord(values.environment), headers: stringRecord(values.headers) }
}

function hasSecret(values: ConnectorSecretValues): boolean {
  return [...Object.values(values.environment), ...Object.values(values.headers)].some(Boolean)
}

function emptyValues(values?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(values ?? {}).map((key) => [key, '']))
}

function overlayValues(template?: Record<string, string>, local?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(template ?? {}).map(([key, value]) => [key, local?.[key] ?? value]))
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
