import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const name = 'xiaoyin-knowledge'
export const inject = ['tools']

export interface Config {
  endpoint?: string
  employeeIdEnv?: string
  employeeTokenEnv?: string
}

export const Config = z.object({
  endpoint: z.string().default(''),
  employeeIdEnv: z.string().default('XIAOYIN_EMPLOYEE_ID'),
  employeeTokenEnv: z.string().default('XIAOYIN_EMPLOYEE_BEARER_TOKEN'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const endpoint = config.endpoint?.trim()
  if (!endpoint) return
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Knowledge endpoint must use HTTP(S)')
  const client = new KnowledgeClient(
    url.toString().replace(/\/$/, ''),
    process.env[config.employeeIdEnv ?? 'XIAOYIN_EMPLOYEE_ID']?.trim() || 'local-development',
    process.env[config.employeeTokenEnv ?? 'XIAOYIN_EMPLOYEE_BEARER_TOKEN']?.trim() || '',
  )
  const unregister = [ctx.tools.register(listTool(client)), ctx.tools.register(searchTool(client))]
  ctx.effect(() => () => unregister.reverse().forEach((dispose) => dispose()), 'xiaoyin knowledge tools')
}

export class KnowledgeClient {
  constructor(private readonly endpoint: string, private readonly employeeId: string, private readonly token: string) {}

  async list(): Promise<unknown> { return this.request('') }

  async search(query: string, knowledgeBaseIds: string[], limit: number): Promise<unknown> {
    return this.request('/search', {
      method: 'POST',
      body: JSON.stringify({ query, knowledgeBaseIds, limit }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private async request(suffix: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${suffix}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        'X-Xiaoyin-Employee-Id': this.employeeId,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) throw new Error(`Knowledge service returned HTTP ${response.status}`)
    return response.json()
  }
}

function listTool(client: KnowledgeClient): ToolDefinition {
  return {
    name: 'knowledge_list',
    description: 'List the enterprise knowledge bases that the current employee is allowed to search.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => client.list(),
    isConcurrencySafe: () => true,
  }
}

function searchTool(client: KnowledgeClient): ToolDefinition {
  return {
    name: 'knowledge_search',
    description: 'Search approved company documents. Results include file names and page, worksheet, or section locators; cite these sources in the answer.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2_000, description: 'Focused search query.' },
        knowledgeBaseIds: { type: 'array', items: { type: 'string' }, maxItems: 32, description: 'Optional IDs from knowledge_list. Empty searches all accessible bases.' },
        limit: { type: 'integer', minimum: 1, maximum: 12, default: 6 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args) => {
      const input = asRecord(args)
      const query = requiredString(input.query, 'query')
      const baseIds = optionalStrings(input.knowledgeBaseIds, 'knowledgeBaseIds')
      const limit = input.limit === undefined ? 6 : integer(input.limit, 'limit', 1, 12)
      return client.search(query, baseIds, limit)
    },
    isConcurrencySafe: () => true,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Tool arguments must be an object')
  return value as Record<string, unknown>
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) throw new Error(`${name} is invalid`)
  return value.trim()
}
function optionalStrings(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32 || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${name} is invalid`)
  return value as string[]
}
function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${name} is invalid`)
  return value as number
}
