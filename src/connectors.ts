import type { ConnectorCatalogEntry, ConnectorRuntimeDefinition } from './types'
import { applyConnectorSecrets, missingConnectorSecretKeys, type ConnectorSecretStore } from './connectorSecrets'

/** Internal connector ids are useful for execution, but are not a user-facing label. */
export function connectorDisplayName(connector: Pick<ConnectorCatalogEntry, 'id' | 'name'>): string {
  const name = connector.name.trim()
  if (!name || name === connector.id.trim()) return ''
  return name
}

export function buildRuntimeConnectorCatalog(
  connectors: ConnectorCatalogEntry[],
  enabledConnectorIds: Iterable<string> = [],
  localSecrets: ConnectorSecretStore = {},
): ConnectorRuntimeDefinition[] {
  const enabled = new Set(enabledConnectorIds)
  return connectors.map((connector) => {
    const configured = applyConnectorSecrets(connector, localSecrets[connector.id])
    const transport = connector.transport ?? 'streamable-http'
    const incomplete = !connector.transport
      || transport === 'stdio' && !configured.command?.trim()
      || transport === 'streamable-http' && (!connector.url?.trim() || !connector.authMode)
    return {
      id: connector.id,
      name: connector.name,
      status: connector.status === 'ready' && (incomplete || missingConnectorSecretKeys(configured).length > 0)
        ? 'needs-configuration'
        : connector.status,
      version: connector.version || '1',
      transport,
      url: connector.url ?? '',
      authMode: connector.authMode ?? 'none',
      toolNames: [...new Set(connector.toolNames)],
      readOnlyTools: [...new Set(connector.readOnlyTools ?? [])],
      command: configured.command ?? '',
      arguments: configured.arguments ?? [],
      environment: configured.environment ?? {},
      headers: configured.headers ?? {},
      timeoutSeconds: configured.timeoutSeconds,
      enabled: enabled.has(connector.id),
    }
  })
}
