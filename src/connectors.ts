import type { ConnectorCatalogEntry, ConnectorRuntimeDefinition } from './types'

const DESKTOP_BROWSER: ConnectorCatalogEntry = {
  id: 'desktop-browser',
  name: '浏览器',
  summary: '使用独立的 Chrome 或 Edge 会话打开网页、读取语义结构、点击、输入并截图。',
  kind: 'desktop-builtin',
  scope: 'DEVICE',
  status: 'ready',
  managed: true,
  version: '1',
  transport: 'desktop',
  authMode: 'none',
  toolNames: ['browser_open', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot'],
}

export function withDesktopBuiltinConnectors(connectors: ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return [DESKTOP_BROWSER, ...connectors.filter((connector) => connector.id !== DESKTOP_BROWSER.id)]
}

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
