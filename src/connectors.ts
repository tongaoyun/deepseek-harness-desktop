import type { ConnectorCatalogEntry, ConnectorRuntimeDefinition } from './types'

export function buildRuntimeConnectorCatalog(
  connectors: ConnectorCatalogEntry[],
  legacyErpMcpUrl: string,
): ConnectorRuntimeDefinition[] {
  return connectors.map((connector) => {
    const legacyErp = connector.id === 'erp-mcp' && !connector.transport && Boolean(legacyErpMcpUrl)
    return {
      id: connector.id,
      name: connector.name,
      status: legacyErp ? 'ready' : connector.status,
      version: connector.version || '1',
      transport: connector.transport
        ?? (connector.kind === 'desktop-builtin' ? 'desktop' : 'streamable-http'),
      url: connector.url || (legacyErp ? legacyErpMcpUrl : ''),
      authMode: connector.authMode ?? (legacyErp ? 'employee-bearer' : 'none'),
      toolNames: [...new Set(connector.toolNames)],
    }
  })
}
