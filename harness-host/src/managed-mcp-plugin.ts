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

export const name = 'xiaoyin-managed-mcp'
export const inject = ['tools']

export interface ManagedConnectorConfig {
  id: string
  name: string
  version: string
  transport: 'streamable-http' | 'sse'
  url: string
  authMode: 'employee-bearer' | 'none'
  allowedTools: string[]
  requiredTools: string[]
  allowWrite: boolean
  required: boolean
}

export interface Config {
  connectors?: ManagedConnectorConfig[]
  employeeBearerTokenEnv?: string
}

const ConnectorConfig = z.object({
  id: z.string().required(),
  name: z.string().required(),
  version: z.string().default('1'),
  transport: z.union(['streamable-http', 'sse']).default('streamable-http'),
  url: z.string().required(),
  authMode: z.union(['employee-bearer', 'none']).default('none'),
  allowedTools: z.array(z.string()).default([]),
  requiredTools: z.array(z.string()).default([]),
  allowWrite: z.boolean().default(false),
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
      const collisions = tools.map((tool) => tool.name).filter((tool) => registeredNames.has(tool))
      if (collisions.length > 0) {
        throw new Error(`工具名与其他连接器冲突：${collisions.join(', ')}`)
      }

      for (const tool of tools) {
        unregisterTools.push(ctx.tools.register(toHarnessTool(client, tool, connector)))
        registeredNames.add(tool.name)
        if (tool.annotations?.readOnlyHint !== true) mutatingTools.set(tool.name, connector.name)
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

export function selectTools(
  discovered: Tool[],
  allowedTools: string[],
  requiredTools: string[],
  allowWrite: boolean,
  connectorName = 'MCP',
): Tool[] {
  const allowed = new Set(allowedTools)
  const selected = discovered.filter((tool) =>
    allowed.has(tool.name) && (tool.annotations?.readOnlyHint === true || allowWrite),
  )
  const selectedNames = new Set(selected.map((tool) => tool.name))
  const missing = [...new Set(requiredTools)].filter((tool) => !selectedNames.has(tool))
  if (missing.length > 0) {
    throw new Error(`${connectorName} 缺少专家套件要求且获准使用的工具：${missing.join(', ')}`)
  }
  return selected
}

function validateConnector(connector: ManagedConnectorConfig, employeeToken: string | undefined): void {
  if (!connector.id.trim() || !connector.name.trim()) throw new Error('连接器标识或名称为空')
  if (!['streamable-http', 'sse'].includes(connector.transport)) {
    throw new Error(`不支持传输协议 ${connector.transport}`)
  }
  const url = new URL(connector.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('连接器地址必须使用 HTTP(S)')
  if (connector.authMode === 'employee-bearer' && !employeeToken) {
    throw new Error('缺少员工访问令牌')
  }
}

function createTransport(connector: ManagedConnectorConfig, employeeToken: string | undefined): Transport {
  const token = connector.authMode === 'employee-bearer' ? employeeToken : undefined
  const options = token ? { authProvider: { token: async () => token } } : undefined
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
): ToolDefinition {
  return {
    name: tool.name,
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
