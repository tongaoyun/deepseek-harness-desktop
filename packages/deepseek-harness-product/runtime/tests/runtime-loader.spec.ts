import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
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
import { connectorServerName } from '../src/deepseek-harness-connector-contract.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Runtime from '../src/index.ts'
const emitMessage = (message: object) => EventEmitter.prototype.emit.call(process, 'message', message)
const ordersRead = publicToolName(connectorServerName('erp'), 'orders_read')
const ordersWrite = publicToolName(connectorServerName('erp'), 'orders_write')
const undeclared = publicToolName(connectorServerName('erp'), 'undeclared')

class FixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    const calls = [
      { id: 'read-orders', name: ordersRead, arguments: '{}' },
      { id: 'retrieve-policy', name: 'knowledge_search', arguments: '{"query":"policy","limit":2}' },
      { id: 'read-policy-source', name: 'knowledge_read', arguments: '{"sourceId":"source"}' },
      { id: 'read-task-skill', name: 'skill', arguments: '{"name":"policy-review"}' },
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

it('composes kit and skill providers without standard or intermediate Presets, restores and replays the task, and disposes IPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-runtime-loader-'))
  vi.stubEnv('DSH_HOME', root)
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  const before = process.listenerCount('message')
  const descriptors = new Map(['connected', 'send'].map(key => [key, Object.getOwnPropertyDescriptor(process, key)]))
  const selection: { id: string | undefined } = { id: undefined }
  const responses = new Map<number, Record<string, unknown>>()
  const responseWaiters = new Map<number, (response: Record<string, unknown>) => void>()
  const kit = { id: 'policy-kit', name: 'Policy kit', version: '1', summary: 'Review enterprise policy.',
    skillIds: ['kit-check'], connectorRefs: [], requiredTools: ['knowledge_search'],
    knowledgeBaseRefs: ['company:policy'], sha256: 'a'.repeat(64) }
  const policyHit = { sourceId: 'source', knowledgeBaseId: 'policy', knowledgeBaseName: 'Policy',
    documentId: 'document', filename: 'Policy.md', locator: 'section-1', content: 'Recorded enterprise policy.', score: 0.9 }
  const skill = { id: 'policy-review', name: 'Policy review', version: '1', summary: 'Compare policy evidence.',
    connectorRefs: ['erp', 'crm'], requiredTools: ['orders_read'], knowledgeBaseRefs: [], sha256: 'b'.repeat(64) }
  let publishedKit = kit
  let kitRevoked = false
  let employee = 'employee'
  const hanging = new Map<string, string>()
  const cancelled: string[] = []
  let connectorReady = true
  let connectorVersion = '1.0.0'
  let relayCredential = 'private-relay-one'
  let readAccess = 'READ'
  const mcpCalls: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== relayCredential) { response.writeHead(401).end(); return }
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error('MCP fixture expected request bytes')
        chunks.push(chunk)
      }
      const call = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { name?: string } }
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
  const connector = () => ({ id: 'erp', version: connectorVersion, name: 'Orders', status: connectorReady ? 'ready' : 'unavailable', authMode: 'oauth',
    timeoutSeconds: 120,
    transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, arguments: [], environment: {},
    headers: { Authorization: relayCredential }, tools: [{ name: 'orders_read', access: readAccess }, { name: 'orders_write', access: 'WRITE' }] })
  const kitRoot = join(root, 'product-capabilities-v1/expert-kits', kit.id, kit.sha256)
  const skillRoot = join(root, 'product-capabilities-v1/skills', skill.sha256, skill.id)
  await mkdir(join(kitRoot, 'skills/kit-check'), { recursive: true })
  await mkdir(skillRoot, { recursive: true })
  await writeFile(join(kitRoot, 'README.md'), '# Policy kit\n\nUse policy evidence before making a recommendation.\n')
  await mkdir(join(kitRoot, '.deepseek-harness-kit'))
  await writeFile(join(kitRoot, '.deepseek-harness-kit/kit.json'), JSON.stringify({ id: kit.id, version: kit.version,
    commonTasks: [{ id: 'check-policy', name: 'Check policy', description: 'Check policy scope.',
      prompt: 'Find the policy.', skillIds: ['kit-check'] }] }))
  await writeFile(join(kitRoot, 'skills/kit-check/SKILL.md'), '---\nname: kit-check\ndescription: Check the policy.\n---\nConfirm policy scope.\n')
  await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: policy-review\ndescription: Compare policy evidence.\n---\nCompare the retrieved policy before reporting.\n')
  await writeFile(join(kitRoot, '.deepseek-harness-sha256'), kit.sha256)
  await writeFile(join(skillRoot, '.deepseek-harness-sha256'), skill.sha256)
  const contentRoot = join(root, 'product-capabilities-v1')
  const cacheOwner = createHash('sha256').update('fixture-cache-owner').digest('hex')
  for (const [directory, entries] of [['installed-skills-v1', [skill]], ['installed-expert-kits-v1', [kit]]] as const) {
    const path = join(contentRoot, directory)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, `installed-${cacheOwner}.json`), JSON.stringify(entries))
  }
  const obsoleteRoot = join(contentRoot, 'skills', 'c'.repeat(64), 'unused-skill')
  await mkdir(obsoleteRoot, { recursive: true })
  await writeFile(join(obsoleteRoot, '.deepseek-harness-sha256'), 'c'.repeat(64))
  Object.defineProperty(process, 'connected', { value: true, configurable: true })
  Object.defineProperty(process, 'send', { configurable: true, value: (message: Record<string, unknown>, callback?: (error: Error | null) => void) => {
    callback?.(null)
    if (message.type === 'extension-cancel') cancelled.push(String(message.requestId))
    if (message.type === 'extension-invoke' && message.method === 'skills.get'
      && (message.payload as { id?: string })?.id === 'slow-skill') {
      hanging.set('slow-skill', String(message.requestId))
      return true
    }
    if (message.type === 'extension-invoke' && message.method === 'expertKits.get'
      && (message.payload as { id?: string })?.id === 'slow-kit') {
      hanging.set('slow-kit', String(message.requestId))
      return true
    }
    if (message.type === 'extension-invoke' && message.method === 'expertKits.get' && kitRevoked) {
      queueMicrotask(() => emitMessage({ type: 'extension-result', requestId: message.requestId,
        error: 'Kit access revoked', failure: { code: 'KIT_ACCESS_REVOKED', message: 'Kit access revoked', retryable: false,
          resources: [{ kind: 'expert-kit', id: kit.id }] } }))
      return true
    }
    if (message.type === 'extension-invoke') queueMicrotask(() => emitMessage({
      type: 'extension-result', requestId: message.requestId,
      result: message.method === 'extensions.authoring.read' ? null : message.method === 'auth.getSession' ? { authenticated: true, employeeId: employee }
        : message.method === 'expertKits.get' ? publishedKit : message.method === 'skills.get' ? skill
          : message.method === 'connectors.list' ? [connector(), { ...connector(), id: 'crm' }, { ...connector(), id: 'unreferenced' }]
            : message.method === 'knowledge.bases.list' ? [{ id: 'policy', referenceKey: 'company:policy' }]
              : message.method === 'knowledge.search' ? [policyHit] : message.method === 'knowledge.sources.read' ? policyHit : [],
    }))
    if (message.type === 'extension-control') {
      const id = message.requestId as number
      responses.set(id, message)
      responseWaiters.get(id)?.(message)
      responseWaiters.delete(id)
    }
    return true
  } })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    for (const [key, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(process, key)
      else Object.defineProperty(process, key, descriptor)
    }
    vi.unstubAllEnvs()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Skills)
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
  ctx.loader.builtins['mode-marker'] = {
    name: 'mode-marker', inject: ['systemPrompt'],
    apply(scope: Context) {
      scope.effect(() => scope.systemPrompt.section({ name: 'mode-marker', order: 400, text: 'Execution mode: PTC.' }), 'mode-marker.prompt')
    },
  }
  const releaseMode = await ctx.agentPresets.register({ id: 'ptc', selectable: true, defaultable: false,
    plugins: [skillLoader, { id: 'ptc-marker', name: 'cordis:mode-marker' }] })
  onTestFinished(releaseMode)
  ctx.provide('sessionQuery', {
    listSessions: async () => selection.id === undefined ? [] : [{ header: { id: 'recorded', agentPreset: selection.id } }],
    observeSession: async () => ({ header: { agentPreset: selection.id }, projections: { values: { agentPreset: selection.id } },
      events: [], [Symbol.dispose]() {} }),
  })
  ctx.loader.builtins['product-runtime'] = Runtime
  const rows = [{ id: 'product-runtime', name: 'cordis:product-runtime' }]
  await ctx.loader.root.update(structuredClone(rows))
  await ctx.loader.await()
  await ctx.loader.resolve('product-runtime').fiber?.await()
  expect(ctx.loader.resolve('product-runtime').fiber).toBeDefined()
  for (const name of ['agentPresets', 'agents', 'sessionQuery', 'skills', 'systemPrompt', 'tools']) expect(ctx.get(name), name).toBeDefined()
  expect(process.listenerCount('message')).toBe(before + 1)
  await expect(readFile(join(obsoleteRoot, '.deepseek-harness-sha256'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await ctx.agentPresets.list()).map(preset => preset.id).sort()).toEqual(['minimal', 'ptc'])
  const request = async (requestId: number, method: string, payload: object = {}) => {
    const response = new Promise<Record<string, unknown>>(resolve => responseWaiters.set(requestId, resolve))
    emitMessage({ type: 'extension-control', namespace: 'product', requestId, method, payload })
    return response
  }
  expect(await request(20, 'expertKits.install', { id: kit.id })).toMatchObject({
    result: { id: kit.id, version: kit.version, sha256: kit.sha256 },
  })
  expect((await ctx.agentPresets.list()).map(preset => preset.id).sort()).toEqual(['minimal', 'ptc'])
  expect(await readdir(join(root, 'product-capabilities-v1/tasks-v1'))).toEqual([])
  expect(await request(21, 'expertKits.installed.read')).toMatchObject({ result: { installed: [{ id: kit.id }] } })
  employee = 'another-employee'
  expect(await request(22, 'expertKits.installed.read')).toMatchObject({ result: { installed: [] } })
  expect(await request(23, 'expertKits.uninstall', { id: kit.id })).toMatchObject({ result: { id: kit.id } })
  employee = 'employee'
  expect(await request(24, 'expertKits.installed.read')).toMatchObject({ result: { installed: [{ id: kit.id }] } })
  publishedKit = { ...kit, skillIds: ['missing-skill'] }
  expect(await request(25, 'expertKits.install', { id: kit.id })).toMatchObject({ failure: { code: 'KIT_SKILL_MISSING' } })
  expect(await request(26, 'expertKits.installed.read')).toMatchObject({ result: { installed: [{ id: kit.id }] } })
  publishedKit = kit
  expect(await request(27, 'expertKits.uninstall', { id: kit.id })).toMatchObject({ result: { id: kit.id } })
  expect(await request(28, 'expertKits.installed.read')).toMatchObject({ result: { installed: [] } })
  expect(await request(29, 'expertKits.install', { id: kit.id })).toMatchObject({ result: { id: kit.id } })
  await request(30, 'expertKits.uninstall', { id: kit.id })
  emitMessage({ type: 'extension-control', namespace: 'product', requestId: 10,
    method: 'skills.install', payload: { id: skill.id } })
  await vi.waitFor(() => { expect(responses.has(10)).toBe(true) })
  expect(responses.get(10)?.error).toBeUndefined()
  expect((await ctx.agentPresets.list()).map(preset => preset.id).sort()).toEqual(['minimal', 'ptc'])
  emitMessage({ type: 'extension-control', namespace: 'product', requestId: 11,
    method: 'tasks.capabilities.prepare', payload: { knowledgeBaseIds: ['policy'] } })
  await vi.waitFor(() => { expect(responses.has(11)).toBe(true) })
  expect(responses.get(11)?.error).toBeUndefined()
  selection.id = (responses.get(11)?.result as { presetId: string }).presetId
  const beforeKit = await readdir(join(root, 'product-capabilities-v1/tasks-v1'))
  expect(await request(51, 'tasks.capabilities.prepare', { sessionId: 'recorded', expertKitId: kit.id }))
    .toMatchObject({ failure: { code: 'KIT_NOT_INSTALLED', retryable: false,
      resources: [{ kind: 'expert-kit', id: kit.id }] } })
  expect(await readdir(join(root, 'product-capabilities-v1/tasks-v1'))).toEqual(beforeKit)
  expect(await request(52, 'expertKits.installed.read')).toMatchObject({ result: { installed: [] } })
  expect(await request(53, 'expertKits.install', { id: kit.id })).toMatchObject({ result: { id: kit.id } })
  emitMessage({ type: 'extension-control', namespace: 'product', requestId: 1,
    method: 'tasks.capabilities.prepare', payload: { sessionId: 'recorded', expertKitId: kit.id, expertKitTaskId: 'check-policy' } })
  await vi.waitFor(() =>{  expect(responses.has(1)).toBe(true) })
  expect(responses.get(1)?.error).toBeUndefined()
  expect(responses.get(1)?.result).toMatchObject({ prompt: 'Find the policy.',
    capabilities: { expertKitTask: { id: 'check-policy', skillIds: ['kit-check'] } } })
  const result = responses.get(1)?.result as { presetId: string }
  const selected = result.presetId
  selection.id = selected
  expect(await request(31, 'expertKits.installed.read')).toMatchObject({ result: { installed: [{ id: kit.id }] } })
  expect(await request(32, 'expertKits.uninstall', { id: kit.id })).toMatchObject({ result: { id: kit.id } })
  expect(await request(33, 'expertKits.installed.read')).toMatchObject({ result: { installed: [] } })
  expect(await request(54, 'tasks.capabilities.prepare', { expertKitId: kit.id }))
    .toMatchObject({ failure: { code: 'KIT_NOT_INSTALLED' } })
  expect(await request(55, 'tasks.capabilities.prepare', { sessionId: 'recorded', knowledgeBaseIds: ['policy'] }))
    .toMatchObject({ result: { presetId: selected, capabilities: { expertKit: { id: kit.id } } } })
  const snapshot = await readFile(join(root, 'product-capabilities-v1/tasks-v1', `${selected}.json`), 'utf8')
  expect(snapshot).toContain('policy')
  expect(snapshot).not.toContain('Authorization')
  expect((await ctx.agentPresets.list()).map(preset => preset.id)).toEqual(expect.arrayContaining(['minimal', 'ptc', selected]))
  expect((await ctx.agentPresets.remoteExportList()).presets.find(preset => preset.id === selected)).toMatchObject({
    selectionBase: 'minimal', selectable: false, defaultable: false,
  })
  emitMessage({ type: 'extension-control', namespace: 'product', requestId: 12,
    method: 'tasks.capabilities.prepare', payload: { sessionId: 'recorded', expertKitId: null } })
  await vi.waitFor(() => { expect(responses.has(12)).toBe(true) })
  expect(responses.get(12)?.error).toBeUndefined()
  const cleared = responses.get(12)?.result as { presetId: string; capabilities: { expertKit?: unknown; knowledgeBaseIds: string[] } }
  expect(cleared.capabilities.expertKit).toBeUndefined()
  expect(cleared.capabilities.knowledgeBaseIds).toEqual(['policy'])
  {
    await using clearedScope = await ctx.agentPresets.acquireScope(cleared.presetId)
    expect(ctx.tools.schemas(clearedScope.key).map(tool => tool.name).sort()).toEqual(['knowledge_destinations', 'knowledge_read', 'knowledge_save', 'knowledge_search', 'skill'])
    expect(await ctx.skills.list({ scope: clearedScope.key })).toEqual([])
  }
  expect(ctx.tools.schemas().map(tool => tool.name).sort()).toEqual(['knowledge_destinations', 'knowledge_save'])
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(process.listenerCount('message')).toBe(before)
  await expect(ctx.agentPresets.resolve(selected)).rejects.toThrow('Unknown agent preset')
  await releaseBase()
  let releaseSlowBase!: () => void
  const pausedBase = new Promise<void>((resolve) => { releaseSlowBase = resolve })
  onTestFinished(releaseSlowBase)
  let baseEntered!: () => void
  const baseStarted = new Promise<void>((resolve) => { baseEntered = resolve })
  ctx.loader.builtins['slow-base'] = {
    inject: ['agentPresets'],
    async* apply(host: Context) {
      baseEntered()
      await pausedBase
      yield await host.agentPresets.register({ id: 'minimal', plugins: [skillLoader] })
    },
  }
  const restarting = ctx.loader.root.update(structuredClone([...rows, { id: 'slow-base', name: 'cordis:slow-base' }]))
  await baseStarted
  const restoring = ctx.loader.resolve('product-runtime')
  await restoring._initTask
  await restoring.fiber?.await()
  expect(await readdir(join(root, 'product-capabilities-v1/tasks-v1'))).not.toContain(`${selected}.json.diagnostic.json`)
  releaseSlowBase()
  await restarting
  await ctx.loader.await()
  await ctx.loader.root.update(structuredClone(rows))
  await ctx.loader.await()
  const releaseRestoredBase = await ctx.agentPresets.register({ id: 'minimal', plugins: [skillLoader] })
  onTestFinished(releaseRestoredBase)
  expect(process.listenerCount('message')).toBe(before + 1)
  expect(await request(34, 'expertKits.installed.read')).toMatchObject({ result: { installed: [] } })
  expect((await ctx.agentPresets.remoteExportList()).presets.find(preset => preset.id === selected)?.selectionBase).toBe('minimal')
  expect(await readFile(join(kitRoot, 'README.md'), 'utf8')).toContain('Use policy evidence before making a recommendation.')
  expect(await readFile(join(root, 'product-capabilities-v1/tasks-v1', `${selected}.json`), 'utf8')).toBe(snapshot)
  await using scope = await ctx.agentPresets.acquireScope(selected)
  expect(ctx.tools.schemas(scope.key).map(tool => tool.name).sort()).toEqual(['knowledge_destinations', 'knowledge_read', 'knowledge_save', 'knowledge_search', 'skill'])
  expect((await ctx.skills.list({ scope: scope.key })).map(skill => skill.name).sort())
    .toEqual(['expert-kit-policy-kit', 'kit-check'])
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('capability-session'),
    agentOptions: { provider: 'fixture', model: 'fixture' }, setup: child => ctx.agentPresets.mount(child, selected).then(() => undefined) })
  onTestFinished(() => handle.dispose())
  expect((await ctx.skills.list({ scope: handle.agent })).map(skill => skill.name)).toContain('policy-review')
  const composed = await ctx.agentPresets.select(handle.agent, 'ptc')
  expect(composed).not.toBe('ptc')
  selection.id = composed
  await using switchedScope = await ctx.agentPresets.acquireScope(composed)
  expect(ctx.tools.schemas(switchedScope.key).map(tool => tool.name).sort()).toEqual(['knowledge_destinations', 'knowledge_read', 'knowledge_save', 'knowledge_search', 'skill'])
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Find the policy.' }], source: { kind: 'user' } }))
  await vi.waitFor(() =>{  expect(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) }, { timeout: 10000 })
  const events = handle.agent.session.snapshotEvents()
  expect(events.some(event => event.type === 'working-directory/change' && event.data.cwd === root)).toBe(true)
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Current working directory:')
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Use policy evidence before making a recommendation.')
  expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Confirm policy scope.')
  expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'product-expert-kit-instructions')).toHaveLength(1)
  expect(events.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'product-expert-kit-instructions'))
    .toBeLessThan(events.findIndex(event => event.type === 'tool/call' && event.data.name === ordersRead))
  expect(events.flatMap(event => event.type === 'user/message'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n')).toContain('"timeoutSeconds":120')
  const system = events.find(event => event.type === 'system/message')
  expect(system?.data.message.content).toEqual(expect.any(Array))
  const recording = {
    system: system?.data.message.content,
    workingDirectory: events.flatMap(event => event.type === 'working-directory/change' ? [event.data] : []),
    tools: adapter.requests[0]?.tools,
    installed: events.filter(event => event.type === 'user/message' && event.data.source.kind === 'product-installed-skills')
      .map(event => event.type === 'user/message' ? { source: event.data.source, content: event.data.content } : undefined),
    kitInstructions: events.filter(event => event.type === 'user/message' && event.data.source.kind === 'product-expert-kit-instructions')
      .map(event => event.type === 'user/message' ? { source: event.data.source, content: event.data.content } : undefined),
    catalog: events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'skill-catalog')
      .map(event => event.type === 'user/message' ? { source: event.data.source, content: event.data.content } : undefined),
    retrieval: events.filter(event => event.type === 'tool/call' || event.type === 'tool/result').map((event) => {
      if (event.type === 'tool/call') return { type: event.type, data: event.data }
      const { id: _messageId, ...message } = event.data.message
      return { type: event.type, data: { ...event.data, message } }
    }),
  }
  expect(JSON.stringify(recording)).toContain('knowledgeBaseIds')
  expect(JSON.stringify(recording)).toContain('Recorded enterprise policy.')
  const knowledgeResults = events.filter(event => event.type === 'tool/result'
    && ['retrieve-policy', 'read-policy-source'].includes(event.data.message.toolCallId))
  expect(knowledgeResults).toHaveLength(2)
  const { content: _content, score: _score, ...source } = policyHit
  expect(knowledgeResults.map(event => event.type === 'tool/result' ? event.data.meta : undefined))
    .toEqual([{ kind: 'product-knowledge-sources-v1', sources: [source] }, { kind: 'product-knowledge-sources-v1', sources: [source] }])
  expect(JSON.stringify(recording)).toContain('Execution mode: PTC.')
  expect(JSON.stringify(recording)).toContain('Use policy evidence before making a recommendation.')
  expect(JSON.stringify(recording)).toContain('Compare the retrieved policy before reporting.')
  expect(JSON.stringify(events)).toContain('product-installed-skills')
  expect(JSON.stringify(events)).toContain(skill.sha256)
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).toContain(ordersRead)
  expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain(ordersRead)
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).toContain(publicToolName(connectorServerName('crm'), 'orders_read'))
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).not.toContain(publicToolName(connectorServerName('unreferenced'), 'orders_read'))
  expect(mcpCalls).toEqual(['orders_read'])
  expect(JSON.stringify(events)).not.toContain(relayCredential)
  expect(JSON.stringify(events)).toContain('product.invalid/erp')
  expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
  await expect(`${JSON.stringify(recording, null, 2).replaceAll(await realpath(root), '<HOME>').replaceAll(root, '<HOME>')}\n`)
    .toMatchFileSnapshot('./expected/capabilities-session.json')
  const execute = (name: string) => ctx.tools.execute({ agent: handle.agent, name, arguments: {},
    callId: ToolCallId(`check-${name}`), signal: new AbortController().signal })
  const decisions: string[] = []
  ctx.on('tools/pre-execute', async (_exec, next) => { const decision = await next(); decisions.push(decision.kind); return decision }, { prepend: true })
  await execute(ordersWrite)
  expect(decisions).toContain('ask')
  await execute(undeclared)
  expect(decisions).toContain('deny')
  connectorVersion = '1.0.1'
  expect((await execute(ordersRead)).isError).toBe(true)
  expect(mcpCalls).toEqual(['orders_read'])
  connectorVersion = '1.0.0'
  connectorReady = false
  expect((await execute(ordersRead)).isError).toBe(true)
  expect(mcpCalls).toEqual(['orders_read'])
  expect(await ctx.skills.get(skill.id, { scope: handle.agent }).catch(() => undefined)).toBeUndefined()
  connectorReady = true
  const installedSnapshot = await readFile(join(root, 'product-capabilities-v1/installed-skills-v1',
    `session-${createHash('sha256').update(handle.agent.session.id).digest('hex')}.json`), 'utf8')
  expect(installedSnapshot).not.toContain(relayCredential)
  expect(installedSnapshot).toContain('product.invalid/erp')
  expect(await request(35, 'skills.uninstall', { id: skill.id })).toMatchObject({ result: { id: skill.id } })
  expect(await request(36, 'skills.installed.read')).toMatchObject({ result: { installed: [] } })
  expect((await ctx.skills.get(skill.id, { scope: handle.agent }))?.content).toContain('Compare the retrieved policy before reporting.')
  expect(await readFile(join(root, 'product-capabilities-v1/installed-skills-v1',
    `session-${createHash('sha256').update(handle.agent.session.id).digest('hex')}.json`), 'utf8')).toBe(installedSnapshot)
  expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toContain('Compare the retrieved policy before reporting.')
  const withoutInstalledSkill = await ctx.agents.create({ sessionId: SessionId('without-installed-skill'),
    setup: child => ctx.agentPresets.mount(child, 'minimal').then(() => undefined) })
  onTestFinished(() => withoutInstalledSkill.dispose())
  expect((await ctx.skills.list({ scope: withoutInstalledSkill.agent })).map(entry => entry.name)).not.toContain(skill.id)
  await expect(ctx.skills.get(skill.id, { scope: withoutInstalledSkill.agent })).resolves.toBeUndefined()
  await handle.dispose()
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).not.toContain(ordersRead)
  expect((await ctx.agentPresets.list()).map(preset => preset.id).sort()).toEqual(['minimal', 'ptc'])
  const fresh = await ctx.agents.create({ sessionId: SessionId('after-product-unload'),
    setup: child => ctx.agentPresets.mount(child, 'minimal').then(() => undefined) })
  onTestFinished(() => fresh.dispose())
  expect(await ctx.agentPresets.select(fresh.agent, 'ptc')).toBe('ptc')
  relayCredential = 'private-relay-two'
  readAccess = 'WRITE'
  await ctx.loader.root.update(structuredClone(rows))
  await ctx.loader.await()
  await ctx.loader.resolve('product-runtime').fiber?.await()
  const restored = await ctx.agents.create({ sessionId: SessionId('capability-session'), seed: events,
    agentOptions: { provider: 'fixture', model: 'fixture' }, setup: child => ctx.agentPresets.mount(child, composed).then(() => undefined) })
  onTestFinished(() => restored.dispose())
  const assemblies = await Promise.all([ctx.systemPrompt.assemble({ agent: restored.agent, scope: restored.agent }),
    ctx.systemPrompt.assemble({ agent: restored.agent, scope: restored.agent })])
  for (const assembly of assemblies) expect(assembly.tools.map(tool => tool.name)).toContain(ordersRead)
  restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the review.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(restored.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2) })
  expect(restored.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
    && event.data.source.kind === 'product-expert-kit-instructions')).toHaveLength(1)
  const resumed = await ctx.tools.execute({ agent: restored.agent, name: ordersRead, arguments: {}, callId: ToolCallId('resumed-read'), signal: new AbortController().signal })
  expect(resumed.isError).toBe(true)
  expect(decisions.at(-1)).toBe('ask')
  expect(mcpCalls).toEqual(['orders_read'])
  readAccess = 'READ'
  expect((await ctx.tools.execute({ agent: restored.agent, name: ordersRead, arguments: {},
    callId: ToolCallId('resumed-approved-read'), signal: new AbortController().signal })).isError).toBe(false)
  expect(mcpCalls).toEqual(['orders_read', 'orders_read'])
  publishedKit = { ...kit, version: '2', sha256: 'c'.repeat(64) }
  expect((await ctx.skills.get('expert-kit-policy-kit', { scope: restored.agent }))?.content)
    .toContain('Use policy evidence before making a recommendation.')
  expect((await ctx.skills.get('kit-check', { scope: restored.agent }))?.content).toContain('Confirm policy scope.')
  kitRevoked = true
  await expect(ctx.skills.get('expert-kit-policy-kit', { scope: restored.agent })).rejects.toThrow('Kit access revoked')
  await expect(ctx.skills.get('kit-check', { scope: restored.agent })).rejects.toThrow('Kit access revoked')
  const beforeDenial = adapter.requests.length
  const runtimeErrors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { runtimeErrors.push(error) })
  restored.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after revocation.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => {
    expect(runtimeErrors).toHaveLength(1)
  })
  expect(runtimeErrors[0]).toMatchObject({ code: 'KIT_ACCESS_REVOKED' })
  expect(adapter.requests).toHaveLength(beforeDenial)
  emitMessage({ type: 'extension-control', namespace: 'product', requestId: 92, method: 'expertKits.install', payload: { id: 'slow-kit' } })
  await vi.waitFor(() => { expect(hanging.has('slow-kit')).toBe(true) })
  emitMessage({ type: 'extension-control-cancel', namespace: 'product', requestId: 92 })
  await vi.waitFor(() => { expect(responses.has(92)).toBe(true) })
  expect(responses.get(92)?.failure).toMatchObject({ code: 'PRODUCT_REQUEST_CANCELLED' })
  expect(cancelled).toContain(hanging.get('slow-kit'))
  hanging.delete('slow-kit')
  emitMessage({ type: 'extension-control', namespace: 'product', requestId: 90, method: 'skills.install', payload: { id: 'slow-skill' } })
  await vi.waitFor(() => { expect(hanging.has('slow-skill')).toBe(true) })
  emitMessage({ type: 'extension-control-cancel', namespace: 'product', requestId: 90 })
  await vi.waitFor(() => { expect(responses.has(90)).toBe(true) })
  expect(responses.get(90)?.failure).toMatchObject({ code: 'PRODUCT_REQUEST_CANCELLED' })
  expect(cancelled).toContain(hanging.get('slow-skill'))
  hanging.clear()
  emitMessage({ type: 'extension-control', namespace: 'product', requestId: 91, method: 'skills.install', payload: { id: 'slow-skill' } })
  await vi.waitFor(() => { expect(hanging.has('slow-skill')).toBe(true) })
  emitMessage({ type: 'extension-control', namespace: 'product', requestId: 93, method: 'expertKits.install', payload: { id: 'slow-kit' } })
  await vi.waitFor(() => { expect(hanging.has('slow-kit')).toBe(true) })
  const productFiber = ctx.loader.resolve('product-runtime').fiber
  await ctx.loader.root.update([])
  await ctx.loader.await()
  await productFiber?.await()
  expect(cancelled).toContain(hanging.get('slow-skill'))
  expect(cancelled).toContain(hanging.get('slow-kit'))
  expect(ctx.tools.schemas(restored.agent).map(tool => tool.name)).not.toContain(ordersRead)
  expect((await ctx.agentPresets.list()).map(preset => preset.id).sort()).toEqual(['minimal', 'ptc'])
  await restored.dispose()
  const brokenPath = join(root, 'product-capabilities-v1/tasks-v1', `${composed}.json`)
  await writeFile(brokenPath, '{broken snapshot')
  await ctx.loader.root.update(structuredClone(rows))
  await ctx.loader.await()
  await ctx.loader.resolve('product-runtime').fiber?.await()
  const blocked = await ctx.agents.create({ sessionId: SessionId('capability-session'), seed: events,
    agentOptions: { provider: 'fixture', model: 'fixture' }, setup: child => ctx.agentPresets.mount(child, composed).then(() => undefined) })
  onTestFinished(() => blocked.dispose())
  expect(JSON.stringify(blocked.agent.session.snapshotEvents())).toContain('Find the policy.')
  expect((await ctx.agentPresets.list()).find(preset => preset.id === composed)).toMatchObject({ selectable: false, defaultable: false })
  expect(ctx.tools.schemas(blocked.agent).map(tool => tool.name).sort()).toEqual(['knowledge_destinations', 'knowledge_save'])
  const blankBlocked = await ctx.agents.create({ sessionId: SessionId('blocked-blank-session'),
    setup: child => ctx.agentPresets.mount(child, composed).then(() => undefined) })
  onTestFinished(() => blankBlocked.dispose())
  const blankEvents = blankBlocked.agent.session.snapshotEvents()
  await expect(ctx.agentPresets.select(blankBlocked.agent, 'ptc')).rejects.toMatchObject({ code: 'TASK_SNAPSHOT_INVALID' })
  expect(ctx.agentPresets.composedPreset(blankBlocked.agent.ctx)).toBe(composed)
  expect(blankBlocked.agent.session.snapshotEvents()).toEqual(blankEvents)
  const beforeBlocked = adapter.requests.length
  blocked.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue with the broken snapshot.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(runtimeErrors).toHaveLength(2) })
  expect(runtimeErrors[1]).toMatchObject({ code: 'TASK_SNAPSHOT_INVALID' })
  expect(adapter.requests).toHaveLength(beforeBlocked)
  expect(await readFile(brokenPath, 'utf8')).toBe('{broken snapshot')
  expect(await readFile(`${brokenPath}.diagnostic.json`, 'utf8')).toContain('TASK_SNAPSHOT_INVALID')
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect((await ctx.agentPresets.list()).map(preset => preset.id).sort()).toEqual(['minimal', 'ptc'])
})
