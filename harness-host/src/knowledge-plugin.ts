import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { rememberCapabilityNotice } from './capability-notice.js'

export const name = 'xiaoyin-knowledge'
// A knowledge scope with no endpoint has nothing to register, so the plugin
// must not require a service it will not use: requiring `tools` here fails the
// whole host startup instead of simply having no knowledge tools.
export const inject = []

export interface Config {
  endpoint?: string
  employeeIdEnv?: string
  teamIdEnv?: string
  employeeTokenEnv?: string
  knowledgeBaseRefsEnv?: string
}

export const Config = z.object({
  endpoint: z.string().default(''),
  employeeIdEnv: z.string().default('XIAOYIN_EMPLOYEE_ID'),
  teamIdEnv: z.string().default('XIAOYIN_TEAM_ID'),
  employeeTokenEnv: z.string().default('XIAOYIN_CONTROL_PLANE_TOKEN'),
  knowledgeBaseRefsEnv: z.string().default('XIAOYIN_KNOWLEDGE_BASE_REFS'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const endpoint = config.endpoint?.trim()
  const scope = readKnowledgeScope(process.env[config.knowledgeBaseRefsEnv ?? 'XIAOYIN_KNOWLEDGE_BASE_REFS'])
  if (scope.kind === 'invalid') {
    rememberCapabilityNotice({ kind: 'knowledge', id: 'scope', name: '所选知识库', reason: `范围无效：${scope.detail}` })
    return
  }
  if (!endpoint) {
    // Requested knowledge bases would silently have no tools at all.
    if (scope.kind === 'refs' && scope.refs.length > 0) {
      rememberCapabilityNotice({ kind: 'knowledge', id: scope.refs.join(','), name: scope.refs.join('、'), reason: '知识库服务未配置，本次不会检索知识库' })
    }
    return
  }
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Knowledge endpoint must use HTTP(S)')
  const client = new KnowledgeClient(
    url.toString().replace(/\/$/, ''),
    process.env[config.employeeIdEnv ?? 'XIAOYIN_EMPLOYEE_ID']?.trim() || 'local-development',
    process.env[config.teamIdEnv ?? 'XIAOYIN_TEAM_ID']?.trim() || '',
    process.env[config.employeeTokenEnv ?? 'XIAOYIN_CONTROL_PLANE_TOKEN']?.trim() || '',
    scope.kind === 'refs' ? scope.refs : null,
  )
  ctx.inject(['tools'], (toolsCtx) => {
    const unregister = [toolsCtx.tools.register(listTool(client)), toolsCtx.tools.register(searchTool(client))]
    toolsCtx.effect(() => () => unregister.reverse().forEach((dispose) => dispose()), 'xiaoyin knowledge tools')
  })
}

export class KnowledgeClient {
  constructor(
    private readonly endpoint: string,
    private readonly employeeId: string,
    private readonly teamId: string,
    private readonly token: string,
    private readonly knowledgeBaseRefs: string[] | null,
  ) {}

  async list(): Promise<unknown> {
    const result = await this.request('')
    if (this.knowledgeBaseRefs === null || !Array.isArray(result)) return result
    const allowed = new Set(this.knowledgeBaseRefs)
    return result.filter((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
      return allowed.has((item as Record<string, unknown>).reference as string)
    })
  }

  async search(query: string, knowledgeBaseIds: string[], limit: number): Promise<unknown> {
    const searchEndpoint = this.endpoint.replace(/\/api\/v1\/knowledge-bases\/?$/, '/api/v1/knowledge-searches')
    return this.requestTo(searchEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        query,
        knowledgeBaseIds,
        knowledgeBaseRefs: this.knowledgeBaseRefs ?? [],
        restrictToKnowledgeBaseRefs: this.knowledgeBaseRefs !== null,
        limit,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private async request(suffix: string, init: RequestInit = {}): Promise<unknown> {
    return this.requestTo(`${this.endpoint}${suffix}`, init)
  }

  private async requestTo(target: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(target, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        'X-Xiaoyin-Employee-Id': this.employeeId,
        ...(this.teamId ? { 'X-Xiaoyin-Team-Id': this.teamId } : {}),
        ...(this.token ? { 'X-ERP-Session': this.token } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) throw new Error(`Knowledge service returned HTTP ${response.status}`)
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || !('success' in value) || value.success !== true || !('data' in value)) {
      throw new Error('Knowledge service returned an invalid or failed COLA response')
    }
    return value.data
  }
}

/**
 * A malformed scope must never stop the runtime from starting: the turn reports
 * it as a capability gap instead. The strict parser stays for callers that can
 * surface an error to the employee.
 */
export function readKnowledgeScope(value: string | undefined): { kind: 'none' } | { kind: 'refs'; refs: string[] } | { kind: 'invalid'; detail: string } {
  try {
    const refs = parseKnowledgeBaseRefs(value)
    return refs === null ? { kind: 'none' } : { kind: 'refs', refs }
  } catch (error) {
    return { kind: 'invalid', detail: error instanceof Error ? error.message : String(error) }
  }
}

export function parseKnowledgeBaseRefs(value: string | undefined): string[] | null {
  if (value === undefined || !value.trim() || value.trim() === 'null') return null
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('Knowledge base scope must be valid JSON') }
  if (!Array.isArray(parsed) || parsed.length > 32) throw new Error('Knowledge base scope is invalid')
  const pattern = /^(personal|team|organization):[a-z][a-z0-9-]{2,63}$/
  if (parsed.some((item) => typeof item !== 'string' || !pattern.test(item)) || new Set(parsed).size !== parsed.length) {
    throw new Error('Knowledge base scope contains an invalid or duplicate reference')
  }
  return parsed
}

function listTool(client: KnowledgeClient): ToolDefinition {
  return {
    name: 'knowledge_list',
    description: 'List the knowledge bases allowed for the current employee and selected expert kit.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: () => client.list(),
    isConcurrencySafe: () => true,
  }
}

function searchTool(client: KnowledgeClient): ToolDefinition {
  return {
    name: 'knowledge_search',
    description: 'Search approved company documents. Results include sourceId, file names and page, worksheet, or section locators; cite file names and locators for claims supported by these excerpts. Empty results mean no matching evidence, not permission to invent company policies. Search again for current facts after updates or in follow-up tasks; historical excerpts are not proof of current content. A search hit is an excerpt, not proof that the entire document was read.',
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
