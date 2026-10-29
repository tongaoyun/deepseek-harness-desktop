/** Production discovery exercised through a real Loader profile and native JSONL. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import NodePtcRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter, ToolCallId, createUserMessage, projectToolUpdates,
  type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, interruptedTurnClosers, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Approval, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import * as Runtime from '../src/runtime.ts'
import { connectorServerName } from '../src/deepseek-harness-connector-contract.ts'

const DISCOVER = 'connector_search_tools'
const serverName = connectorServerName('erp')
const publicName = (raw: string) => publicToolName(serverName, raw)
const discoveryMeta = z.object({ kind: z.literal('product-connector-tools-v1'), content: z.string() }).strict()
type Step = { name: string; arguments: Record<string, string | number | string[]> }

async function executeTool(ctx: Context, agent: Agent, name: string, args: Record<string, unknown>, callId: ToolCallId,
  signal = new AbortController().signal) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', name, id: callId, arguments: JSON.stringify(args) }],
    agent, signal })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`Executor omitted result for ${name}`)
  return result
}

/** Scripted model isolates protocol behavior; it does not measure model selection quality. */
class ScriptedModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly pending: Step[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const step = this.pending.shift()
    if (step) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', name: step.name,
        id: ToolCallId(`call-${this.requests.length}`), arguments: JSON.stringify(step.arguments) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture finished.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('proves scoped discovery over 300 ERP tools with native policy, approval, durable resume and disposal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'erp-tool-discovery-'))
  vi.stubEnv('DSH_HOME', home)
  const contexts: Context[] = []
  const runtimeFibers = new WeakMap<Context, ReturnType<Context['plugin']>>()
  const calls: string[] = []
  const protocol: string[] = []
  const approvals: string[] = []
  const answers: ApprovalOutcome[] = []
  let heldCatalog: { started: PromiseWithResolvers<null>; release: PromiseWithResolvers<null> } | undefined
  const modules = [['orders', '订单'], ['catalog', '商品'], ['warehouse', '库存'],
    ['logistics', '物流'], ['finance', '财务'], ['purchasing', '采购']] as const
  const definitions = modules.flatMap(([module, label]) => Array.from({ length: 50 }, (_, index) => ({
    name: index === 49 ? `${module}_write` : `${module}_read_${String(index).padStart(2, '0')}`,
    description: module === 'orders' && index === 49 ? '取消订单。修改订单状态，需要审批。'
      : `${label}${index === 49 ? '修改业务记录' : '查询业务明细'}，操作编号 ${index}。返回业务状态和更新时间。`,
    inputSchema: { type: 'object', properties: { recordId: { type: 'string', description: '业务记录 ID' } }, required: ['recordId'], additionalProperties: false },
    annotations: { readOnlyHint: index !== 49, destructiveHint: index === 49 },
  })))
  const undeclared = { ...definitions[0]!, name: 'undeclared_admin', description: 'Undeclared admin operation' }
  let available = true
  let imageResult = false
  let version = '1.0.0'
  let shadowConnector = false
  let missingNative = false
  let catalogFailure: Error | undefined
  let control: Runtime.DeepSeekHarnessRuntimeControl | undefined
  const credential = 'fixture-private-transport-only'
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      if (request.headers.authorization !== credential) { response.writeHead(401).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error('Expected MCP bytes')
        chunks.push(chunk)
      }
      const message = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string(),
        params: z.object({ name: z.string().optional() }).loose().optional() }).parse(JSON.parse(Buffer.concat(chunks).toString()))
      protocol.push(message.method)
      if (message.id === undefined) { response.writeHead(202).end(); return }
      if (message.method === 'tools/call') calls.push(message.params?.name ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result:
        message.method === 'initialize' ? { protocolVersion: '2025-03-26', instructions: 'ERP fixture instructions: use exact record identifiers.', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'erp-proof', version: '1' } }
          : message.method === 'tools/list' ? { tools: [...definitions, undeclared] }
            : message.method === 'resources/list' ? { resources: [{ uri: 'erp://orders/policy', name: 'Order policy' }] }
              : { content: imageResult && message.method === 'tools/call'
                ? [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]
                : [{ type: 'text', text: `Executed ${message.params?.name}` }] } }))
    })().catch(() => { response.writeHead(500).end() })
  })
  onTestFinished(async () => {
    heldCatalog?.release.resolve(null)
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing MCP fixture port')
  const names = definitions.map(tool => publicName(tool.name))
  const product: Runtime.Config['product'] = { async invoke(method, _payload, signal) {
    if (method === 'connectors.list' && catalogFailure) throw catalogFailure
    if (method === 'connectors.list' && heldCatalog) {
      heldCatalog.started.resolve(null)
      await heldCatalog.release.promise
      signal?.throwIfAborted()
    }
    if (method === 'connectors.list') {
      const ids = _payload === undefined ? undefined : z.object({ ids: z.array(z.string()) }).strict().parse(_payload).ids
      return available ? (shadowConnector ? ['erp', 'erp-shadow'] : ['erp']).filter(id => ids === undefined || ids.includes(id))
        .map(id => ({ id, version, name: 'ERP', status: 'ready', authMode: 'none',
          transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, arguments: [], environment: {}, headers: { Authorization: credential },
          tools: [...definitions.map(tool => ({ name: tool.name, access: tool.annotations.readOnlyHint ? 'READ' : 'WRITE' })),
            ...missingNative ? [{ name: 'missing_native', access: 'READ' }] : []] })) : []
    }
    if (method === 'knowledge.bases.list') return []
    throw new Error(`Unexpected product request ${method}`)
  } }
  const directory = join(home, 'profile')
  await mkdir(directory)
  initProfile(directory, [])
  const rows = [
    { id: 'prompt', name: 'cordis:prompt' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'agents', name: 'cordis:agents' }, { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'presets', name: 'cordis:presets', config: { default: 'minimal' } }, { id: 'approval', name: 'cordis:approval' },
    { id: 'mcp-resources', name: 'cordis:mcp-resources' },
    { id: 'fs', name: 'cordis:fs' }, { id: 'subprocess', name: 'cordis:subprocess' },
    { id: 'sandbox', name: 'cordis:sandbox', config: {} },
    { id: 'sandbox-policy', name: 'cordis:sandbox-policy', config: { mode: 'danger-full-access', workspaceRoot: home } },
    { id: 'working-directory', name: 'cordis:working-directory', config: { defaultDirectory: home } },
    { id: 'ptc', name: 'cordis:ptc', config: {} },
  ]
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  await writeFile(join(directory, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: [], dir: directory,
    patchPath: join(directory, 'cordis.patch.yml'), installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const start = async () => {
    const ctx = await boot('test', join(directory, 'cordis.yml'), readProfilePatches('test', profile), async (ctx) => {
      ctx.provide('profileContext', profile)
      ctx.provide('sessionQuery', { listSessions: async () => [] })
      Object.assign(ctx.loader.builtins, { prompt: SystemPrompt, tools: Tools, llm: Llm, sessions: Sessions,
        projections: SessionProjections, persistence: Jsonl, agents: Agents, loop: AgentLoop, presets: Presets, approval: Approval,
        'working-directory': WorkingDirectory, 'mcp-resources': McpResources, fs: FileSystem, subprocess: Subprocess,
        sandbox: Sandbox, 'sandbox-policy': SandboxPolicy, ptc: NodePtcRuntime,
      })
    })
    await ctx.plugin(NativeToolExecutor)
    const runtimeFiber = ctx.plugin({ inject: Runtime.inject, apply: (owner: Context) => Runtime.apply(owner, {
      product, connectorDiscovery: { maxLoadedTools: 8 }, publishControl(value) { control = value },
    }) })
    await runtimeFiber
    runtimeFibers.set(ctx, runtimeFiber)
    contexts.push(ctx)
    expect(ctx.tools.schemas().filter(tool => names.includes(tool.name))).toHaveLength(0)
    ctx.on('approval/request', (request) => {
      approvals.push(request.toolName)
      return Promise.resolve(answers.shift() ?? 'rejected')
    })
    return ctx
  }
  let adapterNumber = 0
  const create = async (ctx: Context, id: string, resume = false, seed?: readonly SessionEvent[]) => {
    const model = new ScriptedModel()
    const provider = `${id}-${++adapterNumber}`
    ctx.llm.registerAdapter([provider], model)
    const options = { agentOptions: { provider, model: 'fixture' } }
    const handle = resume ? await ctx.agents.resume({ resumeSessionId: SessionId(id), ...options })
      : await ctx.agents.create({ sessionId: SessionId(id), ...options, ...seed === undefined ? {} : { seed } })
    return { handle, model, provider }
  }
  const run = async (agent: Agent, model: ScriptedModel, steps: Step[]) => {
    const before = agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length
    model.pending.push(...steps)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ERP discovery fixture request.' }], source: { kind: 'user' } }))
    await vi.waitFor(() => { expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(before + 1) }, { timeout: 15_000 })
    expect(model.pending).toEqual([])
  }
  const discover = (query: string, limit: number): Step => ({ name: DISCOVER, arguments: { query, limit } })
  const exact = (toolNames: string[], connectorId = 'erp'): Step => ({ name: DISCOVER, arguments: { connectorId, toolNames } })
  const call = (raw: string): Step => ({ name: publicName(raw), arguments: { recordId: 'fixture-record' } })
  const ctx = await start()
  const runtimeOwner = runtimeFibers.get(ctx)?.ctx.fiber
  const conversationFibers = new Set<NonNullable<typeof runtimeOwner>>()
  const stopTracking = ctx.on('internal/plugin', (fiber) => {
    if (fiber.parent.fiber !== runtimeOwner) return
    if (fiber.uid === null) conversationFibers.delete(fiber)
    else conversationFibers.add(fiber)
  }, { global: true })
  onTestFinished(() => { stopTracking() })
  for (const id of ['scope-lifetime-first', 'scope-lifetime-second']) {
    const transient = await create(ctx, id)
    expect(conversationFibers.size).toBeGreaterThan(0)
    await transient.handle.dispose()
    await vi.waitFor(() => { expect(conversationFibers.size).toBe(0) })
  }
  const a = await create(ctx, 'erp-proof-a')
  const b = await create(ctx, 'erp-proof-b')
  expect(protocol.filter(method => method === 'initialize')).toHaveLength(1)
  expect(protocol.filter(method => method === 'tools/list')).toHaveLength(1)
  const resources = await executeTool(ctx, a.handle.agent, 'list_mcp_resources', { server: serverName }, ToolCallId('native-resource'))
  expect(resources.isError).toBe(false)
  expect(JSON.stringify(resources.content)).toContain('erp://orders/policy')
  expect(ctx.tools.schemas(a.handle.agent).filter(tool => names.includes(tool.name))).toEqual([])
  // A malicious/incorrect model cannot call an undiscovered registered tool directly.
  answers.push('rejected', 'allowed-once', 'rejected')
  await run(a.handle.agent, a.model, [call('orders_read_00'), discover('订单', 2), call('orders_read_00'),
    discover('取消订单', 1), call('orders_write'), call('orders_write'), call('orders_write')])
  expect(calls).toEqual(['orders_read_00', 'orders_write'])
  expect(approvals).toEqual(Array(3).fill(publicName('orders_write')))
  const events = a.handle.agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'approval/decided').map(event => event.data.outcome))
    .toEqual(['rejected', 'allowed-once', 'rejected'])
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.isError)).toHaveLength(3)
  expect(events.filter(event => event.type === 'developer/message').flatMap(event => event.data.message.content)
    .filter(block => block.type === 'tool-addition').map(block => block.toolName))
    .toEqual([publicName('orders_read_00'), publicName('orders_read_01'), publicName('orders_write')])
  const discoveryEnd = events.findIndex(event => event.type === 'tool/result'
    && discoveryMeta.safeParse(event.data.meta).success)
  expect(discoveryEnd).toBeGreaterThan(0)
  const interruptedPrefix = events.slice(0, discoveryEnd + 1)
  expect(interruptedPrefix.filter(event => event.type === 'request/header').at(-1)?.data.header.tools
    ?.some(tool => names.includes(tool.name))).toBe(false)
  const crash = await create(ctx, 'erp-proof-crash', false, [...interruptedPrefix, ...interruptedTurnClosers(interruptedPrefix)])
  expect(ctx.tools.schemas(crash.handle.agent).filter(tool => names.includes(tool.name))).toHaveLength(2)
  await crash.handle.dispose()
  expect(ctx.tools.schemas(b.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
  const first = a.model.requests[0]!
  expect(JSON.stringify(first.messages)).toContain('ERP fixture instructions: use exact record identifiers.')
  const afterDiscovery = a.model.requests[2]!
  expect(first.tools?.filter(tool => names.includes(tool.name))).toEqual([])
  expect(afterDiscovery.tools?.filter(tool => names.includes(tool.name))).toHaveLength(2)
  for (const mode of [undefined, 'in-history', 'addition-only'] as const) {
    const projected = projectToolUpdates(afterDiscovery.messages, afterDiscovery.tools, mode, afterDiscovery.toolHistory)
    expect(projected.tools?.filter(tool => names.includes(tool.name))).toHaveLength(2)
  }
  // Discovery bounds and undeclared metadata cannot widen the catalog.
  await run(b.handle.agent, b.model, [discover('查询', 11), discover('Undeclared', 10), discover('不存在', 2)])
  expect(ctx.tools.schemas(b.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
  expect(calls).toEqual(['orders_read_00', 'orders_write'])
  // Keep an unrelated native tool available; this mask applies only to the ERP namespace.
  expect(ctx.tools.schemas(a.handle.agent).some(tool => tool.name === 'knowledge_destinations')).toBe(true)
  available = false
  const resourceCalls = protocol.filter(method => method === 'resources/list').length
  expect((await executeTool(ctx, a.handle.agent, 'list_mcp_resources', { server: serverName }, ToolCallId('revoked-resource'))).isError).toBe(true)
  expect(protocol.filter(method => method === 'resources/list')).toHaveLength(resourceCalls)
  await run(a.handle.agent, a.model, [call('orders_read_00')])
  await run(b.handle.agent, b.model, [discover('库存', 1)])
  expect(ctx.tools.schemas(b.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
  available = true
  version = '2.0.0'
  await run(a.handle.agent, a.model, [call('orders_read_00')])
  version = '1.0.0'
  expect(calls).toEqual(['orders_read_00', 'orders_write'])
  // Simultaneous independent conversations discover different modules without rebuilding MCP.
  const callsBeforeParallel = calls.length
  const connectionsBeforeParallel = protocol.filter(method => method === 'initialize').length
  await Promise.all([
    run(a.handle.agent, a.model, [call('orders_read_00')]),
    run(b.handle.agent, b.model, [discover('库存', 1), call('warehouse_read_00')]),
  ])
  expect(calls.slice(callsBeforeParallel).sort()).toEqual(['orders_read_00', 'warehouse_read_00'])
  expect(protocol.filter(method => method === 'initialize')).toHaveLength(connectionsBeforeParallel)
  expect(ctx.tools.schemas(a.handle.agent).some(tool => tool.name === publicName('warehouse_read_00'))).toBe(false)
  expect(ctx.tools.schemas(b.handle.agent).some(tool => tool.name === publicName('orders_read_00'))).toBe(false)
  // Native JSONL, followed by a fresh Loader/context/MCP connection (no in-memory seed).
  const persistedEvents = a.handle.agent.session.snapshotEvents()
  await a.handle.dispose()
  await b.handle.dispose()
  await ctx.fiber.dispose()
  const restarted = await start()
  const restored = await create(restarted, 'erp-proof-a', true)
  const recoveredCrash = await create(restarted, 'erp-proof-crash', true)
  expect(restarted.tools.schemas(recoveredCrash.handle.agent).filter(tool => names.includes(tool.name))).toHaveLength(2)
  await recoveredCrash.handle.dispose()
  expect(ctx.get('tools')).toBeUndefined()
  expect(restarted.tools.schemas(restored.handle.agent).filter(tool => names.includes(tool.name))).toHaveLength(3)
  expect(restored.handle.agent.session.snapshotEvents().slice(0, persistedEvents.length)).toEqual(persistedEvents)
  const persisted = await restarted.sessionPersistence.open(SessionId('erp-proof-b'), 'read')
  try { expect((await persisted.read()).events.some(event => event.type === 'tool/result')).toBe(true) }
  finally { await persisted.close() }
  const baselineSchemas = definitions.map(tool => ({ name: publicName(tool.name), description: tool.description,
    parameters: tool.inputSchema }))
  const discoveredSchemas = afterDiscovery.tools!.filter(tool => names.includes(tool.name))
  const baselineBytes = Buffer.byteLength(JSON.stringify(baselineSchemas))
  const discoveredBytes = Buffer.byteLength(JSON.stringify(discoveredSchemas))
  const discoverySchema = first.tools!.find(tool => tool.name === DISCOVER)!
  const initialBytes = Buffer.byteLength(JSON.stringify([discoverySchema]))
  const selectedBytes = Buffer.byteLength(JSON.stringify([discoverySchema, ...discoveredSchemas]))
  expect(baselineSchemas).toHaveLength(300)
  expect(discoveredBytes).toBeLessThan(baselineBytes / 50)
  const evidence = { catalogTools: baselineSchemas.length, initialErpTools: 0, discoveredErpTools: discoveredSchemas.length,
    baselineSchemaBytes: baselineBytes, discoveredSchemaBytes: discoveredBytes,
    initialDiscoverySchemaBytes: initialBytes, selectedSchemaBytesIncludingDiscovery: selectedBytes,
    successfulReadCalls: calls.filter(name => name.endsWith('read_00')).length,
    successfulWriteCalls: calls.filter(name => name.endsWith('write')).length,
    approvalOutcomes: ['rejected', 'allowed-once', 'rejected'],
    sessionIsolated: true, parallelDiscoveryIsolated: true, resumedFromNativeJsonl: true, recoveredBeforeNextRequestHeader: true }
  expect(JSON.stringify(restored.handle.agent.session.snapshotEvents())).not.toContain(credential)
  await restored.handle.dispose()
  // Search reformulations are model inputs in the native log; they do not call business tools.
  const reformulations = [
    { query: '撤销交易', queryVariants: ['取消订单', 'cancel order'], expected: 'orders_write' },
    { query: 'ERP取消订单', expected: 'orders_write' },
    { query: 'orders_read_07', expected: 'orders_read_07' },
    { query: 'ERP' },
    { query: 'id' },
    { query: '撤销交易' },
  ]
  const searchEvidence: Array<{ query: string; queryVariants?: string[]; toolNames: string[] }> = []
  const searchCallsBefore = calls.length
  for (const [index, { expected, ...query }] of reformulations.entries()) {
    const search = await create(restarted, `erp-reformulation-${index}`)
    await run(search.handle.agent, search.model, [{ name: DISCOVER, arguments: { ...query, limit: 1 } }])
    const result = search.handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)
    if (result?.type !== 'tool/result' || result.data.message.isError) throw new Error('Missing search reformulation result')
    const content = result.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const found = z.object({ tools: z.array(z.object({ toolName: z.string() })) }).parse(JSON.parse(content))
    expect(found.tools.map(tool => tool.toolName)).toEqual(expected ? [expected] : [])
    expect(restarted.tools.schemas(search.handle.agent).filter(tool => names.includes(tool.name)).map(tool => tool.name))
      .toEqual(expected ? [publicName(expected)] : [])
    expect(JSON.stringify(search.model.requests.at(-1)?.messages)).toContain(query.query)
    for (const variant of query.queryVariants ?? []) expect(JSON.stringify(search.model.requests.at(-1)?.messages)).toContain(variant)
    expect(JSON.stringify(search.handle.agent.session.snapshotEvents())).not.toContain(credential)
    searchEvidence.push({ ...query, toolNames: found.tools.map(tool => tool.toolName) })
    await search.handle.dispose()
    if (index === 0) {
      const recovered = await create(restarted, `erp-reformulation-${index}`, true)
      expect(restarted.tools.schemas(recovered.handle.agent).filter(tool => names.includes(tool.name)).map(tool => tool.name))
        .toEqual([publicName('orders_write')])
      expect(recovered.handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/call').at(-1))
        .toMatchObject({ data: { arguments: JSON.stringify({ ...query, limit: 1 }) } })
      await recovered.handle.dispose()
    }
  }
  expect(calls).toHaveLength(searchCallsBefore)
  // Exact references bypass keyword ranking, preserve raw identities and retain native write approval.
  const precise = await create(restarted, 'erp-exact')
  await run(precise.handle.agent, precise.model, [discover('完全不相关的别名', 1)])
  expect(restarted.tools.schemas(precise.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
  answers.push('rejected', 'allowed-once')
  const beforeExact = calls.length
  await run(precise.handle.agent, precise.model, [exact(['orders_read_07', 'finance_write']),
    call('orders_read_07'), call('finance_write'), call('finance_write')])
  expect(calls.slice(beforeExact)).toEqual(['orders_read_07', 'finance_write'])
  const exactEvents = precise.handle.agent.session.snapshotEvents()
  const exactResult = exactEvents.filter(event => event.type === 'tool/result' && !event.data.message.isError
    && discoveryMeta.safeParse(event.data.meta).success).at(-1)
  if (exactResult?.type !== 'tool/result') throw new Error('Missing exact result')
  const exactContent = exactResult.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const recordedExact: unknown = JSON.parse(exactContent)
  expect(exactContent).toContain('"connectorId":"erp"')
  expect(exactContent).toContain('"toolName":"orders_read_07"')
  const exactEnd = exactEvents.indexOf(exactResult)
  const exactPrefix = exactEvents.slice(0, exactEnd + 1)
  const exactCrash = await create(restarted, 'erp-exact-crash', false, [...exactPrefix, ...interruptedTurnClosers(exactPrefix)])
  expect(restarted.tools.schemas(exactCrash.handle.agent).filter(tool => names.includes(tool.name)).map(tool => tool.name).sort())
    .toEqual([publicName('orders_read_07'), publicName('finance_write')].sort())
  await exactCrash.handle.dispose()
  expect(JSON.stringify(exactEvents)).not.toContain(credential)
  await precise.handle.dispose()
  const preciseRestored = await create(restarted, 'erp-exact', true)
  expect(restarted.tools.schemas(preciseRestored.handle.agent).filter(tool => names.includes(tool.name))).toHaveLength(2)
  await preciseRestored.handle.dispose()
  const invalidExact = await create(restarted, 'erp-exact-invalid')
  const expectExactFailure = async (step: Step, message: string) => {
    const before = calls.length
    await run(invalidExact.handle.agent, invalidExact.model, [step])
    const result = invalidExact.handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)
    expect(result).toMatchObject({ data: { message: { isError: true } } })
    expect(JSON.stringify(result)).toContain(message)
    expect(restarted.tools.schemas(invalidExact.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
    expect(calls).toHaveLength(before)
  }
  await expectExactFailure(exact(['orders_read_08', 'undeclared_admin']), '未声明或已移除')
  await expectExactFailure(exact(['orders_read_08', 'Orders_read_00']), '未声明或已移除')
  await expectExactFailure(exact(['orders_read_00'], 'not-erp'), '不存在或当前无权访问')
  catalogFailure = new Error('Fixture network unavailable')
  await expectExactFailure(exact(['orders_read_08']), 'Fixture network unavailable')
  catalogFailure = undefined
  for (const step of [exact([]), exact(['orders_read_00', 'orders_read_00']),
    exact(definitions.slice(0, 9).map(tool => tool.name)),
    { name: DISCOVER, arguments: { query: '订单', connectorId: 'erp', toolNames: ['orders_read_00'] } },
    { name: DISCOVER, arguments: { connectorId: 'erp', toolNames: ['orders_read_00'], limit: 1 } },
    { name: DISCOVER, arguments: { connectorId: 'erp', toolNames: ['orders_read_00'], queryVariants: ['订单'] } },
    { name: DISCOVER, arguments: { query: '订单', queryVariants: Array(5).fill('订单') } },
    { name: DISCOVER, arguments: { query: '订单', queryVariants: ['？！'] } },
    { name: DISCOVER, arguments: { query: '订单', queryVariants: ['x'.repeat(201)] } },
    { name: DISCOVER, arguments: { connectorId: 'erp' } }]) {
    await expectExactFailure(step, '两种方式不能混用')
  }
  available = false
  await expectExactFailure(exact(['orders_read_08']), '不存在或当前无权访问')
  available = true
  version = '2.0.0'
  await expectExactFailure(exact(['orders_read_08']), '版本已变更')
  version = '1.0.0'
  const exactControl = control
  if (!exactControl) throw new Error('Missing exact runtime control')
  missingNative = true
  shadowConnector = true
  await expectExactFailure(exact(['orders_read_08'], 'erp-shadow'), '尚未连接')
  await exactControl.refreshConnectors()
  await expectExactFailure(exact(['orders_read_08', 'missing_native']), '未由 MCP 服务提供')
  await invalidExact.handle.dispose()
  const shadow = await create(restarted, 'erp-exact-shadow')
  const shadowName = publicToolName(connectorServerName('erp-shadow'), 'orders_read_08')
  await run(shadow.handle.agent, shadow.model, [exact(['orders_read_08'], 'erp-shadow'),
    { name: shadowName, arguments: { recordId: 'shadow' } }])
  expect(restarted.tools.schemas(shadow.handle.agent).some(tool => tool.name === shadowName)).toBe(true)
  expect(restarted.tools.schemas(shadow.handle.agent).some(tool => tool.name === publicName('orders_read_08'))).toBe(false)
  expect(calls.at(-1)).toBe('orders_read_08')
  await shadow.handle.dispose()
  missingNative = false
  shadowConnector = false
  await exactControl.refreshConnectors()
  const capacity = await create(restarted, 'erp-exact-capacity')
  const seven = definitions.slice(10, 17).map(tool => tool.name)
  await run(capacity.handle.agent, capacity.model, [exact(seven), exact(['orders_read_17', 'orders_read_18'])])
  expect(restarted.tools.schemas(capacity.handle.agent).filter(tool => names.includes(tool.name))).toHaveLength(7)
  expect(restarted.tools.schemas(capacity.handle.agent).some(tool => tool.name === publicName('orders_read_17'))).toBe(false)
  await run(capacity.handle.agent, capacity.model, [exact(['orders_read_17']), exact(seven)])
  expect(restarted.tools.schemas(capacity.handle.agent).filter(tool => names.includes(tool.name))).toHaveLength(8)
  await capacity.handle.dispose()
  const cancelled = await create(restarted, 'erp-proof-cancel')
  const controller = new AbortController()
  heldCatalog = { started: Promise.withResolvers<null>(), release: Promise.withResolvers<null>() }
  const cancelling = executeTool(restarted, cancelled.handle.agent, DISCOVER,
    { connectorId: 'erp', toolNames: ['catalog_read_00'] }, ToolCallId('cancel-discovery'), controller.signal)
  await heldCatalog.started.promise
  controller.abort(new Error('Cancel ERP discovery'))
  heldCatalog.release.resolve(null)
  expect((await cancelling).isError).toBe(true)
  heldCatalog = undefined
  expect(restarted.tools.schemas(cancelled.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
  await cancelled.handle.dispose()
  // Refresh hides the background generation, keeps loaded schemas pinned and recovers identical definitions.
  const refreshControl = control
  if (!refreshControl) throw new Error('Missing runtime control')
  const refreshAgent = await create(restarted, 'erp-refresh')
  await run(refreshAgent.handle.agent, refreshAgent.model, [discover('库存', 1)])
  heldCatalog = { started: Promise.withResolvers<null>(), release: Promise.withResolvers<null>() }
  const refreshing = refreshControl.refreshConnectors()
  await heldCatalog.started.promise
  expect(restarted.tools.schemas().some(tool => names.includes(tool.name))).toBe(false)
  expect((await executeTool(restarted, refreshAgent.handle.agent, publicName('warehouse_read_00'), { recordId: 'x' }, ToolCallId('during-refresh'))).isError).toBe(true)
  heldCatalog.release.resolve(null)
  await refreshing
  heldCatalog = undefined
  const refreshCalls = calls.length
  await run(refreshAgent.handle.agent, refreshAgent.model, [call('warehouse_read_00')])
  expect(calls.slice(refreshCalls)).toEqual(['warehouse_read_00'])
  imageResult = true
  const richResult = await executeTool(restarted, refreshAgent.handle.agent, publicName('warehouse_read_00'),
    { recordId: 'rich-result' }, ToolCallId('rich-after-refresh'))
  imageResult = false
  expect(richResult.isError).toBe(false)
  expect(JSON.stringify(richResult.content)).toContain('no attachment store is mounted')
  const newDefinition = { ...definitions[0]!, name: 'returns_read', description: '退货售后查询' }
  definitions.push(newDefinition)
  await refreshControl.refreshConnectors()
  expect(restarted.tools.schemas().some(tool => tool.name === publicName('returns_read'))).toBe(false)
  await run(refreshAgent.handle.agent, refreshAgent.model, [discover('退货', 1), call('returns_read')])
  expect(calls.at(-1)).toBe('returns_read')
  await refreshAgent.handle.dispose()
  // Subagents keep independent discoveries; denying the global discovery capability cannot be bypassed.
  const parent = await create(restarted, 'erp-parent')
  await run(parent.handle.agent, parent.model, [discover('订单', 1)])
  const childModel = new ScriptedModel()
  restarted.llm.registerAdapter(['child'], childModel)
  const child = await restarted.agents.create({ sessionId: SessionId('erp-child'), parentAgent: parent.handle.agent,
    agentOptions: { provider: 'child', model: 'fixture' }, setup(owner) { owner.tools.restrict({ deny: [DISCOVER] }) } })
  expect(restarted.tools.schemas(child.agent).some(tool => names.includes(tool.name))).toBe(false)
  await run(child.agent, childModel, [discover('库存', 1), call('orders_read_00')])
  expect(restarted.tools.schemas(child.agent).some(tool => names.includes(tool.name))).toBe(false)
  await child.dispose()
  await parent.handle.dispose()
  const ptc = await create(restarted, 'erp-ptc')
  await ptc.handle.agent.ctx.plugin(PtcToolExecutor, { maxParallelSubCalls: 10 })
  const ptcCalls = calls.length
  await run(ptc.handle.agent, ptc.model, [call('catalog_read_00')])
  expect(calls).toHaveLength(ptcCalls)
  expect(ptc.handle.agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.isError)).toBe(true)
  await run(ptc.handle.agent, ptc.model, [
    { name: 'run_code', arguments: { description: 'Discover the catalog lookup tool',
      code: `return await tools.${DISCOVER}({ connectorId: "erp", toolNames: ["catalog_read_00"] });` } },
    { name: 'run_code', arguments: { description: 'Read the selected catalog record',
      code: `return await tools.${publicName('catalog_read_00')}({ recordId: "ptc" });` } },
  ])
  expect(calls.slice(ptcCalls), JSON.stringify(ptc.handle.agent.session.snapshotEvents()
    .filter(event => event.type === 'tool/result' || event.type === 'tool/ptc-dispatch'))).toEqual(['catalog_read_00'])
  expect(ptc.model.requests.every(request => request.tools?.map(tool => tool.name).join() === 'run_code')).toBe(true)
  expect(JSON.stringify(ptc.model.requests.at(-1)?.messages)).toContain(publicName('catalog_read_00'))
  expect(JSON.stringify(ptc.model.requests.at(-1)?.messages)).not.toContain(publicName('finance_read_00'))
  expect(ptc.handle.agent.session.snapshotEvents().some(event => event.type === 'tool/ptc-dispatch' && event.data.name === DISCOVER && !event.data.isError)).toBe(true)
  await ptc.handle.dispose()
  const ptcRestored = await create(restarted, 'erp-ptc', true)
  ptcRestored.handle.agent.model.select({ provider: ptcRestored.provider, model: 'fixture' })
  await ptcRestored.handle.agent.ctx.plugin(PtcToolExecutor, { maxParallelSubCalls: 10 })
  expect(restarted.tools.schemas(ptcRestored.handle.agent).some(tool => tool.name === publicName('catalog_read_00'))).toBe(true)
  await run(ptcRestored.handle.agent, ptcRestored.model, [
    { name: 'run_code', arguments: { description: 'Read the restored catalog record',
      code: `return await tools.${publicName('catalog_read_00')}({ recordId: "ptc-restored" });` } },
  ])
  expect(calls.slice(ptcCalls)).toEqual(['catalog_read_00', 'catalog_read_00'])
  const ptcEvidence = {
    calls: calls.slice(ptcCalls),
    modelTools: ptc.model.requests.at(-1)?.tools?.map(tool => tool.name),
    resumedResult: ptcRestored.handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/result').at(-1)?.data.message.content,
  }
  await ptcRestored.handle.dispose()
  const ptcDiscovery = ptc.handle.agent.session.snapshotEvents().find(event => event.type === 'tool/ptc-dispatch'
    && event.data.name === DISCOVER && !event.data.isError)
  if (ptcDiscovery?.type !== 'tool/ptc-dispatch') throw new Error('Missing PTC discovery recording')
  for (const [id, content] of [['missing', undefined], ['malformed', '{']] as const) {
    const damagedPtc = await create(restarted, `erp-ptc-${id}`)
    const data = structuredClone(ptcDiscovery.data)
    if (content === undefined) delete data.meta
    else data.meta = { kind: 'product-connector-tools-v1', content }
    damagedPtc.handle.agent.session.append('tool/ptc-dispatch', data)
    const callsBefore = calls.length
    const denied = await executeTool(restarted, damagedPtc.handle.agent, DISCOVER,
      { connectorId: 'erp', toolNames: ['catalog_read_00'] }, ToolCallId(`ptc-${id}-direct`))
    expect(denied.isError).toBe(true)
    expect(calls).toHaveLength(callsBefore)
    expect(restarted.tools.schemas(damagedPtc.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
    await damagedPtc.handle.dispose()
  }
  // Complete UTF-8 output is bounded before installing any definition.
  const oversized = { ...definitions[0]!, name: 'oversized_read', description: 'oversizedunique ' + '中文'.repeat(10_000) }
  definitions.push(oversized)
  await refreshControl.refreshConnectors()
  const bounded = await create(restarted, 'erp-bounded')
  await run(bounded.handle.agent, bounded.model, [discover('oversizedunique', 1), exact(['orders_read_08', 'oversized_read'])])
  expect(bounded.handle.agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.isError)).toBe(true)
  expect(restarted.tools.schemas(bounded.handle.agent).some(tool => tool.name === publicName('oversized_read'))).toBe(false)
  expect(restarted.tools.schemas(bounded.handle.agent).some(tool => tool.name === publicName('orders_read_08'))).toBe(false)
  await bounded.handle.dispose()
  definitions.pop()
  await refreshControl.refreshConnectors()
  // Post-execution rejection cannot leave unlogged definitions visible to the following request.
  const rejected = await create(restarted, 'erp-post-policy')
  const rejectDiscovery = restarted.on('tools/post-execute', async (exec, _result, next) => exec.name === DISCOVER
    ? { kind: 'block', feedback: [{ type: 'text', text: 'Fixture rejects discovery result.' }] } : next())
  await run(rejected.handle.agent, rejected.model, [discover('财务', 1)])
  rejectDiscovery()
  expect(restarted.tools.schemas(rejected.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
  await rejected.handle.dispose()
  const damaged = await create(restarted, 'erp-live-damaged')
  await run(damaged.handle.agent, damaged.model, [discover('库存', 1)])
  const damagedEvents = damaged.handle.agent.session.snapshotEvents()
  const discoveryCall = damagedEvents.find(event => event.type === 'tool/call' && event.data.name === DISCOVER)
  const discoveryResult = damagedEvents.find(event => event.type === 'tool/result' && discoveryMeta.safeParse(event.data.meta).success)
  if (discoveryCall?.type !== 'tool/call' || discoveryResult?.type !== 'tool/result') throw new Error('Missing discovery recording')
  damaged.handle.agent.session.append('tool/call', { ...discoveryCall.data, callId: ToolCallId('damaged-discovery') })
  damaged.handle.agent.session.append('tool/result', { ...discoveryResult.data,
    message: { ...discoveryResult.data.message, toolCallId: ToolCallId('damaged-discovery'),
      source: { kind: 'tool', callId: ToolCallId('damaged-discovery') } },
    meta: { kind: 'product-connector-tools-v1', content: '{' } }, { surfaceOp: 'append' })
  const beforeDamaged = calls.length
  expect((await executeTool(restarted, damaged.handle.agent, publicName('warehouse_read_00'),
    { recordId: 'damaged' }, ToolCallId('damaged-direct'))).isError).toBe(true)
  expect(calls).toHaveLength(beforeDamaged)
  await damaged.handle.dispose()
  const corruptPrefix = structuredClone(interruptedPrefix)
  for (const event of corruptPrefix) {
    if (event.type === 'tool/result' && discoveryMeta.safeParse(event.data.meta).success) event.data.meta = { kind: 'product-connector-tools-v1', content: '{' }
  }
  const corrupt = await create(restarted, 'erp-corrupt', false, [...corruptPrefix, ...interruptedTurnClosers(corruptPrefix)])
  const corruptErrors: unknown[] = []
  const stopCorrupt = restarted.on('agent/error', ({ agent, error }) => { if (agent === corrupt.handle.agent) corruptErrors.push(error) })
  corrupt.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Keep history.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(corruptErrors).toHaveLength(1) })
  expect(corruptErrors[0]).toMatchObject({ code: 'CONNECTOR_TOOL_SNAPSHOT_INVALID' })
  expect(corrupt.model.requests).toEqual([])
  expect(corrupt.handle.agent.session.snapshotEvents().slice(0, corruptPrefix.length)).toEqual(corruptPrefix)
  stopCorrupt()
  await corrupt.handle.dispose()
  const unpinnedEvents = structuredClone(persistedEvents)
  for (const event of unpinnedEvents) {
    if (event.type === 'tool/call' && event.data.name === DISCOVER) event.data.name = 'previous-directory-tool'
  }
  const unpinned = await create(restarted, 'erp-unpinned', false, unpinnedEvents)
  const missingErrors: unknown[] = []
  const stopMissing = restarted.on('agent/error', ({ agent, error }) => { if (agent === unpinned.handle.agent) missingErrors.push(error) })
  unpinned.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(missingErrors).toHaveLength(1) })
  expect(missingErrors[0]).toMatchObject({ code: 'CONNECTOR_TOOL_SNAPSHOT_MISSING' })
  expect(unpinned.model.requests).toEqual([])
  stopMissing()
  await unpinned.handle.dispose()
  // Schema changes must block a resumed task, not silently replace its historical tool definition.
  definitions[0]!.description = 'Changed ERP meaning'
  await restarted.fiber.dispose()
  const changed = await start()
  const exactRestarted = await create(changed, 'erp-exact', true)
  expect(changed.tools.schemas(exactRestarted.handle.agent).filter(tool => names.includes(tool.name))).toHaveLength(2)
  await exactRestarted.handle.dispose()
  const blocked = await create(changed, 'erp-proof-a', true)
  const beforeCalls = [...calls]
  const beforeRequests = blocked.model.requests.length
  blocked.handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check changed schema.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(blocked.handle.agent.session.snapshotEvents().some(event => JSON.stringify(event).includes('已加载的连接器工具已变更'))).toBe(true) })
  expect(blocked.model.requests).toHaveLength(beforeRequests)
  expect(calls).toEqual(beforeCalls)
  await blocked.handle.dispose()
  const isolated = await create(changed, 'erp-proof-isolated')
  expect(changed.tools.schemas(isolated.handle.agent).some(tool => names.includes(tool.name))).toBe(false)
  await isolated.handle.dispose()
  // Owner disposal removes both masks and the registrations it introduced.
  const live = await create(changed, 'erp-proof-unload')
  await run(live.handle.agent, live.model, [discover('库存', 1)])
  const proofFiber = runtimeFibers.get(changed)
  expect(proofFiber).toBeDefined()
  heldCatalog = { started: Promise.withResolvers<null>(), release: Promise.withResolvers<null>() }
  const pendingDiscovery = executeTool(changed, live.handle.agent, DISCOVER, { query: '商品', limit: 1 }, ToolCallId('unload-discovery'))
  await heldCatalog.started.promise
  const unloading = proofFiber?.dispose()
  heldCatalog.release.resolve(null)
  expect((await pendingDiscovery).isError).toBe(true)
  await unloading
  heldCatalog = undefined
  expect(changed.tools.schemas(live.handle.agent).some(tool => tool.name === DISCOVER)).toBe(false)
  expect(changed.tools.schemas(live.handle.agent).filter(tool => names.includes(tool.name))).toHaveLength(0)
  await live.handle.dispose()
  await expect(JSON.stringify({ ...evidence, discoverySchema, searchEvidence, exactContent: recordedExact, ptcExecution: ptcEvidence,
    exactReferencesAtomic: true, exactReferencesKeepApproval: true, exactReferencesResume: true, exactConnectorIdentity: true,
    exactCapacityAtomic: true, exactNetworkFailurePreserved: true,
    cancelledDiscoveryAddsNoTools: true, changedDefinitionBlocksModelRequest: true,
    disposalRemovesDiscoveryEffects: true, refreshKeepsCatalogPrivate: true, richResultsAfterRefresh: true,
    corruptHistoryBlocksDirectExecution: true, dynamicToolsRequireDiscovery: true, childFilterRespected: true, nativeResourcesAndInstructions: true, ptcDiscoveryAndResume: true, oversizedResultsAddNoTools: true, rejectedResultsAddNoTools: true, corruptHistoryIsolated: true, unloadCancelsDiscovery: true, unpinnedHistoryBlocked: true }, null, 2) + '\n')
    .toMatchFileSnapshot(join(import.meta.dirname, 'expected/erp-tool-discovery.json'))
}, 60_000)
