import type { ConnectorCatalogEntry, ConnectorRuntimeDefinition } from './types'
import { applyConnectorSecrets, missingConnectorSecretKeys, type ConnectorSecretStore } from './connectorSecrets'

const DESKTOP_BROWSER: ConnectorCatalogEntry = {
  id: 'desktop-browser',
  name: '浏览器',
  summary: '使用独立的 Chrome 或 Edge 会话打开网页、读取语义结构、点击、输入并截图。',
  category: 'recommended-system',
  kind: 'desktop-builtin',
  scope: 'DEVICE',
  status: 'ready',
  managed: true,
  version: '1',
  transport: 'desktop',
  authMode: 'none',
  toolNames: [
    'browser_open', 'browser_snapshot', 'browser_tabs', 'browser_switch_tab', 'browser_close_tab',
    'browser_click', 'browser_click_text', 'browser_click_point', 'browser_type', 'browser_select',
    'browser_scroll', 'browser_back', 'browser_reload', 'browser_press_key', 'browser_wait_for',
    'browser_downloads', 'browser_human_takeover', 'browser_screenshot',
  ],
  command: '', arguments: [], environment: {}, headers: {},
}

export function withDesktopBuiltinConnectors(connectors: ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return [DESKTOP_BROWSER, ...connectors.filter((connector) => connector.id !== DESKTOP_BROWSER.id)]
}

export function buildRuntimeConnectorCatalog(
  connectors: ConnectorCatalogEntry[],
  legacyErpMcpUrl: string,
  enabledConnectorIds: Iterable<string> = [],
  localSecrets: ConnectorSecretStore = {},
): ConnectorRuntimeDefinition[] {
  const enabled = new Set(enabledConnectorIds)
  return connectors.map((connector) => {
    const configured = applyConnectorSecrets(connector, localSecrets[connector.id])
    const legacyErp = connector.id === 'erp-mcp' && !connector.transport && Boolean(legacyErpMcpUrl)
      && !['disabled', 'unavailable'].includes(connector.status)
    const status = legacyErp ? 'ready' : connector.status
    return {
      id: connector.id,
      name: connector.name,
      status: status === 'ready' && missingConnectorSecretKeys(configured).length > 0 ? 'needs-configuration' : status,
      version: connector.version || '1',
      transport: connector.transport
        ?? (connector.kind === 'desktop-builtin' ? 'desktop' : 'streamable-http'),
      url: connector.url || (legacyErp ? legacyErpMcpUrl : ''),
      authMode: connector.authMode ?? (legacyErp ? 'employee-bearer' : 'none'),
      toolNames: [...new Set(connector.toolNames)],
      command: configured.command ?? '',
      arguments: configured.arguments ?? [],
      environment: configured.environment ?? {},
      headers: configured.headers ?? {},
      timeoutSeconds: configured.timeoutSeconds,
      enabled: enabled.has(connector.id),
    }
  })
}
