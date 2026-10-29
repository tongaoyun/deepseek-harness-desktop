/** Conversation-local discovery of native MCP definitions from a private catalog. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { defineTool, type ToolDefinition, type ToolExecution, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client'
import { ProductError } from '@deepseek-harness/product/errors'
import { z } from 'zod'
import { registerConnectorSelection, DISCOVER_CONNECTOR_TOOLS, CONNECTOR_SELECTION_META, type ConnectorPin as Pin } from './connector-selection.ts'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import { connectorServerName, parseConnectorCatalog, type DeepSeekHarnessConnector as Connector } from './deepseek-harness-connector-contract.ts'
import { connectorSearchQuery, rankConnectorTools } from './connector-search.ts'

export { DISCOVER_CONNECTOR_TOOLS } from './connector-selection.ts'
export const discoveryOptions = z.object({
  maxResults: z.number().int().min(1).max(50).default(8),
  maxLoadedTools: z.number().int().min(1).max(500).default(64),
  maxResultBytes: z.number().int().min(1024).max(1_048_576).default(32_768),
}).strict().refine(value => value.maxLoadedTools >= value.maxResults, 'maxLoadedTools must cover maxResults')
export type DiscoveryOptions = z.input<typeof discoveryOptions>
export interface ConnectorCatalog { readonly tools: ToolRuntime; readonly connectors: readonly Connector[] }
interface Selection { readonly pin: Pin; readonly remove: () => void }
interface State {
  readonly scope: Scope
  readonly controller: AbortController
  readonly loaded: Map<string, Selection>
  invalid?: ProductError
}

function hash(tool: ToolDefinition): string {
  return createHash('sha256').update(JSON.stringify({ name: tool.name, description: tool.description,
    parameters: tool.parameters, output: tool.output.schema })).digest('hex')
}
function unavailable(pin: Pin): ProductError {
  return new ProductError('CONNECTOR_TOOL_DEFINITION_CHANGED',
    '已加载的连接器工具已变更或不可用。请刷新连接器；若版本已更新，请新建对话。原对话历史仍保留。', false,
    [{ kind: 'connector', id: pin.connectorId }])
}
/** Own per-Agent discovery scopes; the caller must inject `tools` and the Agent/Session services. */
export async function installConnectorDiscovery(ctx: Context, product: Pick<DeepSeekHarnessProductIpc, 'invoke'>,
  catalog: () => ConnectorCatalog | undefined, options: DiscoveryOptions = {}): Promise<void> {
  const limits = discoveryOptions.parse(options)
  const identifier = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u)
  const requestSchema = z.union([
    z.object({ query: connectorSearchQuery, queryVariants: z.array(connectorSearchQuery).max(4).default([]),
      limit: z.number().int().min(1).max(limits.maxResults).default(limits.maxResults) }).strict(),
    z.object({ connectorId: identifier, toolNames: z.array(identifier).min(1).max(limits.maxResults)
      .refine(names => new Set(names).size === names.length) }).strict(),
  ])
  const selection = await registerConnectorSelection(ctx)
  const states = new Map<Agent, State>()
  const lifetime = new AbortController()
  const operations = new Set<Promise<unknown>>()
  const lookup = (pin: Pin) => {
    const current = catalog()
    const connector = current?.connectors.find(value => value.id === pin.connectorId && value.version === pin.version)
    if (!connector || !connector.toolNames.some(raw => publicToolName(connectorServerName(connector.id), raw) === pin.name)) {
      return undefined
    }
    const tool = current?.tools.get(pin.name)
    return tool && hash(tool) === pin.sha256 ? tool : undefined
  }
  const expose = (state: State, pin: Pin) => {
    const previous = state.loaded.get(pin.name)
    if (previous) {
      if (JSON.stringify(previous.pin) !== JSON.stringify(pin)) throw unavailable(pin)
      return
    }
    const tool = lookup(pin)
    if (!tool) throw unavailable(pin)
    if (state.loaded.size >= limits.maxLoadedTools) {
      throw new ProductError('CONNECTOR_TOOL_LIMIT', '当前对话已加载的连接器工具过多，请新建对话。')
    }
    // Resolve the live native callback after each refresh; never retain a closed transport.
    const executions = new WeakMap<Readonly<ToolExecution>, ToolDefinition>()
    const remove = state.scope.ctx.tools.register({ ...tool, async execute(args, exec) {
      const live = lookup(pin)
      if (!live) throw unavailable(pin)
      executions.set(exec, live)
      return live.execute(args, exec)
    }, projectContent(exec, result) {
      // Native rich results belong to the exact definition that performed the call.
      const live = executions.get(exec)
      executions.delete(exec)
      return live?.projectContent?.(exec, result)
    } })
    state.loaded.set(pin.name, { pin, remove })
  }
  const readPins = (agent: Agent) => {
    const state = selection.stateOf(agent.session)
    if (state.failure) throw new ProductError(state.failure === 'missing' ? 'CONNECTOR_TOOL_SNAPSHOT_MISSING' : 'CONNECTOR_TOOL_SNAPSHOT_INVALID',
      '连接器工具记录无法恢复，请新建对话；原历史仍可查看。')
    return state.pins
  }
  const replay = (agent: Agent, state: State) => {
    delete state.invalid
    try {
      const pins = new Map(readPins(agent).map(pin => [pin.name, pin]))
      // A cancelled or policy-rejected discovery must not leave unlogged capabilities behind.
      for (const [name, selection] of state.loaded) {
        if (!pins.has(name)) { selection.remove(); state.loaded.delete(name) }
      }
      for (const pin of pins.values()) expose(state, pin)
    } catch (cause) {
      state.invalid = cause instanceof ProductError ? cause : new ProductError('CONNECTOR_TOOL_SNAPSHOT_INVALID', '连接器工具记录无法恢复，请新建对话；原历史仍可查看。', false, [], { cause })
    }
  }
  const attach = (agent: Agent): undefined => {
    const scope = createScope(ctx, agent)
    const state: State = { scope, controller: new AbortController(), loaded: new Map() }
    scope.ctx.effect(() => () => { state.controller.abort(new Error('Conversation disposed')) }, 'connector-discovery.agent')
    states.set(agent, state)
    replay(agent, state)
    scope.ctx.tools.guard((exec) => {
      try { readPins(agent) }
      catch (error) { return error instanceof Error ? error.message : String(error) }
      if (state.invalid) return state.invalid.message
      const selected = state.loaded.get(exec.name)
      return selected && !lookup(selected.pin)
        ? 'Loaded connector tool is unavailable or changed. Refresh connectors or start a new conversation.' : undefined
    })
    scope.ctx.on('agent/pre-step', async (_event, next) => {
      replay(agent, state)
      if (state.invalid) throw state.invalid
      for (const { pin } of state.loaded.values()) if (!lookup(pin)) throw unavailable(pin)
      return next()
    })
    return undefined
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  const disposals = new Set<Promise<void>>()
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    states.delete(agent)
    if (!state) return
    const pending = state.scope.dispose()
    disposals.add(pending)
    void pending.finally(() => disposals.delete(pending)).catch((error: unknown) => { ctx.logger.warn(String(error)) })
  })
  for (const agent of ctx.agents.list()) attach(agent)
  ctx.tools.register(defineTool({
    name: DISCOVER_CONNECTOR_TOOLS,
    description: 'Load business tools into this conversation before calling them. For tool references in skills or experts, use connectorId and toolNames for exact lookup; all must be available or none are loaded. Otherwise use concise operation keywords in query; lexical search cannot infer synonyms. Supply queryVariants for synonyms or Chinese/English translations, and retry with different terms if needed. Check returned descriptions before calling tools. Never combine search and exact lookup. This performs no business operation.',
    parameters: { query: { type: 'string', description: 'Concise business operation keywords, at most 200 characters, e.g. 取消订单. A connector name alone does not match tools. Omit for exact lookup.' },
      queryVariants: { type: 'array', items: { type: 'string' }, description: 'Up to 4 alternative keyword expressions for the same operation, e.g. ["cancel order", "void order"]. Each expression is at most 200 characters. Omit for exact lookup.' },
      limit: { type: 'integer', description: `Search matches, 1–${limits.maxResults}; default ${limits.maxResults}. Omit for exact lookup.` },
      connectorId: { type: 'string', description: 'Exact connector ID from the skill, expert, or search result. Use with toolNames; omit query, queryVariants and limit.' },
      toolNames: { type: 'array', items: { type: 'string' }, description: `Exact original MCP tool names, case-sensitive, 1–${limits.maxResults} distinct names. Do not use generated callable names.` } },
    output: { schema: { type: 'object', properties: { content: { type: 'string', required: true }, pins: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.content }],
      presentationMeta: (_args, value) => ({ kind: CONNECTOR_SELECTION_META, content: value.pins }) },
    async execute(args, exec) {
      const state = exec.agent && states.get(exec.agent)
      if (!state) throw new ProductError('CONNECTOR_AGENT_REQUIRED', '连接器工具发现需要有效的对话。')
      const parsed = requestSchema.safeParse(args)
      if (!parsed.success) throw new ProductError('CONNECTOR_QUERY_INVALID',
        '请提供业务关键词（每项不超过 200 字，可附最多 4 组同义表达）和结果数量，或连接器 ID 和不重复的工具原名；两种方式不能混用，数量不能超限。')
      const request = parsed.data
      const signal = AbortSignal.any([exec.signal, lifetime.signal, state.controller.signal])
      const operation = (async () => {
        const current = catalog()
        if (!current) throw new ProductError('CONNECTOR_CATALOG_UNAVAILABLE', '连接器目录暂不可用，请刷新连接器后重试。', true)
        const exact = 'connectorId' in request
        const ids = exact ? [request.connectorId] : current.connectors.map(connector => connector.id)
        const allowed = parseConnectorCatalog(await product.invoke('connectors.list', { ids }, signal))
        signal.throwIfAborted()
        if (current !== catalog()) throw new ProductError('CONNECTOR_CATALOG_CHANGED', '连接器正在刷新，请稍后重试。', true)
        const resolve = (connector: Connector, raw: string) => {
          const name = publicToolName(connectorServerName(connector.id), raw)
          const tool = current.tools.get(name)
          return tool && { tool, connector, raw,
            pin: { name, connectorId: connector.id, version: connector.version, sha256: hash(tool) } }
        }
        const matches = (() => {
          if ('connectorId' in request) {
            const resources = [{ kind: 'connector' as const, id: request.connectorId }]
            const live = allowed.find(value => value.id === request.connectorId)
            if (!live) throw new ProductError('CONNECTOR_REFERENCE_UNAVAILABLE', '指定连接器不存在或当前无权访问，请检查连接器 ID 和访问权限。', false, resources)
            const connector = current.connectors.find(value => value.id === request.connectorId)
            if (!connector) throw new ProductError('CONNECTOR_REFERENCE_NOT_LOADED', '指定连接器尚未连接，请刷新连接器后重试。', true, resources)
            if (connector.version !== live.version) throw new ProductError('CONNECTOR_REFERENCE_VERSION_CHANGED', '指定连接器版本已变更，请刷新连接器后重试。', true, resources)
            return request.toolNames.map((raw) => {
              if (!live.toolNames.includes(raw) || !connector.toolNames.includes(raw)) throw new ProductError('CONNECTOR_TOOL_REFERENCE_MISSING',
                `指定工具 ${raw} 未声明或已移除，请核对工具原名并刷新连接器。`, false, resources)
              const match = resolve(connector, raw)
              if (!match) throw new ProductError('CONNECTOR_TOOL_REFERENCE_UNAVAILABLE',
                `指定工具 ${raw} 未由 MCP 服务提供，请检查服务并刷新连接器。`, true, resources)
              return match
            })
          }
          const candidates = current.connectors.flatMap((connector) => {
            const live = allowed.find(value => value.id === connector.id && value.version === connector.version)
            if (!live) return []
            return connector.toolNames.flatMap((raw) => {
              if (!live.toolNames.includes(raw)) return []
              const match = resolve(connector, raw)
              if (!match) return []
              return [match]
            })
          }).sort((a, b) => a.pin.name.localeCompare(b.pin.name))
          return rankConnectorTools(candidates, [request.query, ...request.queryVariants]).slice(0, request.limit)
        })()
        const pins = matches.map(match => match.pin)
        if (state.loaded.size + pins.filter(pin => !state.loaded.has(pin.name)).length > limits.maxLoadedTools) {
          throw new ProductError('CONNECTOR_TOOL_LIMIT', '当前对话已加载的连接器工具过多，请缩小查询范围或新建对话。')
        }
        const content = JSON.stringify({ tools: matches.map(({ tool, connector, raw }) => ({ name: tool.name,
          connector: connector.name, connectorId: connector.id, toolName: raw, version: connector.version,
          description: tool.description, parameters: tool.parameters })) })
        const result = { content, pins: JSON.stringify(pins) }
        // Bound the entire canonical result, including replay metadata and JSON escaping.
        const presentation = { content: [{ type: 'text', text: content }], meta: { kind: CONNECTOR_SELECTION_META, content: result.pins } }
        if (Math.max(Buffer.byteLength(JSON.stringify(result)), Buffer.byteLength(JSON.stringify(presentation))) > limits.maxResultBytes) throw new ProductError('CONNECTOR_SEARCH_TOO_LARGE',
          '工具说明超出发现结果限制，请减少结果数量或缩小查询范围。')
        signal.throwIfAborted()
        const conflict = pins.find((pin) => {
          const selected = state.loaded.get(pin.name)
          return selected && JSON.stringify(selected.pin) !== JSON.stringify(pin)
        })
        if (conflict) throw unavailable(conflict)
        const added: Selection[] = []
        try {
          for (const pin of pins) {
            const existed = state.loaded.has(pin.name)
            expose(state, pin)
            const selected = state.loaded.get(pin.name)
            if (!existed && selected) added.push(selected)
          }
        } catch (error) {
          for (const selection of added) { selection.remove(); state.loaded.delete(selection.pin.name) }
          throw error
        }
        return result
      })()
      operations.add(operation)
      try { return await operation }
      finally { operations.delete(operation) }
    },
  }))
  ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) lifetime.abort(new Error('Product runtime unloaded'))
  }, { global: true })
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Product runtime unloaded'))
    await Promise.allSettled([...operations, ...disposals])
    await Promise.all([...states.values()].map(state => state.scope.dispose()))
    states.clear()
  }, 'product-connectors.discovery')
}
