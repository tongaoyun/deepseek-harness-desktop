import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export const name = 'xiaoyin-managed-mcp'
export const inject = ['tools']

export interface ManagedConnectorConfig {
  id: string
  name: string
  version: string
  transport: 'streamable-http' | 'sse' | 'stdio'
  url: string
  authMode: 'employee-bearer' | 'none'
  command: string
  arguments: string[]
  environment: Record<string, string>
  headers: Record<string, string>
  allowedTools: string[]
  requiredTools: string[]
  allowWrite: boolean
  requireWriteApproval: boolean
  required: boolean
}

export interface Config {
  connectors?: ManagedConnectorConfig[]
  employeeBearerTokenEnv?: string
}

export type ConnectorDiagnosticStatus = 'ready' | 'drift' | 'unavailable'

export interface ConnectorDiagnosticResult {
  id: string
  status: ConnectorDiagnosticStatus
  latencyMs: number
  discoveredTools: string[]
  missingTools: string[]
  undeclaredTools: string[]
  error?: string
}

const ConnectorConfig = z.object({
  id: z.string().required(),
  name: z.string().required(),
  version: z.string().default('1'),
  transport: z.union(['streamable-http', 'sse', 'stdio']).default('streamable-http'),
  url: z.string().default(''),
  authMode: z.union(['employee-bearer', 'none']).default('none'),
  command: z.string().default(''),
  arguments: z.array(z.string()).default([]),
  environment: z.dict(z.string()).default({}),
  headers: z.dict(z.string()).default({}),
  allowedTools: z.array(z.string()).default([]),
  requiredTools: z.array(z.string()).default([]),
  allowWrite: z.boolean().default(false),
  requireWriteApproval: z.boolean().default(true),
  required: z.boolean().default(false),
})

export const Config: Schemastery<Config> = z.object({
  connectors: z.array(ConnectorConfig).default([]),
  employeeBearerTokenEnv: z.string().default('XIAOYIN_EMPLOYEE_BEARER_TOKEN'),
})

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const connectors = config.connectors ?? []
  const employeeToken = config.employeeBearerTokenEnv
    ? process.env[config.employeeBearerTokenEnv]?.trim()
    : undefined
  const activeClients: Client[] = []
  const unregisterTools: Array<() => void> = []
  const mutatingTools = new Map<string, string>()
  const registeredNames = new Set<string>()

  for (const connector of connectors) {
    let client: Client | undefined
    try {
      validateConnector(connector, employeeToken)
      client = new Client({ name: `xiaoyin-desktop-${connector.id}`, version: '0.1.0' })
      await client.connect(createTransport(connector, employeeToken))

      const discovered = await client.listTools()
      const tools = selectTools(
        discovered.tools,
        connector.allowedTools,
        connector.requiredTools,
        connector.allowWrite,
        connector.name,
      )
      for (const tool of tools) {
        const registeredName = registeredNames.has(tool.name) ? `${connector.id}.${tool.name}` : tool.name
        unregisterTools.push(ctx.tools.register(toHarnessTool(client, tool, connector, registeredName)))
        registeredNames.add(registeredName)
        if (tool.annotations?.readOnlyHint !== true && connector.requireWriteApproval) {
          mutatingTools.set(registeredName, connector.name)
        }
      }
      activeClients.push(client)
      debug(`${connector.name}: connected, registered=${tools.length}`)
    } catch (error) {
      if (client) await closeQuietly(client)
      const message = `${connector.name} (${connector.id}) 不可用：${safeError(error)}`
      if (connector.required) {
        await cleanup(unregisterTools, activeClients)
        throw new Error(message)
      }
      process.stderr.write(`${message}；本次会话跳过该连接器\n`)
    }
  }

  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    const connectorName = mutatingTools.get(exec.name)
    if (!connectorName) return next()
    return Promise.resolve({
      kind: 'ask' as const,
      reason: `调用「${connectorName}」修改工具：${exec.name}\n参数：${safeArguments(exec.arguments)}`,
    })
  })

  ctx.effect(() => async () => {
    stopApprovalPolicy()
    await cleanup(unregisterTools, activeClients)
  }, 'xiaoyin managed MCP connectors')
}

export async function diagnoseConfiguredConnectors(
  timeoutMs = 10_000,
): Promise<ConnectorDiagnosticResult[]> {
  const connectors = configuredConnectors(process.env.XIAOYIN_MCP_CONNECTORS)
  const employeeToken = process.env.XIAOYIN_EMPLOYEE_BEARER_TOKEN?.trim()
  return Promise.all(connectors.map((connector) => diagnoseConnector(connector, employeeToken, timeoutMs)))
}

export async function diagnoseConnector(
  connector: ManagedConnectorConfig,
  employeeToken: string | undefined,
  timeoutMs = 10_000,
): Promise<ConnectorDiagnosticResult> {
  const startedAt = performance.now()
  let client: Client | undefined
  try {
    validateConnector(connector, employeeToken)
    client = new Client({ name: `xiaoyin-diagnostics-${connector.id}`, version: '0.1.0' })
    await client.connect(createTransport(connector, employeeToken), {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    })
    const discovered = await client.listTools({}, {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    })
    const comparison = compareConnectorTools(connector.allowedTools, discovered.tools.map((tool) => tool.name))
    return {
      id: connector.id,
      status: comparison.missingTools.length > 0 || comparison.undeclaredTools.length > 0 ? 'drift' : 'ready',
      latencyMs: elapsedMilliseconds(startedAt),
      discoveredTools: comparison.discoveredTools,
      missingTools: comparison.missingTools,
      undeclaredTools: comparison.undeclaredTools,
    }
  } catch (error) {
    return {
      id: connector.id,
      status: 'unavailable',
      latencyMs: elapsedMilliseconds(startedAt),
      discoveredTools: [],
      missingTools: uniqueSorted(connector.allowedTools),
      undeclaredTools: [],
      error: diagnosticError(error, employeeToken, [
        ...Object.values(connector.headers ?? {}),
        ...Object.values(connector.environment ?? {}),
      ]),
    }
  } finally {
    if (client) await closeQuietly(client)
  }
}

export function compareConnectorTools(
  declaredTools: string[],
  discoveredTools: string[],
): Pick<ConnectorDiagnosticResult, 'discoveredTools' | 'missingTools' | 'undeclaredTools'> {
  const declared = uniqueSorted(declaredTools)
  const discovered = uniqueSorted(discoveredTools)
  const declaredSet = new Set(declared)
  const discoveredSet = new Set(discovered)
  return {
    discoveredTools: discovered,
    missingTools: declared.filter((tool) => !discoveredSet.has(tool)),
    undeclaredTools: declared.length === 0 ? [] : discovered.filter((tool) => !declaredSet.has(tool)),
  }
}

export function selectTools(
  discovered: Tool[],
  allowedTools: string[],
  requiredTools: string[],
  allowWrite: boolean,
  connectorName = 'MCP',
): Tool[] {
  const allowed = new Set(allowedTools)
  const selected = discovered.filter((tool) =>
    (allowed.size === 0 || allowed.has(tool.name)) && (tool.annotations?.readOnlyHint === true || allowWrite),
  )
  void requiredTools
  void connectorName
  return selected
}

function validateConnector(connector: ManagedConnectorConfig, employeeToken: string | undefined): void {
  if (!connector.id.trim() || !connector.name.trim()) throw new Error('连接器标识或名称为空')
  if (!['streamable-http', 'sse', 'stdio'].includes(connector.transport)) {
    throw new Error(`不支持传输协议 ${connector.transport}`)
  }
  if (connector.transport === 'stdio') {
    if (!connector.command.trim()) throw new Error('stdio 连接器缺少启动命令')
    return
  }
  const url = new URL(connector.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('连接器地址必须使用 HTTP(S)')
  if (connector.authMode === 'employee-bearer' && !employeeToken) {
    throw new Error('缺少员工访问令牌')
  }
}

function createTransport(connector: ManagedConnectorConfig, employeeToken: string | undefined): Transport {
  if (connector.transport === 'stdio') {
    return new StdioClientTransport({
      command: connector.command,
      args: connector.arguments ?? [],
      env: connector.environment ?? {},
      stderr: 'pipe',
    })
  }
  const token = connector.authMode === 'employee-bearer' ? employeeToken : undefined
  const headers = connector.headers ?? {}
  const options = {
    ...(token ? { authProvider: { token: async () => token } } : {}),
    ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
  }
  return connector.transport === 'sse'
    ? new SSEClientTransport(new URL(connector.url), options)
    : new StreamableHTTPClientTransport(new URL(connector.url), options)
}

function safeArguments(value: unknown): string {
  try {
    const serialized = JSON.stringify(value)
    return serialized.length <= 4_000 ? serialized : `${serialized.slice(0, 4_000)}…`
  } catch {
    return '参数无法展示'
  }
}

function toHarnessTool(
  client: Client,
  tool: Tool,
  connector: ManagedConnectorConfig,
  registeredName = tool.name,
): ToolDefinition {
  return {
    name: registeredName,
    description: tool.description ?? `${connector.name} MCP 工具 ${tool.name}`,
    parameters: tool.inputSchema,
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args, exec) {
      const result = await client.callTool(
        { name: tool.name, arguments: asArguments(args, connector.name) },
        { signal: exec.signal },
      )
      if (result.isError) throw new Error(renderMcpContent(result, connector.name))
      return canonicalMcpValue(result)
    },
    isConcurrencySafe: () => true,
  }
}

function asArguments(value: unknown, connectorName: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error(`${connectorName} MCP 工具参数必须是对象`)
}

function canonicalMcpValue(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const texts = result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
  return texts.length === 1 ? texts[0] : texts
}

function renderMcpContent(result: CallToolResult, connectorName: string): string {
  const texts = result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
  return texts.join('\n') || `${connectorName} MCP 工具返回错误`
}

function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

async function cleanup(unregisterTools: Array<() => void>, clients: Client[]): Promise<void> {
  for (const dispose of unregisterTools.splice(0).reverse()) dispose()
  for (const client of clients.splice(0).reverse()) await closeQuietly(client)
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close()
  } catch (error) {
    debug(`close failed: ${safeError(error)}`)
  }
}

function debug(message: string): void {
  if (process.env.XIAOYIN_HARNESS_DEBUG === '1') process.stderr.write(`Managed MCP: ${message}\n`)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function configuredConnectors(value: string | undefined): ManagedConnectorConfig[] {
  if (!value?.trim()) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('连接器诊断配置无效')
  return parsed as ManagedConnectorConfig[]
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export function diagnosticError(error: unknown, employeeToken: string | undefined, connectorSecrets: string[] = []): string {
  const message = safeError(error)
  if (/abort|timeout|timed out/i.test(message)) return '连接或 MCP 握手超时'
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(message)) return '员工身份未获连接器授权'
  const redacted = [employeeToken, ...connectorSecrets]
    .filter((secret): secret is string => Boolean(secret))
    .reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), message)
  const withoutEndpoints = redacted.replace(/https?:\/\/[^\s"'<>]+/giu, '连接器端点')
  return [...withoutEndpoints].filter((character) => !/\p{Cc}/u.test(character)).join('').slice(0, 500)
    || '连接器诊断失败'
}
