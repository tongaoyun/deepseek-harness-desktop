import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client'

export const name = 'xiaoyin-erp-mcp'
export const inject = ['tools']

export interface Config {
  url?: string
  allowedTools?: string[]
  requiredTools?: string[]
  bearerTokenEnv?: string
}

export const Config = z.object({
  url: z.string().default(''),
  allowedTools: z.array(z.string()).default([]),
  requiredTools: z.array(z.string()).default([]),
  bearerTokenEnv: z.string().default('ERP_MCP_BEARER_TOKEN'),
})

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const url = config.url?.trim()
  if (process.env.XIAOYIN_HARNESS_DEBUG === '1') {
    process.stderr.write(`ERP MCP bridge config: url=${url ? 'configured' : 'disabled'}, required=${config.requiredTools?.length ?? 0}\n`)
  }
  if (!url) {
    if ((config.requiredTools?.length ?? 0) > 0) {
      throw new Error('ERP MCP URL is required by the selected expert kit')
    }
    return
  }

  try {
    const token = config.bearerTokenEnv
      ? process.env[config.bearerTokenEnv]?.trim()
      : undefined
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      ...(token
        ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
        : {}),
    })
    const client = new Client({ name: 'xiaoyin-desktop', version: '0.1.0' })
    await client.connect(transport)

    const discovered = await client.listTools()
    const tools = selectReadOnlyTools(
      discovered.tools,
      config.allowedTools ?? [],
      config.requiredTools ?? [],
    )
    const unregister = tools.map((tool) => ctx.tools.register(toHarnessTool(client, tool)))
    ctx.effect(() => async () => {
      for (const dispose of unregister.reverse()) dispose()
      await client.close()
    }, 'xiaoyin ERP MCP bridge')
  } catch (error) {
    if ((config.requiredTools?.length ?? 0) > 0) throw error
    process.stderr.write(`ERP MCP unavailable; continuing without ERP tools: ${safeError(error)}\n`)
  }
}

export function selectReadOnlyTools(
  discovered: Tool[],
  allowedTools: string[],
  requiredTools: string[],
): Tool[] {
  const allowed = new Set(allowedTools)
  const selected = discovered.filter((tool) => {
    const explicitlyAllowed = allowed.size === 0 || allowed.has(tool.name)
    return explicitlyAllowed && tool.annotations?.readOnlyHint === true
  })
  const selectedNames = new Set(selected.map((tool) => tool.name))
  const missing = [...new Set(requiredTools)].filter((tool) => !selectedNames.has(tool))
  if (missing.length > 0) {
    throw new Error(`ERP MCP is missing required read-only tools: ${missing.join(', ')}`)
  }
  return selected
}

function toHarnessTool(client: Client, tool: Tool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? `ERP MCP tool ${tool.name}`,
    parameters: tool.inputSchema,
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args, exec) {
      const result = await client.callTool(
        { name: tool.name, arguments: asArguments(args) },
        { signal: exec.signal },
      )
      if (result.isError) throw new Error(renderMcpContent(result))
      return canonicalMcpValue(result)
    },
    isConcurrencySafe: () => true,
  }
}

function asArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw new Error('ERP MCP tool arguments must be an object')
}

function canonicalMcpValue(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const texts = result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
  return texts.length === 1 ? texts[0] : texts
}

function renderMcpContent(result: CallToolResult): string {
  const texts = result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
  return texts.join('\n') || 'ERP MCP tool returned an error'
}

function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
