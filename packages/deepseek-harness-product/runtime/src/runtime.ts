/** Enterprise connectors and task-scoped knowledge on public Harness extension points. */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { installConnectorDiscovery, discoveryOptions, type DiscoveryOptions, type ConnectorCatalog } from './connector-discovery.ts'
import type {} from '@deepseek-ai/dsh-session-query'
import type { ProductTaskCapabilityRequest, ProductTaskCapabilityResult, ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { ProductError } from '@deepseek-harness/product/errors'
import { createTaskCapabilities } from './tasks.ts'
import * as KnowledgeLibrary from './knowledge-library.ts'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import { connectorServerName, connectorToolPolicy, parseConnectorCatalog, type DeepSeekHarnessConnector as Connector } from './deepseek-harness-connector-contract.ts'
import { objectRecord, stringField } from './response-fields.ts'

const KNOWLEDGE_PLUGIN = import.meta.resolve('@deepseek-harness/product-runtime/knowledge')
export const inject = ['agentPresets', 'agents', 'sessions', 'sessionQuery', 'sessionProjections', 'systemPrompt', 'tools']
export interface DeepSeekHarnessRuntimeControl {
  /** Read task selections with caller cancellation forwarded to native Session observation.
   * @param request Task identity; absent identity reads the current default mode.
   * @param signal Cancellation for the complete read.
   * @returns The pinned task selection, never a late result after cancellation.
   */
  readCapabilities(request: ProductTaskCapabilityRequest, signal?: AbortSignal): Promise<ProductTaskCapabilities>
  prepareCapabilities(request: ProductTaskCapabilityRequest, signal?: AbortSignal): Promise<ProductTaskCapabilityResult>
  refreshConnectors(signal?: AbortSignal): Promise<{ connectedIds: string[]; unavailableIds: string[] }>
}
export interface Config {
  readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'>
  readonly connectorDiscovery?: DiscoveryOptions
  readonly publishControl: (control: DeepSeekHarnessRuntimeControl | undefined) => void
}
/** Register knowledge selection and authorized enterprise tools for native Agents, including subagents. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const discovery = discoveryOptions.parse(config.connectorDiscovery ?? {})
  await ctx.plugin(KnowledgeLibrary, { product: config.product })
  const visibleKnowledge = async (signal?: AbortSignal) => {
    const value = await config.product.invoke('knowledge.bases.list', undefined, signal)
    if (!Array.isArray(value)) throw new Error('Invalid knowledge catalog')
    return value.map(row => stringField(objectRecord(row, 'knowledge base'), 'id'))
  }
  const tasks = await createTaskCapabilities(ctx, {
    root: join(resolveDshHome(), 'product-knowledge-tasks-v1'), visibleKnowledge,
    async validateKnowledge(ids, signal) {
      if (ids.length === 0) return []
      const visible = new Set(await visibleKnowledge(signal))
      const denied = ids.filter(id => !visible.has(id))
      if (denied.length) throw new ProductError('KNOWLEDGE_ACCESS_REVOKED', 'Selected knowledge is unavailable', false,
        denied.map(id => ({ kind: 'knowledge-base', id })))
      return ids
    },
    knowledgePlugins: ids => ids.length === 0 ? [] : [{ id: 'product-knowledge', name: KNOWLEDGE_PLUGIN,
      config: { knowledgeBaseIds: ids } }],
    async register(definition: PresetDefinition) {
      const dispose = await ctx.agentPresets.register(definition)
      ctx.effect(() => dispose, `product-knowledge.preset.${definition.id}`)
      return dispose
    },
  })
  const connectors: Connector[] = []
  let catalog: ConnectorCatalog | undefined
  let privatePrompt: SystemPrompt | undefined
  let connectorInstructions = ''
  await installConnectorDiscovery(ctx, config.product, () => catalog, discovery)
  let connectorStatus = 'Enterprise connector catalog is loading. Its tools are unavailable.'
  const lifetime = new AbortController()
  const abortConnectors = () => { lifetime.abort(new Error('Product runtime unloaded')) }
  ctx.on('internal/plugin', (fiber) => {
    if (fiber === ctx.fiber && fiber.uid === null) abortConnectors()
  }, { global: true })
  installConnectorPolicy(ctx, connectors, config.product)
  ctx.effect(() => ctx.systemPrompt.section({ name: 'enterprise-connectors', order: 450,
    interpolate: false, text: () => connectorStatus + '\n' + connectorInstructions }), 'product-connectors.status')
  let fiber: ReturnType<Context['plugin']> | undefined
  let refreshQueue: Promise<unknown> = Promise.resolve()
  const refreshConnectors: DeepSeekHarnessRuntimeControl['refreshConnectors'] = (signal) => {
    const combined = AbortSignal.any([lifetime.signal, ...signal === undefined ? [] : [signal]])
    const operation = refreshQueue.catch(() => undefined).then(async () => {
      combined.throwIfAborted()
      catalog = undefined
      privatePrompt = undefined
      connectorInstructions = ''
      await fiber?.dispose()
      fiber = undefined
      connectors.length = 0
      connectorStatus = 'Enterprise connector catalog is loading. Its tools are unavailable.'
      let available: Connector[] = []
      let unavailable: Connector[] = []
      const current = ctx.plugin({ name: 'product-connectors', async apply(owner: Context) {
        const selected = parseConnectorCatalog(await config.product.invoke('connectors.list', undefined, combined))
        combined.throwIfAborted()
        // Cordis service isolation keeps MCP catalog changes outside the Agent tool registry.
        // Native MCP resources retain their existing shared provider and original execution path.
        const background = owner.isolate('tools').isolate('systemPrompt')
        const prompt = background.plugin(SystemPrompt, { includeHarnessIdentity: false })
        await prompt
        const tools = prompt.ctx.plugin(Tools)
        await tools
        // Tool execution is an explicit per-scope capability in the native API.
        // The isolated connector catalog must carry its own executor so prompt
        // assembly and MCP definitions can be resolved before an Agent exists.
        await prompt.ctx.plugin(NativeToolExecutor)
        connectors.push(...selected)
        const connected = await Promise.all(selected.map(async (connector) => {
          const child = tools.ctx.plugin({ name: McpClient.name, inject: McpClient.inject, apply: McpClient.apply },
            connectorConfig(connector))
          try { await child; return connector }
          catch {
            await child.dispose()
            combined.throwIfAborted()
            owner.logger.warn(`Enterprise connector ${connector.id} could not start; refresh the connector page to retry.`)
            return undefined
          }
        }))
        combined.throwIfAborted()
        available = connected.filter(connector => connector !== undefined)
        unavailable = selected.filter(connector => !available.includes(connector))
        catalog = { tools: tools.ctx.tools, connectors: available }
        privatePrompt = prompt.ctx.systemPrompt
      } })
      fiber = current
      const cancel = () => { void current.dispose() }
      combined.addEventListener('abort', cancel, { once: true })
      try {
        combined.throwIfAborted()
        await current
        combined.throwIfAborted()
        await updateConnectorInstructions(combined)
        connectorStatus = `Enterprise connector versions: ${JSON.stringify(available.map(({ id, version }) => ({ id, version })))}`
          + (unavailable.length === 0 ? '' : `\nUnavailable enterprise connectors: ${JSON.stringify(unavailable.map(({ id, name }) => ({ id, name })))}. Their tools could not connect. If needed, explain the missing capability and ask the user to refresh the connector page; do not claim their operations succeeded.`)
        return { connectedIds: available.map(({ id }) => id), unavailableIds: unavailable.map(({ id }) => id) }
      } catch (error) {
        await current.dispose()
        if (fiber === current) fiber = undefined
        catalog = undefined
        privatePrompt = undefined
        connectorInstructions = ''
        connectors.length = 0
        connectorStatus = 'Enterprise connector catalog is unavailable. No enterprise connector tools are available. If needed, explain the missing capability and ask the user to refresh the connector page; do not claim their operations succeeded.'
        combined.throwIfAborted()
        throw new ProductError('CONNECTOR_STARTUP_FAILED',
          '连接器暂时无法加载，请检查登录和网络后刷新连接器页面。普通对话可继续使用。', true, [], { cause: error })
      } finally {
        combined.removeEventListener('abort', cancel)
      }
    })
    refreshQueue = operation
    return operation
  }
  const updateConnectorInstructions = async (signal: AbortSignal) => {
    const source = privatePrompt
    if (!source) return
    const assembly = await source.assemble({ signal })
    signal.throwIfAborted()
    if (source === privatePrompt) connectorInstructions = assembly.sections.filter(section => section.name.startsWith('mcp:'))
      .map(section => section.text).join('\n\n')
  }
  ctx.effect(() => async () => { catalog = undefined; abortConnectors(); await refreshQueue.catch(() => undefined) }, 'product-runtime.connectors')
  // Connector failure is reported in the model-visible, logged prompt, not as a global execution guard.
  await refreshConnectors().catch((error: unknown) => { lifetime.signal.throwIfAborted(); ctx.logger.warn(String(error)) })
  ctx.on('agent-preset/resolve-selection', async (agent, _requested, next) => tasks.resolveSelection(agent.session.id, await next()))
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    await tasks.validate(ctx.agentPresets.composedPreset(agent.ctx), signal)
    await updateConnectorInstructions(signal)
    return next()
  })
  config.publishControl({ readCapabilities: (request, signal) => tasks.read(request, signal),
    prepareCapabilities: (request, signal) => tasks.prepare(request, signal), refreshConnectors })
  ctx.effect(() => () => { config.publishControl(undefined) }, 'product.runtime-control')
}

function connectorConfig(connector: Connector): McpClient.Config {
  const serverName = connectorServerName(connector.id)
  if (connector.transport === 'streamable-http') {
    if (connector.url === undefined) throw new Error(`deepseek-harness product: connector ${connector.id} has no URL`)
    return {
      transport: 'streamable-http', serverName, url: connector.url, headers: { ...connector.headers },
      toolCallTimeoutMs: connector.timeoutSeconds * 1000, failOnStartupError: true,
    }
  }
  if (connector.command === undefined) throw new Error(`deepseek-harness product: connector ${connector.id} has no command`)
  return {
    transport: 'stdio', serverName, command: connector.command, args: [...connector.arguments],
    env: { ...connector.environment }, cwd: '', toolCallTimeoutMs: connector.timeoutSeconds * 1000, failOnStartupError: true,
  }
}

function installConnectorPolicy(
  ctx: Context,
  connectors: readonly Connector[],
  product: Config['product'],
): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const resourceServer = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(exec.name)
      && typeof exec.arguments === 'object' && exec.arguments !== null && 'server' in exec.arguments
      ? exec.arguments.server : undefined
    const resourceConnector = connectors.find(value => connectorServerName(value.id) === resourceServer)
    const policy = resourceConnector ? 'read-only' : connectorToolPolicy(connectors, exec.name)
    if (policy === 'unrelated') return next()
    if (!ctx.tools.get(exec.name, exec.agent)) return { kind: 'deny' as const, reason: 'Discover this connector tool in the current conversation before calling it.' }
    const connector = resourceConnector ?? connectors.find(value => connectorToolPolicy([value], exec.name) !== 'unrelated')
    if (connector === undefined) return { kind: 'deny' as const, reason: 'Connector definition is missing.' }
    const live = parseConnectorCatalog(await product.invoke('connectors.list', { ids: [connector.id] }, exec.signal))
    const current = live.find(value => value.id === connector.id && value.transport === connector.transport)
    if (current === undefined) {
      return { kind: 'deny' as const, reason: 'This connector authorization is unavailable.' }
    }
    if (current.version !== connector.version) return { kind: 'deny' as const,
      reason: 'This connector configuration changed. Refresh the connector page to use the updated connector.' }
    const livePolicy = resourceConnector ? 'read-only' : connectorToolPolicy([current], exec.name)
    if (policy === 'undeclared' || livePolicy === 'undeclared' || livePolicy === 'unrelated') return { kind: 'deny' as const,
      reason: 'This connector tool is not declared in the enterprise catalog.' }
    if (policy === 'read-only' && livePolicy === 'read-only') return next()
    if (policy === 'write' || livePolicy === 'write') {
      return Promise.resolve({
        kind: 'ask' as const,
        reason: 'The enterprise connector operation may change business data.',
        displayReason: {
          en: 'Allow this enterprise connector to change business data?',
          'zh-CN': '允许这个企业连接器修改业务数据吗？',
        },
      })
    }
    return Promise.resolve({ kind: 'deny' as const,
      reason: 'This connector tool is not declared in the enterprise catalog.' })
  })
}
