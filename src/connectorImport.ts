import { connectorCategories } from './extensionCategories'
import type { ConnectorCatalogEntry, ConnectorTransport } from './types'

export interface ConnectorImportItem {
  name: string
  connector?: ConnectorCatalogEntry
  error?: string
}

export async function persistBundledConnectors(
  value: unknown,
  knownIds: Iterable<string>,
  persist: (connector: ConnectorCatalogEntry) => Promise<void>,
): Promise<string[]> {
  const known = new Set(knownIds)
  const failures: string[] = []
  for (const item of parseConnectorImport(JSON.stringify(value))) {
    if (!item.connector) {
      failures.push(`${item.name}：${item.error}`)
      continue
    }
    if (known.has(item.connector.id)) continue
    try {
      await persist({ ...item.connector, readOnlyTools: [] })
      known.add(item.connector.id)
    } catch (error) {
      failures.push(`${item.name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

/** Parse each server independently so one invalid entry cannot hide the others. */
export function parseConnectorImport(value: string): ConnectorImportItem[] {
  const parsed = object(JSON.parse(value), '配置')
  const entries = 'mcpServers' in parsed
    ? Object.entries(object(parsed.mcpServers, 'mcpServers'))
    : [[String(parsed.id ?? parsed.name ?? ''), parsed] as const]
  if (!entries.length) throw new Error('mcpServers 中没有服务')
  const ids = new Set<string>()
  return entries.map(([key, value]) => {
    let name = key || '未命名服务'
    try {
      const config = object(value, name)
      if (config.readOnlyTools !== undefined) throw new Error('readOnlyTools 由 MCP ToolSpec 注解生成，不能在连接器清单中填写')
      name = optionalText(config.name, 'name') || key
      if (!name.trim()) throw new Error('请填写服务名称或 ID')
      const id = connectorId(optionalText(config.id, 'id') || key || name)
      if (ids.has(id)) throw new Error('与本次导入的其他服务 ID 重复，请修改名称或 ID')
      const transport = normalizeTransport(config.transport ?? config.type, config.command, config.url)
      const command = optionalText(config.command, 'command')
      const url = optionalText(config.url, 'url')
      if (transport === 'stdio' && !command) throw new Error('STDIO 服务必须包含 command')
      if (transport !== 'stdio') {
        if (!url) throw new Error('Streamable HTTP 服务必须包含 url')
        let endpoint: URL
        try { endpoint = new URL(url) } catch { throw new Error('url 必须是完整的 HTTP(S) 地址') }
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('url 必须使用 HTTP 或 HTTPS')
      }
      const category = connectorCategories.find((item) => item.id === config.category)?.id ?? 'other'
      const authMode = config.authMode ?? 'none'
      if (authMode !== 'none' && authMode !== 'employee-bearer' && authMode !== 'erp-cookie' && authMode !== 'oauth') throw new Error('不支持的认证方式')
      const headers = record(config.headers, 'headers')
      if (authMode === 'oauth') {
        const endpoint = new URL(url)
        if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) throw new Error('OAuth 地址必须使用 HTTPS')
        if (endpoint.username || endpoint.password || endpoint.hash) throw new Error('OAuth 地址不能包含凭据或片段')
      }
      if (authMode === 'erp-cookie' || authMode === 'oauth') {
        if (transport === 'stdio') throw new Error('动态授权仅支持 Streamable HTTP 连接器')
        if (Object.keys(headers).some((key) => ['cookie', 'authorization'].includes(key.toLowerCase()))) throw new Error('ERP 扫码会话不能同时配置 Cookie 或 Authorization 请求头')
      }
      const timeoutSeconds = config.timeoutSeconds
      if (timeoutSeconds !== undefined && (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)) throw new Error('timeoutSeconds 必须是 1–600 之间的整数')
      const connector: ConnectorCatalogEntry = {
        ...(timeoutSeconds !== undefined ? { timeoutSeconds: timeoutSeconds as number } : {}),
        id, name: name.trim(), category,
        summary: optionalText(config.summary, 'summary') || `个人 MCP 连接器 · ${name.trim()}`,
        kind: 'personal-mcp', scope: 'PERSONAL', status: 'ready', managed: false,
        version: optionalText(config.version, 'version') || '1.0.0', transport,
        url: transport === 'stdio' ? '' : url, authMode, command,
        arguments: strings(config.args ?? config.arguments, 'args'),
        environment: record(config.env ?? config.environment, 'env'),
        headers,
        toolNames: strings(config.toolNames, 'toolNames'),
        readOnlyTools: [],
      }
      ids.add(id)
      return { name, connector }
    } catch (reason) {
      return { name, error: reason instanceof Error ? reason.message : String(reason) }
    }
  })
}

export function parseConnectorJson(value: string): ConnectorCatalogEntry {
  const items = parseConnectorImport(value)
  if (items.length !== 1) throw new Error('配置包含多个服务，请使用批量导入')
  const item = items[0]!
  if (!item.connector) throw new Error(item.error)
  return item.connector
}

/** Keep portable IDs as-is; derive stable IDs for display names, including Chinese. */
export function connectorId(name: string): string {
  const value = name.trim()
  if (/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) return value
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619)
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mcp'
  return `${slug}-${(hash >>> 0).toString(36)}`
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`)
  return value as Record<string, unknown>
}

function optionalText(value: unknown, label: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`)
  return value.trim()
}

function strings(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} 必须是字符串数组`)
  return value
}

function record(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {}
  return Object.fromEntries(Object.entries(object(value, label)).map(([key, item]) => {
    if (typeof item !== 'string') throw new Error(`${label}.${key} 必须是字符串`)
    return [key, item]
  }))
}

function normalizeTransport(value: unknown, command: unknown, url: unknown): ConnectorTransport {
  if (value === 'streamable-http' || value === 'stdio') return value
  if (value === 'http') return 'streamable-http'
  if (value !== undefined) throw new Error(`不支持的服务类型：${String(value)}`)
  if (command) return 'stdio'
  if (url) return 'streamable-http'
  return 'stdio'
}
