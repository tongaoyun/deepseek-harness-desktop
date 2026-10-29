import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Skills from '@deepseek-ai/dsh-skill'
import * as FileSkills from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client'
import { productFailure } from '@deepseek-harness/product/errors'
import { connectorServerName } from '../src/deepseek-harness-connector-contract.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Runtime from '../src/index.ts'
const emitMessage = (message: object) => EventEmitter.prototype.emit.call(process, 'message', message)
const ordersRead = publicToolName(connectorServerName('erp'), 'orders_read')
const ordersWrite = publicToolName(connectorServerName('erp'), 'orders_write')
const undeclared = publicToolName(connectorServerName('erp'), 'undeclared')

async function executeTool(ctx: Context, agent: Parameters<Context['tools']['execute']>[0]['agent'], name: string,
  args: Record<string, unknown>, callId: ToolCallId, signal = new AbortController().signal) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', name, id: callId, arguments: JSON.stringify(args) }], ...agent === undefined ? {} : { agent }, signal })
  const result = batch.results[0]?.result
  if (result === undefined) throw new Error(`Executor omitted result for ${name}`)
  return result
}

class FixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const calls = [
      { id: 'read-native-skill', name: 'skill', arguments: '{"name":"policy-review"}' },
      { id: 'discover-orders', name: 'connector_search_tools', arguments: '{"connectorId":"erp","toolNames":["orders_read","orders_write"]}' },
      { id: 'read-orders', name: ordersRead, arguments: '{}' },
      { id: 'retrieve-policy', name: 'knowledge_search', arguments: '{"query":"policy","limit":2}' },
      { id: 'read-policy-source', name: 'knowledge_read', arguments: '{"sourceId":"source"}' },
    ]
    const call = calls[this.requests.length - 1]
    if (call !== undefined) {
      const block = { type: 'tool-call' as const, ...call, id: ToolCallId(call.id) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recorded policy retrieved.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('loads native skills with authorized MCP and exact knowledge scope, replays after restart and removes runtime effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-native-loader-'))
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  const before = process.listenerCount('message')
  const descriptors = new Map(['connected', 'send'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]))
  const selection: { id: string | undefined } = { id: undefined }
  const responseWaiters = new Map<number, (response: Record<string, unknown>) => void>()
  const policyHit = { sourceId: 'source', knowledgeBaseId: 'policy', knowledgeBaseName: 'Policy',
    documentId: 'document', filename: 'Policy.md', locator: 'section-1', content: 'Recorded enterprise policy.', score: 0.9 }
  let connectorReady = true
  let mcpAvailable = true
  let connectorVersion = '1.0.0'
  const relayCredential = 'private-relay-fixture'
  let readAccess = 'READ'
  const mcpCalls: string[] = []
  const mcpRequests: string[] = []
  let catalogReads = 0
  let catalogInvalid = false
  let catalogPending = false
  let pendingCatalog: string | undefined
  let holdBrokenStartup = true
  let brokenStartupPending = false
  let releaseBrokenStartup!: () => void
  const brokenStartup = new Promise<void>((resolve) => { releaseBrokenStartup = resolve })
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/broken' && holdBrokenStartup) { brokenStartupPending = true; await brokenStartup }
      if (!mcpAvailable || request.url === '/broken') { response.writeHead(503).end(); return }
      if (request.headers.authorization !== relayCredential) { response.writeHead(401).end(); return }
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error('MCP fixture expected request bytes')
        chunks.push(chunk)
      }
      const call = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { name?: string } }
      mcpRequests.push(call.method)
      if (call.id === undefined) { response.writeHead(202).end(); return }
      if (call.method === 'tools/call') mcpCalls.push(call.params?.name ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id,
        result: call.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} },
          serverInfo: { name: 'fixture-orders', version: '1' } }
          : call.method === 'tools/list' ? { tools: ['orders_read', 'orders_write', 'undeclared'].map(name => ({ name,
            inputSchema: { type: 'object', properties: {} } })) }
            : { content: [{ type: 'text', text: 'Recorded order facts.' }] },
      }))
    })().catch(() => { response.writeHead(500).end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server has no port')
  const connector = () => ({ id: 'erp', version: connectorVersion, name: 'Orders', status: connectorReady ? 'ready' : 'unavailable', authMode: 'oauth', authorizationStatus: 'AUTHORIZED',
    timeoutSeconds: 120,
    transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, arguments: [], environment: {},
    headers: { Authorization: relayCredential }, tools: [{ name: 'orders_read', access: readAccess }, { name: 'orders_write', access: 'WRITE' }] })
  const skillRoot = join(root, 'skills', 'policy-review')
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: policy-review\ndescription: Compare policy evidence.\n---\n'
    + 'Compare retrieved policy before reporting.\n'
    + 'Before reading orders, call connector_search_tools with {"connectorId":"erp","toolNames":["orders_read","orders_write"]}.\n')
  let companyBindingMissing = false
  let companyCacheInvalid = false
  let companyPinPending = false
  const pendingPins: string[] = []
  let companyCatalogPending = false
  const pendingCompanyCatalog: string[] = []
  let knowledgePending = false
  let pendingRequest: string | undefined
  const cancelled: string[] = []
  const retrieval: unknown[] = []
  Object.defineProperty(process, 'connected', { value: true, configurable: true })
  Object.defineProperty(process, 'send', { configurable: true, value: (message: Record<string, unknown>, callback?: (error: Error | null) => void) => {
    callback?.(null)
    if (message.type === 'extension-cancel') cancelled.push(String(message.requestId))
    if (message.type === 'extension-invoke') {
      if (companyCatalogPending && (message.method === 'runtime.companyContent.read' || message.method === 'runtime.companyContent.refresh')) {
        pendingCompanyCatalog.push(String(message.requestId))
        return true
      }
      if (message.method === 'runtime.companyContent.pin' && companyPinPending) {
        pendingPins.push(String(message.requestId))
        return true
      }
      if (message.method === 'connectors.list' && message.payload === undefined) {
        catalogReads++
        if (catalogPending) { pendingCatalog = String(message.requestId); return true }
      }
      if (message.method === 'runtime.companyContent.pin' && companyBindingMissing) {
        queueMicrotask(() => emitMessage({ type: 'extension-result', requestId: message.requestId,
          error: '此任务缺少公司内容版本记录，请新建对话；原任务历史已保留。',
          failure: { code: 'COMPANY_CONTENT_BINDING_MISSING', message: '此任务缺少公司内容版本记录，请新建对话；原任务历史已保留。',
            retryable: false, resources: [{ kind: 'session', id: 'missing-company-binding' }] },
        }))
        return true
      }
      if (message.method === 'runtime.companyContent.pin' && companyCacheInvalid) {
        queueMicrotask(() => emitMessage({ type: 'extension-result', requestId: message.requestId,
          error: '此任务的公司内容缓存缺失或损坏，已阻止执行；原任务历史和版本记录已保留。',
          failure: { code: 'COMPANY_CONTENT_CACHE_INVALID', message: '此任务的公司内容缓存缺失或损坏，已阻止执行；原任务历史和版本记录已保留。',
            retryable: false, resources: [{ kind: 'company-content', id: 'a'.repeat(64) }] },
        }))
        return true
      }
      if (message.method === 'knowledge.bases.list' && knowledgePending) { pendingRequest = String(message.requestId); return true }
      if (message.method === 'knowledge.search' || message.method === 'knowledge.sources.read') retrieval.push(message.payload)
      queueMicrotask(() => emitMessage({ type: 'extension-result', requestId: message.requestId,
        result: String(message.method).startsWith('runtime.companyContent.') ? { version: '1.0.0', sha256: 'a'.repeat(64), skillsRoot: join(root, 'skills'), expertsRoot: join(root, 'experts') }
          : message.method === 'connectors.list' ? catalogInvalid ? {} : [connector(), { ...connector(), id: 'broken', name: 'Broken CRM', url: `http://127.0.0.1:${address.port}/broken` }]
            : message.method === 'knowledge.bases.list' ? [{ id: 'policy' }]
              : message.method === 'knowledge.search' ? [policyHit] : message.method === 'knowledge.sources.read' ? policyHit : [],
      }))
    }
    if (message.type === 'extension-control') {
      responseWaiters.get(Number(message.requestId))?.(message)
      responseWaiters.delete(Number(message.requestId))
    }
    return true
  } })
  onTestFinished(async () => {
    releaseBrokenStartup()
    await ctx.fiber.dispose()
    for (const [key, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(process, key)
      else Object.defineProperty(process, key, descriptor)
    }
    vi.unstubAllEnvs()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(Skills)
  await ctx.plugin(FileSkills, { customSkillDirs: [join(root, 'skills')], includeDefaultRoots: false, watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
  await ctx.plugin(Agents)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Presets, { default: 'minimal' })
  ctx.loader.builtins['fixture-skill-loader'] = ToolSkill
  const skillLoader = { id: 'skill-loader', name: 'cordis:fixture-skill-loader' }
  const releaseBase = await ctx.agentPresets.register({ id: 'minimal', plugins: [skillLoader] })
  onTestFinished(releaseBase)
  ctx.provide('sessionQuery', {
    listSessions: async () => [{ header: { id: 'unreadable-history', agentPreset: 'minimal' } },
      ...selection.id === undefined ? [] : [{ header: { id: 'recorded', agentPreset: selection.id } }]],
    observeSession: async (id: string) => {
      if (id === 'unreadable-history') throw new Error('Unreadable session log')
      return { header: { agentPreset: selection.id }, projections: { values: { agentPreset: selection.id } },
        events: [], [Symbol.dispose]() {} }
    },
  })
  ctx.loader.builtins['product-runtime'] = Runtime
  const rows = [{ id: 'product-runtime', name: 'cordis:product-runtime' }]
  const mount = async () => {
    await ctx.loader.root.update(structuredClone(rows)); await ctx.loader.await()
    await ctx.loader.resolve('product-runtime').fiber?.await()
  }
  const request = (requestId: number, method: string, payload: object = {}) => {
    const response = new Promise<Record<string, unknown>>(resolve => responseWaiters.set(requestId, resolve))
    emitMessage({ type: 'extension-control', namespace: 'product', requestId, method, payload })
    return response
  }
  const decisions: string[] = []
  ctx.on('tools/pre-execute', async (_exec, next) => { const decision = await next(); decisions.push(decision.kind); return decision }, { prepend: true })
  const initialMount = mount()
  try {
    await vi.waitFor(() => {
      expect(brokenStartupPending).toBe(true)
      expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain(ordersWrite)
    })
    await executeTool(ctx, undefined, ordersWrite, {}, ToolCallId('startup-write'))
    expect(decisions.at(-1)).toBe('deny')
    expect(mcpCalls).toEqual([])
  } finally {
    holdBrokenStartup = false
    releaseBrokenStartup()
    await initialMount
  }
  expect(process.listenerCount('message')).toBe(before + 1)
  expect(catalogReads).toBe(1)
  expect(mcpRequests.filter(method => method === 'initialize')).toHaveLength(1)
  expect(mcpRequests.filter(method => method === 'tools/list')).toHaveLength(1)
  expect(await request(1, 'tasks.capabilities.prepare', { knowledgeBaseIds: ['policy'] })).toMatchObject({
    result: { capabilities: { basePresetId: 'minimal', knowledgeBaseIds: ['policy'] } },
  })
  const files = await readdir(join(root, 'product-knowledge-tasks-v1'))
  const selected = files.find(file => file.endsWith('.json'))!.slice(0, -5)
  selection.id = selected
  const snapshot = await readFile(join(root, 'product-knowledge-tasks-v1', selected + '.json'), 'utf8')
  expect(snapshot).not.toMatch(/Authorization|headers|expertKit/)
  expect((await ctx.agentPresets.remoteExportList()).presets.find(preset => preset.id === selected)?.selectionBase).toBe('minimal')
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const create = async (id: string, seed?: Parameters<typeof ctx.agents.create>[0]['seed'],
    parentAgent?: Parameters<typeof ctx.agents.create>[0]['parentAgent']) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id),
      ...(seed === undefined ? {} : { seed }), ...(parentAgent === undefined ? {} : { parentAgent }),
      agentOptions: { provider: 'fixture', model: 'fixture' }, setup: child => ctx.agentPresets.mount(child, selected).then(() => undefined) })
    onTestFinished(() => handle.dispose())
    return handle
  }
  const handle = await create('native-session')
  const sharedRequests = [...mcpRequests]
  const sibling = await create('sibling-session')
  const child = await create('child-session', undefined, handle.agent)
  expect(ctx.tools.schemas(sibling.agent).map(tool => tool.name)).not.toContain(ordersRead)
  expect(ctx.tools.schemas(child.agent).map(tool => tool.name)).not.toContain(ordersRead)
  await sibling.dispose()
  await child.dispose()
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).not.toContain(ordersRead)
  expect(catalogReads).toBe(1)
  expect(mcpRequests).toEqual(sharedRequests)
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).not.toContain(ordersRead)
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).not.toContain(publicToolName(connectorServerName('broken'), 'orders_read'))
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Find policy.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) }, { timeout: 10000 })
  const events = handle.agent.session.snapshotEvents()
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Compare policy evidence.')
  expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('Compare retrieved policy before reporting.')
  expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('Compare retrieved policy before reporting.')
  expect(retrieval).toEqual([
    { query: 'policy', knowledgeBaseRefs: [], knowledgeBaseIds: ['policy'], restrictToKnowledgeBaseRefs: true, limit: 2 },
    { sourceId: 'source' },
  ])
  expect(JSON.stringify(events)).toContain('Company content version: 1.0.0; SHA-256: ' + 'a'.repeat(64))
  expect(JSON.stringify(events)).not.toContain(relayCredential)
  expect(JSON.stringify(events)).toContain('Recorded enterprise policy.')
  expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
  expect(mcpCalls).toEqual(['orders_read'])
  const firstInput = JSON.stringify(adapter.requests[0]?.messages)
  expect(firstInput).toContain('Unavailable enterprise connectors:')
  expect(firstInput).toContain('Broken CRM')
  const loadedSkill = adapter.requests[1]?.messages.flatMap(message => message.content)
    .find(block => block.type === 'text' && block.text.startsWith('<skill_content name='))
  expect(loadedSkill?.type).toBe('text')
  await expect(JSON.stringify({
    tools: ctx.tools.schemas(handle.agent).map(tool => tool.name).sort(),
    companyVersion: firstInput.match(/Company content version: [0-9.]+; SHA-256: [a-f0-9]{64}\./)?.[0],
    skillCatalog: firstInput.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0],
    loadedSkill: loadedSkill?.type === 'text' ? loadedSkill.text : undefined,
    retrieval,
    results: events.filter(event => event.type === 'tool/result').map(event => event.data.message.content),
  }, null, 2).replaceAll(root, '<HOME>') + '\n').toMatchFileSnapshot(new URL('./expected/native-capabilities-session.json', import.meta.url).pathname)
  const cacheErrors: unknown[] = []
  const stopCacheErrors = ctx.on('agent/error', ({ agent, error }) => {
    if (agent.id === handle.agent.id) cacheErrors.push(error)
  })
  const requestsBeforeDamage = adapter.requests.length
  companyCacheInvalid = true
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue with the pinned content.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(cacheErrors).toHaveLength(1) })
  expect(cacheErrors[0]).toMatchObject({ code: 'COMPANY_CONTENT_CACHE_INVALID' })
  expect(adapter.requests).toHaveLength(requestsBeforeDamage)
  expect(ctx.sessions.get(handle.agent.id)).toBe(handle.agent.session)
  expect(ctx.agents.get(handle.agent.id)).toBe(handle.agent)
  expect(handle.agent.session.snapshotEvents().slice(0, events.length)).toEqual(events)
  await expect(JSON.stringify({ failure: productFailure(cacheErrors[0]),
    additionalModelRequests: adapter.requests.length - requestsBeforeDamage,
    historyPreserved: handle.agent.session.snapshotEvents().slice(0, events.length).length === events.length,
    sessionRetained: ctx.sessions.get(handle.agent.id) === handle.agent.session,
  }, null, 2) + '\n').toMatchFileSnapshot(new URL('./expected/company-content-cache-rejection.json', import.meta.url).pathname)
  companyCacheInvalid = false
  stopCacheErrors()
  const requestsBeforeStop = adapter.requests.length
  const historyBeforeStop = handle.agent.session.snapshotEvents()
  companyPinPending = true
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Stop while checking company content.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(pendingPins).toHaveLength(1) })
  handle.agent.cancel({ kind: 'user' })
  await vi.waitFor(() => { expect(handle.agent.status).toBe('idle') })
  expect(cancelled).toContain(pendingPins[0])
  expect(adapter.requests).toHaveLength(requestsBeforeStop)
  const stopEvents = handle.agent.session.snapshotEvents()
  const stoppedTurn = stopEvents.findLast(event => event.type === 'turn/end')
  expect(stoppedTurn?.data.reason).toEqual({ kind: 'aborted', reason: { kind: 'user' } })
  await expect(JSON.stringify({ turnEnd: stoppedTurn?.data.reason,
    additionalModelRequests: adapter.requests.length - requestsBeforeStop,
    mainRequestCancelled: cancelled.includes(pendingPins[0]!),
    historyPreserved: JSON.stringify(stopEvents.slice(0, historyBeforeStop.length)) === JSON.stringify(historyBeforeStop),
    sessionRetained: ctx.sessions.get(handle.agent.id) === handle.agent.session,
  }, null, 2) + '\n').toMatchFileSnapshot(new URL('./expected/company-content-cancellation.json', import.meta.url).pathname)
  const companyContent = ctx.get('companyContent')
  if (companyContent === undefined) throw new Error('Product Loader did not register company content')
  const firstReader = new AbortController()
  const secondReader = new AbortController()
  const firstCheck = expect(companyContent.forSession(handle.agent.id, firstReader.signal)).rejects.toThrow('First reader stopped')
  const secondCheck = expect(companyContent.forSession(handle.agent.id, secondReader.signal)).rejects.toThrow('Second reader stopped')
  await vi.waitFor(() => { expect(pendingPins).toHaveLength(2) })
  firstReader.abort(new Error('First reader stopped'))
  await firstCheck
  expect(cancelled).not.toContain(pendingPins[1])
  secondReader.abort(new Error('Second reader stopped'))
  await secondCheck
  expect(cancelled).toContain(pendingPins[1])
  const recheck = companyContent.forSession(handle.agent.id)
  await vi.waitFor(() => { expect(pendingPins).toHaveLength(3) })
  const roots = { version: '1.0.0', sha256: 'a'.repeat(64), skillsRoot: join(root, 'skills'), expertsRoot: join(root, 'experts') }
  // A late cancelled response cannot settle the new request.
  emitMessage({ type: 'extension-result', requestId: pendingPins[0], result: roots })
  emitMessage({ type: 'extension-result', requestId: pendingPins[2], result: roots })
  expect(await recheck).toEqual(roots)
  companyCatalogPending = true
  for (const method of ['read', 'refresh'] as const) {
    const controller = new AbortController()
    const pending = companyContent[method](controller.signal)
    const rejected = expect(pending).rejects.toThrow('Catalog reader stopped')
    await vi.waitFor(() => { expect(pendingCompanyCatalog).toHaveLength(method === 'read' ? 1 : 2) })
    const id = pendingCompanyCatalog.at(-1)!
    controller.abort(new Error('Catalog reader stopped'))
    await rejected
    expect(cancelled).toContain(id)
    emitMessage({ type: 'extension-result', requestId: id, result: roots })
  }
  companyCatalogPending = false
  expect(await companyContent.read()).toEqual(roots)
  companyPinPending = false
  const execute = (name: string) => executeTool(ctx, handle.agent, name, {}, ToolCallId('check-' + name))
  await execute(ordersWrite); expect(decisions.at(-1)).toBe('ask')
  await execute(undeclared); expect(decisions.at(-1)).toBe('deny')
  await executeTool(ctx, undefined, ordersWrite, {}, ToolCallId('workspace-write'))
  expect(decisions.at(-1)).toBe('deny')
  connectorVersion = '2.0.0'
  expect((await execute(ordersRead)).isError).toBe(true)
  connectorVersion = '1.0.0'; connectorReady = false
  expect((await execute(ordersRead)).isError).toBe(true)
  expect(mcpCalls).toEqual(['orders_read'])
  connectorReady = true
  await ctx.loader.root.update([]); await ctx.loader.await()
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).not.toContain(ordersRead)
  expect(process.listenerCount('message')).toBe(before)
  await handle.dispose()
  await mount()
  const restored = await create('native-session', events)
  expect(ctx.tools.schemas(restored.agent).map(tool => tool.name)).toContain(ordersRead)
  expect(await ctx.skills.get('policy-review', { scope: restored.agent })).toBeDefined()
  expect(JSON.stringify(restored.agent.session.snapshotEvents())).toContain('Find policy.')
  expect(await readFile(join(root, 'product-knowledge-tasks-v1', selected + '.json'), 'utf8')).toBe(snapshot)
  readAccess = 'WRITE'
  await executeTool(ctx, restored.agent, ordersRead, {}, ToolCallId('restored-write'))
  expect(decisions.at(-1)).toBe('ask')
  expect(mcpCalls).toEqual(['orders_read'])
  mcpAvailable = false
  const requestsBeforeCreate = [...mcpRequests]
  const reused = await create('reuse-offline-connection')
  expect(ctx.tools.schemas(reused.agent).map(tool => tool.name)).not.toContain(ordersRead)
  expect(catalogReads).toBe(2)
  expect(mcpRequests).toEqual(requestsBeforeCreate)
  await reused.dispose()
  await ctx.loader.root.update([]); await ctx.loader.await()
  await mount()
  expect(catalogReads).toBe(3)
  const offline = await create('offline-connectors')
  expect(ctx.tools.schemas(offline.agent).map(tool => tool.name)).not.toContain(ordersRead)
  offline.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explain a policy without ERP.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(offline.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) }, { timeout: 10000 })
  expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('Unavailable enterprise connectors:')
  expect(JSON.stringify(offline.agent.session.snapshotEvents())).toContain('Recorded policy retrieved.')
  expect(JSON.stringify(offline.agent.session.snapshotEvents())).not.toContain(relayCredential)
  await offline.dispose()
  mcpAvailable = true
  await ctx.loader.root.update([]); await ctx.loader.await()
  catalogInvalid = true
  await mount()
  const degraded = await create('invalid-connector-catalog')
  const errors: unknown[] = []
  const stopErrors = ctx.on('agent/error', ({ error }) => { errors.push(error) })
  const modelRequests = adapter.requests.length
  degraded.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThan(modelRequests) })
  expect(errors).toEqual([])
  expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('Enterprise connector catalog is unavailable.')
  expect(ctx.tools.schemas(degraded.agent).map(tool => tool.name)).not.toContain(ordersRead)
  expect(await request(90, 'connectors.refresh')).toMatchObject({ failure: { code: 'CONNECTOR_STARTUP_FAILED', retryable: true } })
  expect(ctx.tools.schemas(degraded.agent).map(tool => tool.name)).not.toContain(ordersRead)
  catalogInvalid = false
  expect(typeof (await request(91, 'connectors.refresh', { ids: ['erp'] })).error).toBe('string')
  expect(await request(92, 'connectors.refresh')).toMatchObject({ result: { connectedIds: ['erp'], unavailableIds: ['broken'] } })
  expect(ctx.tools.schemas(degraded.agent).map(tool => tool.name)).not.toContain(ordersRead)
  await executeTool(ctx, degraded.agent, 'connector_search_tools', { query: 'orders', limit: 2 }, ToolCallId('discover-recovered'))
  expect(ctx.tools.schemas(degraded.agent).map(tool => tool.name)).toContain(ordersRead)
  await executeTool(ctx, degraded.agent, ordersWrite, {}, ToolCallId('recovered-write'))
  expect(decisions.at(-1)).toBe('ask')
  await executeTool(ctx, undefined, undeclared, {}, ToolCallId('recovered-undeclared'))
  expect(decisions.at(-1)).toBe('deny')
  catalogPending = true
  const cancelledRefresh = request(93, 'connectors.refresh')
  await vi.waitFor(() => { expect(pendingCatalog).toBeDefined() })
  const cancelledCatalog = pendingCatalog!
  emitMessage({ type: 'extension-control-cancel', namespace: 'product', requestId: 93 })
  expect(await cancelledRefresh).toMatchObject({ failure: { code: 'PRODUCT_REQUEST_CANCELLED' } })
  expect(cancelled).toContain(cancelledCatalog)
  expect((await executeTool(ctx, degraded.agent, ordersRead, {}, ToolCallId('cancelled-refresh-read'))).isError).toBe(true)
  catalogPending = false
  pendingCatalog = undefined
  expect(await request(94, 'connectors.refresh')).toMatchObject({ result: { connectedIds: ['erp'] } })
  stopErrors()
  await degraded.dispose()
  await ctx.loader.root.update([]); await ctx.loader.await()
  expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain(ordersRead)
  await mount()
  companyBindingMissing = true
  const unavailable = await create('missing-company-binding', events)
  const bindingErrors: unknown[] = []
  const stopBindingErrors = ctx.on('agent/error', ({ agent, error }) => {
    if (agent.id === unavailable.agent.id) bindingErrors.push(error)
  })
  const requestsBeforeBlocked = adapter.requests.length
  unavailable.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Keep this draft.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(bindingErrors).toHaveLength(1) })
  expect(bindingErrors[0]).toMatchObject({ code: 'COMPANY_CONTENT_BINDING_MISSING' })
  expect(ctx.sessions.get(unavailable.agent.id)).toBe(unavailable.agent.session)
  expect(ctx.agents.get(unavailable.agent.id)).toBe(unavailable.agent)
  expect(unavailable.agent.session.snapshotEvents().slice(0, events.length)).toEqual(events)
  expect(adapter.requests).toHaveLength(requestsBeforeBlocked)
  const restoredCompanyContent = ctx.get('companyContent')
  if (restoredCompanyContent === undefined) throw new Error('Product Loader did not restore company content')
  await expect(restoredCompanyContent.forSession(unavailable.agent.id)).rejects.toMatchObject({ code: 'COMPANY_CONTENT_BINDING_MISSING' })
  stopBindingErrors()
  await unavailable.dispose()
  companyBindingMissing = false
  knowledgePending = true
  const cancelledRequest = request(2, 'tasks.capabilities.prepare', { knowledgeBaseIds: ['policy'] })
  await vi.waitFor(() => { expect(pendingRequest).toBeDefined() })
  emitMessage({ type: 'extension-control-cancel', namespace: 'product', requestId: 2 })
  expect(await cancelledRequest).toMatchObject({ failure: { code: 'PRODUCT_REQUEST_CANCELLED' } })
  expect(cancelled).toContain(pendingRequest)
  pendingRequest = undefined
  const unloadingRequest = request(3, 'tasks.capabilities.prepare', { knowledgeBaseIds: ['policy'] })
  await vi.waitFor(() => { expect(pendingRequest).toBeDefined() })
  catalogPending = true
  const unloadingConnectorRefresh = request(95, 'connectors.refresh')
  await vi.waitFor(() => { expect(pendingCatalog).toBeDefined() })
  const unloadingCatalog = pendingCatalog!
  const readsBeforeQueued = catalogReads
  const queuedRefresh = request(96, 'connectors.refresh')
  emitMessage({ type: 'extension-control-cancel', namespace: 'product', requestId: 96 })
  companyPinPending = true
  const unloadingCompanyCheck = expect(restoredCompanyContent.forSession(restored.agent.id)).rejects.toThrow('unloaded')
  await vi.waitFor(() => { expect(pendingPins).toHaveLength(4) })
  companyCatalogPending = true
  const unloadingCompanyRead = expect(restoredCompanyContent.read()).rejects.toThrow(/unloaded|Host stopped/)
  const unloadingCompanyRefresh = expect(restoredCompanyContent.refresh()).rejects.toThrow(/unloaded|Host stopped/)
  await vi.waitFor(() => { expect(pendingCompanyCatalog).toHaveLength(4) })
  const unloading = ctx.loader.resolve('product-runtime').fiber
  await ctx.loader.root.update([]); await ctx.loader.await(); await unloading?.dispose()
  await Promise.all([unloadingCompanyCheck, unloadingCompanyRead, unloadingCompanyRefresh])
  expect(cancelled).toEqual(expect.arrayContaining(pendingCompanyCatalog))
  expect(cancelled).toContain(pendingPins[3])
  companyPinPending = false
  // Plugin release joins the operation but deliberately sends no response to a closed IPC owner.
  void unloadingRequest
  void unloadingConnectorRefresh
  void queuedRefresh
  expect(cancelled).toContain(unloadingCatalog)
  expect(catalogReads).toBe(readsBeforeQueued)
  pendingCatalog = undefined
  expect(cancelled).toContain(pendingRequest)
  expect(process.listenerCount('message')).toBe(before)
  expect(ctx.tools.schemas(restored.agent).map(tool => tool.name)).not.toContain(ordersRead)
  catalogPending = true
  const mounting = ctx.loader.root.update(structuredClone(rows)).then(() => ctx.loader.await())
  await vi.waitFor(() => { expect(pendingCatalog).toBeDefined() })
  const starting = ctx.loader.resolve('product-runtime').fiber
  await ctx.loader.root.update([]); await ctx.loader.await(); await starting?.dispose()
  await mounting
  expect(cancelled).toContain(pendingCatalog)
  expect(process.listenerCount('message')).toBe(before)
  expect(ctx.tools.schemas(restored.agent).map(tool => tool.name)).not.toContain(ordersRead)
})
