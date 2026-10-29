import { createHash } from 'node:crypto'
import { ConnectorCatalogToolsSchema } from '@deepseek-harness/product/catalog'
import { objectRecord, stringField, stringList } from './response-fields.ts'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client'
import { z } from 'zod'

export interface DeepSeekHarnessConnector {
  readonly id: string
  readonly version: string
  readonly name: string
  readonly status: 'ready'
  readonly authMode: 'none' | 'employee-bearer' | 'oauth'
  readonly transport: 'streamable-http' | 'stdio'
  readonly url?: string
  readonly command?: string
  readonly arguments: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string>>
  readonly toolNames: readonly string[]
  readonly readOnlyTools: readonly string[]
  /** Per-operation MCP timeout in seconds; absent catalog values use 60. */
  readonly timeoutSeconds: number
}

export type ConnectorToolPolicy = 'unrelated' | 'read-only' | 'write' | 'undeclared'

export function parseConnectorCatalog(value: unknown): DeepSeekHarnessConnector[] {
  if (!Array.isArray(value)) throw new Error('deepseek-harness product: invalid connector catalog')
  const connectorIds = new Set<string>()
  return value.flatMap((entry) => {
    const record = objectRecord(entry, 'connector')
    const status = stringField(record, 'status')
    if (status !== 'ready') return []
    const authMode = stringField(record, 'authMode')
    if (!['none', 'employee-bearer', 'oauth'].includes(authMode)) {
      throw new Error(`deepseek-harness product: unsupported connector authentication ${authMode}`)
    }
    if (record.ready === false || authMode === 'oauth' && record.authorizationStatus !== 'AUTHORIZED') return []
    const transport = stringField(record, 'transport')
    if (transport !== 'streamable-http' && transport !== 'stdio') {
      throw new Error(`deepseek-harness product: unsupported connector transport ${transport}`)
    }
    const id = stringField(record, 'id')
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || connectorIds.has(id)) {
      throw new Error(`deepseek-harness product: invalid or duplicate connector id ${id}`)
    }
    connectorIds.add(id)
    const tools = connectorTools(record.tools)
    const toolNames = tools.map(tool => tool.name)
    if (toolNames.length === 0) return []
    const readOnlyTools = tools.filter(tool => tool.access === 'READ').map(tool => tool.name)
    const headers = stringMap(record.headers, 'headers')
    validateHeaders(headers)
    const base: Omit<DeepSeekHarnessConnector, 'url' | 'command'> = {
      id, version: stringField(record, 'version'), name: stringField(record, 'name'), status,
      authMode: authMode as DeepSeekHarnessConnector['authMode'], transport,
      arguments: stringList(record.arguments, 'arguments'),
      environment: stringMap(record.environment, 'environment'),
      headers, toolNames, readOnlyTools,
      timeoutSeconds: z.number().int().min(1).max(600).default(60).parse(record.timeoutSeconds),
    }
    for (const toolName of toolNames) publicToolName(connectorServerName(id), toolName)
    if (transport === 'streamable-http') {
      return { ...base, url: remoteConnectorUrl(record.url, id) }
    }
    const command = typeof record.command === 'string' ? record.command.trim() : ''
    if (command === '' || command.includes('\0')) {
      throw new Error(`deepseek-harness product: connector ${id} has no valid stdio command`)
    }
    return { ...base, command }
  })
}

function connectorTools(value: unknown): Array<{ readonly name: string; readonly access: 'READ' | 'WRITE' }> {
  if (!Array.isArray(value)) throw new Error('deepseek-harness product: invalid tools')
  try {
    return ConnectorCatalogToolsSchema.parse(value).map(({ name, access }) => {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error('invalid tool name')
      return { name, access }
    })
  } catch (error) {
    throw new Error('deepseek-harness product: invalid or duplicate tools', { cause: error })
  }
}

export function connectorServerName(id: string): string {
  const normalized = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 23) || 'connector'
  return `${normalized}_${createHash('sha256').update(id).digest('hex').slice(0, 8)}`
}

export function connectorToolPolicy(
  connectors: readonly DeepSeekHarnessConnector[],
  toolName: string,
): ConnectorToolPolicy {
  for (const connector of connectors) {
    const serverName = connectorServerName(connector.id)
    const rawName = connector.toolNames.find(candidate => publicToolName(serverName, candidate) === toolName)
    if (rawName !== undefined) return connector.readOnlyTools.includes(rawName) ? 'read-only' : 'write'
    if (toolName.startsWith(`mcp__${serverName}__`)) return 'undeclared'
  }
  return 'unrelated'
}

function remoteConnectorUrl(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`deepseek-harness product: connector ${id} has no URL`)
  }
  let url: URL
  try { url = new URL(value) }
  catch { throw new Error(`deepseek-harness product: connector ${id} has an invalid URL`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === ''
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`deepseek-harness product: connector ${id} has an invalid URL`)
  }
  return url.toString()
}

function validateHeaders(headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw new Error('deepseek-harness product: connector contains an invalid HTTP header')
    }
  }
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.values(value).some(item => typeof item !== 'string')) {
    throw new Error(`deepseek-harness product: invalid ${field}`)
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
}
