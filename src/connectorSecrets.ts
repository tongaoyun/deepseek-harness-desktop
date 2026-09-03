import type { ConnectorCatalogEntry } from './types'

export interface ConnectorSecretValues {
  environment: Record<string, string>
  headers: Record<string, string>
}

export type ConnectorSecretStore = Record<string, ConnectorSecretValues>

const PREFIX = 'xiaoyin.connector-secrets.'

export function connectorSecretTemplate(connector: ConnectorCatalogEntry): ConnectorCatalogEntry {
  return {
    ...connector,
    environment: emptyValues(connector.environment),
    headers: emptyValues(connector.headers),
  }
}

export function connectorSecretValues(connector: ConnectorCatalogEntry): ConnectorSecretValues {
  return {
    environment: { ...(connector.environment ?? {}) },
    headers: { ...(connector.headers ?? {}) },
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

export function loadConnectorSecrets(employeeId: string): ConnectorSecretStore {
  if (!employeeId) return {}
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`${PREFIX}${employeeId}`) ?? '{}')
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      if (!isRecord(value)) return []
      return [[id, {
        environment: stringRecord(value.environment),
        headers: stringRecord(value.headers),
      }]]
    }))
  } catch {
    return {}
  }
}

export function saveConnectorSecrets(
  employeeId: string,
  connectorId: string,
  values: ConnectorSecretValues,
): ConnectorSecretStore {
  const store = { ...loadConnectorSecrets(employeeId), [connectorId]: values }
  window.localStorage.setItem(`${PREFIX}${employeeId}`, JSON.stringify(store))
  return store
}

export function deleteConnectorSecrets(employeeId: string, connectorId: string): ConnectorSecretStore {
  const store = loadConnectorSecrets(employeeId)
  delete store[connectorId]
  window.localStorage.setItem(`${PREFIX}${employeeId}`, JSON.stringify(store))
  return store
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
