import { invoke, isTauri } from '@tauri-apps/api/core'
import type { ConnectorCatalogEntry } from './types'

export interface ConnectorSecretValues {
  environment: Record<string, string>
  headers: Record<string, string>
}

export type ConnectorSecretStore = Record<string, ConnectorSecretValues>

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
  if (isTauri()) {
    return normalizeStore(await invoke<ConnectorSecretStore>('load_connector_secrets', { employeeId }))
  }
  return browserSessionSecrets.get(employeeId) ?? {}
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
