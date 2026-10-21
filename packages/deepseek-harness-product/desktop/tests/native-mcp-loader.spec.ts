/** The bundled connector runs through a file profile and the official MCP client. */
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Workspace from '@deepseek-ai/dsh-workspace'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { ProductData } from '@deepseek-harness/product-runtime/data'
import * as EncryptedStorage from '@deepseek-harness/product-runtime/native-mcp-storage'
import { NativeMcpStorage } from '../src/native-mcp-storage.ts'
import { secureFixture } from './helpers/mcp-encryption.ts'

class FixtureModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('fixture-read'), name: 'mcp__orders__read', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Order checked.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

it('imports HTTP MCP, keeps secrets out of profiles, restores after restart and releases tools and routes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-mcp-profile-'))
  vi.stubEnv('DSH_HOME', home)
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
  const credential = 'fixture-private-mcp-header'
  const calls: string[] = []
  let declared = true
  let catalogRequests = 0
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/catalog') { catalogRequests += 1; return }
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      if (req.headers.authorization !== credential) { res.writeHead(401).end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const call = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { name: string } }
      if (call.id === undefined) { res.writeHead(202).end(); return }
      if (call.method === 'tools/call') calls.push(call.params?.name ?? '')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id,
        result: call.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : call.method === 'tools/list' ? { tools: declared ? ['read', 'write'].map(name => ({ name,
            description: `Fixture ${name}`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: name === 'read' } })) : [] }
            : { content: [{ type: 'text', text: 'Fixture order result.' }] },
      }))
    })().catch((error) => { res.writeHead(500).end(String(error)) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
  let employee = 'employee'
  const store = new NativeMcpStorage(join(home, 'encrypted'), secureFixture(), () => employee)
  const directory = join(home, 'profile')
  initProfile(directory, [])
  await writeFile(join(directory, 'cordis.yml'), '[]\n')
  const rows = [
    { id: 'storage', name: 'cordis:storage' },
    { id: 'json', name: 'cordis:json', config: { root: join(home, 'storage') } },
    { id: 'domain', name: 'cordis:domain', config: { backend: 'json' } },
    { id: 'persistence', name: 'cordis:persistence', config: { root: join(home, 'sessions') } },
    { id: 'workspace', name: 'cordis:workspace' }, { id: 'tools', name: 'cordis:tools' },
    { id: 'prompt', name: 'cordis:prompt' },
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { id: 'encrypted', name: 'cordis:encrypted' },
    { id: 'connector', name: import.meta.resolve('dsh-mcp-connector'), config: { catalogUrl: `http://127.0.0.1:${address.port}/catalog`, openBrowser: false } },
  ]
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  const profile: ProfileContext = { name: 'test', startedBundles: [], dir: directory,
    patchPath: join(directory, 'cordis.patch.yml'), installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const start = () => boot('test', join(directory, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('webStartup', { trustedHosts: [] })
    new ProductData(ctx, { async invoke(method, payload, signal) {
      if (method === 'auth.getSession') return { authenticated: true, employeeId: employee }
      if (method === 'runtime.connectors.storage') return store.invoke(payload, signal ?? new AbortController().signal)
      throw new Error(`Unexpected private RPC: ${method}`)
    } })
    Object.assign(ctx.loader.builtins, { storage: Storage, json: JsonStorage, domain: Domains, persistence: Persistence,
      workspace: Workspace, tools: Tools, prompt: SystemPrompt, web: WebServer, encrypted: EncryptedStorage,
      llm: LlmRuntime, sessions: Sessions, projections: SessionProjections, agents: Agents, loop: AgentLoop })
  })
  const first = await start()
  onTestFinished(() => first.fiber.dispose())
  expect(catalogRequests).toBe(0)
  const endpoint = (ctx: typeof first) => `http://127.0.0.1:${ctx.webServer.port}/mcp-connector`
  const api = async (ctx: typeof first, method: string, params: object = {}) => {
    const response = await fetch(endpoint(ctx) + '/api', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(10_000) })
    return response.json() as Promise<{ ok: boolean; message: string; detail?: { keys?: string[] }; connections?: object[] }>
  }
  expect((await fetch(endpoint(first) + '/ui/')).status).toBe(200)
  const imported = await api(first, 'importJson', { json: JSON.stringify({ mcpServers: { orders: {
    url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: credential },
  } } }) })
  expect(imported.ok, imported.message).toBe(true)
  await vi.waitFor(() => expect(first.tools.schemas().map(tool => tool.name)).toContain('mcp__orders__read'))
  const execute = (ctx: typeof first, name: string) => ctx.tools.execute({ name, arguments: {},
    callId: ToolCallId(name), signal: new AbortController().signal })
  const adapter = new FixtureModel()
  first.llm.registerAdapter(['fixture'], adapter)
  const agent = await first.agents.create({ sessionId: SessionId('recorded-mcp-session'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  agent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read orders.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => expect(agent.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true))
  const events = agent.agent.session.snapshotEvents()
  expect(JSON.stringify(events)).not.toContain(credential)
  expect(JSON.stringify(adapter.requests)).not.toContain(credential)
  expect(JSON.stringify({
    tools: first.tools.schemas(agent.agent).filter(tool => tool.name.startsWith('mcp__orders__')),
    results: events.filter(event => event.type === 'tool/result').map(event => event.data.message.content),
  }, null, 2) + '\n').toMatchFileSnapshot(new URL('./expected/native-mcp-session.json', import.meta.url).pathname)
  await agent.dispose()
  expect(await execute(first, 'mcp__orders__write')).toMatchObject({ isError: true })
  expect(calls).toEqual(['read'])
  employee = 'another-employee'
  expect(await execute(first, 'mcp__orders__read')).toMatchObject({ isError: true })
  expect(await api(first, 'status')).toMatchObject({ ok: false })
  employee = 'employee'
  expect(JSON.stringify(await api(first, 'status'))).not.toContain(credential)
  expect(await readFile(join(directory, 'cordis.patch.yml'), 'utf8')).not.toContain(credential)
  for (const file of await readdir(join(home, 'encrypted'))) {
    expect((await readFile(join(home, 'encrypted', file))).includes(Buffer.from(credential))).toBe(false)
  }
  await first.fiber.dispose()
  const second = await start()
  onTestFinished(() => second.fiber.dispose())
  expect(second.tools.schemas().map(tool => tool.name)).toContain('mcp__orders__read')
  expect(await execute(second, 'mcp__orders__read')).toMatchObject({ isError: false })
  declared = false
  expect(await execute(second, 'mcp__orders__read')).toMatchObject({ isError: true })
  expect(calls).toEqual(['read', 'read'])
  expect(await api(second, 'catalog')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(catalogRequests).toBe(1))
  const connector = [...second.loader.entries()].find(entry => entry.options.id === 'connector')
  expect(connector?.fiber).toBeDefined()
  await connector!.fiber!.dispose()
  expect(second.tools.schemas().filter(tool => tool.name.startsWith('mcp__orders__'))).toEqual([])
  expect((await fetch(endpoint(second) + '/ui/')).status).toBe(404)
}, 30_000)
