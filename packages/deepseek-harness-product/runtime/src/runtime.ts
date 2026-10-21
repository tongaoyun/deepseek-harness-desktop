/** Enterprise connectors and task-scoped knowledge on public Harness extension points. */
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-session-query'
import type { ProductTaskCapabilityRequest, ProductTaskCapabilityResult, ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { ProductError } from '@deepseek-harness/product/errors'
import { createTaskCapabilities } from './tasks.ts'
import * as KnowledgeLibrary from './knowledge-library.ts'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import { connectorServerName, connectorToolPolicy, parseConnectorCatalog, type DeepSeekHarnessConnector as Connector } from './deepseek-harness-connector-contract.ts'
import { objectRecord, stringField } from './response-fields.ts'

const KNOWLEDGE_PLUGIN = import.meta.resolve('@deepseek-harness/product-runtime/knowledge')
export const inject = ['agentPresets', 'agents', 'sessionQuery', 'sessionProjections', 'systemPrompt', 'tools']
export interface DeepSeekHarnessRuntimeControl {
  readCapabilities(request: ProductTaskCapabilityRequest, signal?: AbortSignal): Promise<ProductTaskCapabilities>
  prepareCapabilities(request: ProductTaskCapabilityRequest, signal?: AbortSignal): Promise<ProductTaskCapabilityResult>
}
export interface Config {
  readonly product: Pick<DeepSeekHarnessProductIpc, 'invoke'>
  readonly publishControl: (control: DeepSeekHarnessRuntimeControl | undefined) => void
}
/** Register knowledge selection and authorized enterprise tools for native Agents, including subagents. */
export async function apply(ctx: Context, config: Config): Promise<void> {
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
  const connectorsByAgent = new Map<Agent, readonly Connector[]>()
  const failures = new Map<Agent, unknown>()
  const connectorFibers = new Map<Agent, Fiber>()
  const lifetime = new AbortController()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Product runtime unloaded'))
    await Promise.allSettled([...connectorFibers.values()].map(fiber => fiber.dispose()))
    connectorFibers.clear()
    connectorsByAgent.clear()
    failures.clear()
  }, 'product-runtime.agent-connectors')
  installConnectorPolicy(ctx, connectorsByAgent, config.product)
  ctx.on('agent/created', async ({ agent, signal }) => {
    const operationSignal = AbortSignal.any([lifetime.signal, ...signal === undefined ? [] : [signal]])
    const fiber = agent.ctx.plugin({ name: 'product-agent-connectors', async apply(owner: Context) {
      const selected = parseConnectorCatalog(await config.product.invoke('connectors.list', undefined, operationSignal))
      owner.effect(() => () => { connectorsByAgent.delete(agent); failures.delete(agent) }, 'product-agent-connectors.policy')
      const connected = await Promise.all(selected.map(async (connector) => {
        const child = owner.plugin({ name: McpClient.name, inject: McpClient.inject, apply: McpClient.apply }, connectorConfig(connector))
        try { await child; return connector }
        catch {
          await child.dispose()
          operationSignal.throwIfAborted()
          owner.logger.warn(`Enterprise connector ${connector.id} could not start; its tools are unavailable for this conversation.`)
          return undefined
        }
      }))
      operationSignal.throwIfAborted()
      const available = connected.filter(connector => connector !== undefined)
      const unavailable = selected.filter(connector => !available.includes(connector))
      connectorsByAgent.set(agent, available)
      const versions = (connectors: readonly Connector[]) => connectors.map(({ id, version }) => ({ id, version }))
      owner.effect(() => owner.systemPrompt.section({ name: 'enterprise-connectors', order: 450,
        interpolate: false,
        text: `Enterprise connector versions: ${JSON.stringify(versions(available))}`
          + (unavailable.length === 0 ? '' : `\nUnavailable enterprise connectors: ${JSON.stringify(unavailable.map(({ id, name }) => ({ id, name })))}. Their tools could not connect. If a task needs them, explain the missing capability and ask the user to retry in a new conversation; do not claim their operations succeeded.`),
      }), 'product-agent-connectors.versions')
    } })
    connectorFibers.set(agent, fiber)
    try { await fiber }
    catch (error) {
      await fiber.dispose()
      failures.set(agent, error)
      agent.ctx.effect(() => () => { failures.delete(agent) }, 'product-agent-connectors.failure')
    }
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => { connectorFibers.delete(agent); failures.delete(agent); connectorsByAgent.delete(agent) })
  ctx.on('agent-preset/resolve-selection', async (agent, _requested, next) => tasks.resolveSelection(agent.session.id, await next()))
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const failure = failures.get(agent)
    if (failure !== undefined) throw new ProductError('CONNECTOR_STARTUP_FAILED',
      'Enterprise connector catalog could not load. Check your login and product service, then retry in a new conversation.', true, [], { cause: failure })
    await tasks.validate(ctx.agentPresets.composedPreset(agent.ctx), signal)
    return next()
  })
  config.publishControl({ readCapabilities: request => tasks.read(request),
    prepareCapabilities: (request, signal) => tasks.prepare(request, signal) })
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
  connectorsByAgent: ReadonlyMap<Agent, readonly Connector[]>,
  product: Config['product'],
): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const connectors = exec.agent === undefined ? [] : connectorsByAgent.get(exec.agent) ?? []
    const policy = connectorToolPolicy(connectors, exec.name)
    if (policy === 'unrelated') return next()
    const connector = connectors.find(value => connectorToolPolicy([value], exec.name) !== 'unrelated')
    if (connector === undefined) return { kind: 'deny' as const, reason: 'Connector definition is missing.' }
    const live = parseConnectorCatalog(await product.invoke('connectors.list', { ids: [connector.id] }, exec.signal))
    const current = live.find(value => value.id === connector.id && value.transport === connector.transport)
    if (current === undefined) {
      return { kind: 'deny' as const, reason: 'This connector authorization is unavailable.' }
    }
    if (current.version !== connector.version) return { kind: 'deny' as const,
      reason: 'This connector configuration changed. Start a new task to use the updated connector.' }
    const livePolicy = connectorToolPolicy([current], exec.name)
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
