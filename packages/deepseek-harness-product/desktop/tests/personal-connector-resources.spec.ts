/** Native MCP consumers retain server context through the credential-owning stdio relay. */
import { Context } from '@deepseek-ai/cordis'
import Agents from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Tools from '@deepseek-ai/dsh-tools'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { ConnectorProxy } from '../src/connector-proxy.ts'
import { PersonalConnectors } from '../src/personal-connectors.ts'

async function fixture(resources = true, timeoutSeconds = 5) {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-resources-'))
  const eventsPath = join(root, 'events.jsonl')
  const stallPath = join(root, 'stall-read')
  const child = `
    import readline from 'node:readline';
    import { appendFileSync, existsSync } from 'node:fs';
    const record = method => appendFileSync(process.env.EVENTS_PATH, JSON.stringify({pid:process.pid,method})+'\\n');
    record('started');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const call = JSON.parse(line);
      record(call.method);
      if (call.id === undefined) return;
      if (['resources/read','tools/call'].includes(call.method) && existsSync(process.env.STALL_PATH)) return;
      const result = call.method === 'initialize' ? {
        protocolVersion:call.params.protocolVersion,serverInfo:{name:'resource-fixture',version:'1'},
        capabilities:{tools:{},...${resources} ? {resources:{}} : {}},
        instructions:'Read product://schema before using the orders tool.'
      } : call.method === 'tools/list' ? {tools:['orders','undeclared'].map(name => ({
        name,description:'Read orders',inputSchema:{type:'object'},annotations:{readOnlyHint:true}
      }))} : call.method === 'resources/list' && ${resources} ? call.params?.cursor === 'second'
        ? {resources:[{uri:'product://rules',name:'Order rules'}]}
        : {resources:[{uri:'product://schema',name:'Order schema'}],nextCursor:'second'}
      : call.method === 'resources/templates/list' && ${resources}
        ? {resourceTemplates:[{uriTemplate:'product://orders/{id}',name:'Order'}]}
      : call.method === 'resources/read' && ${resources}
        ? {contents:[{uri:call.params.uri,mimeType:'text/plain',text:'order_id:string'}]}
      : call.method === 'tools/call' ? {content:[{type:'text',text:'Orders fixture'}]}
      : undefined;
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:call.id,...result === undefined
        ? {error:{code:-32601,message:'Method not found'}} : {result}})+'\\n');
    });`
  const employee = 'resource-owner'
  const secure = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString() }
  const manager = new PersonalConnectors(join(root, 'configuration'), secure, () => employee)
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.invalid', getSessionToken: () => 'fixture-token',
    fetch: async () => Response.json({ success: true, data: {} }) })
  const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'resource-mcp', version: '1.0.0', name: 'Resources',
    summary: 'Native resource relay', category: 'other', transport: 'stdio', command: process.execPath,
    arguments: ['--input-type=module', '-e', child], timeoutSeconds,
    environment: { EVENTS_PATH: eventsPath, STALL_PATH: stallPath } })
  const entry = { ...draft, visibility: 'PERSONAL', ownerEmployeeId: employee, authMode: 'none',
    status: 'ready', ready: true, tools: [{ name: 'orders' }] }
  const proxy = new ConnectorProxy(async () => [entry], (request, response, connector, signal) =>
    manager.serveStdio(request, response, connector, signal))
  const contexts: Context[] = []
  const clients: Client[] = []
  const transports = new WeakMap<Client, StreamableHTTPClientTransport>()
  const events = async () => {
    try {
      return (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { pid: number; method: string })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
  }
  onTestFinished(async () => {
    try {
      const native = await Promise.allSettled(contexts.map(ctx => ctx.fiber.dispose()))
      const downstream = await Promise.allSettled(clients.map(client => client.close()))
      const relay = await Promise.allSettled([proxy.close()])
      const upstream = await Promise.allSettled([manager.close()])
      api.close()
      for (const result of [...native, ...downstream, ...relay, ...upstream]) expect(result.status).toBe('fulfilled')
      const pids = new Set((await events()).map(event => event.pid))
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  await manager.save(draft, api, employee, new AbortController().signal)
  await proxy.start()
  const [relay] = proxy.catalog([entry]) as { url: string; headers: Record<string, string> }[]
  if (!relay) throw new Error('Fixture relay is unavailable')
  const native = async (direct = false) => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    await ctx.plugin(Tools)
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(Agents)
    await ctx.plugin(NativeExecutor)
    await ctx.plugin(McpResources)
    await ctx.plugin(McpClient, { serverName: 'resources', toolCallTimeoutMs: 10_000, failOnStartupError: true,
      ...direct ? { transport: 'stdio', command: process.execPath, args: draft.arguments, env: draft.environment, cwd: '' }
        : { transport: 'streamable-http', url: relay.url, headers: relay.headers } })
    return { ctx, call: (name: string, args: Record<string, string> = {}, signal = new AbortController().signal) =>
      executeModelToolFixture(ctx, { name, arguments: name.startsWith('mcp__') ? args : { server: 'resources', ...args },
        signal, callId: ToolCallId(`resource-${name}`) }),
    instructions: async () => (await ctx.systemPrompt.assemble({ signal: new AbortController().signal })).sections
      .find(section => section.name === 'mcp:resources')?.text }
  }
  const sdk = async () => {
    const client = new Client({ name: 'resource-relay-test', version: '1' })
    clients.push(client)
    const transport = new StreamableHTTPClientTransport(new URL(relay.url), { requestInit: { headers: relay.headers } })
    transports.set(client, transport)
    await client.connect(transport)
    return client
  }
  const transport = (client: Client) => {
    const transport = transports.get(client)
    if (!transport) throw new Error('Fixture SDK transport is unavailable')
    return transport
  }
  return { entry, events, manager, native, proxy, relay, sdk, stallPath, transport }
}

it('preserves native server instructions and resource operations through the personal stdio relay', async () => {
  const f = await fixture()
  const sdk = await f.sdk()
  await expect(sdk.callTool({ name: 'undeclared', arguments: {} })).rejects.toThrow('not declared')
  expect((await f.events()).filter(event => event.method === 'tools/call')).toEqual([])
  await sdk.close()
  const direct = await f.native(true)
  const relay = await f.native()
  const observe = async (consumer: typeof relay) => ({
    instructions: await consumer.instructions(),
    listed: await consumer.call('list_mcp_resources'),
    templates: await consumer.call('list_mcp_resource_templates'),
    read: await consumer.call('read_mcp_resource', { uri: 'product://schema' }),
  })
  const expected = await observe(direct)
  expect(expected.listed.isError).toBe(false)
  expect(JSON.stringify(expected.listed)).toContain('product://rules')
  expect(expected.instructions).toContain('Read product://schema before using the orders tool.')
  const actual = await observe(relay)
  expect(actual).toEqual(expected)
  expect(actual).toMatchSnapshot()
  expect(direct.ctx.tools.get('mcp__resources__undeclared')).toBeDefined()
  expect(relay.ctx.tools.get('mcp__resources__undeclared')).toBeUndefined()
  const reads = (await f.events()).filter(event => event.method === 'resources/read').length
  f.entry.status = 'disabled'
  expect((await relay.call('read_mcp_resource', { uri: 'product://schema' })).isError).toBe(true)
  expect((await f.events()).filter(event => event.method === 'resources/read')).toHaveLength(reads)
})

it('does not advertise resource support absent from the upstream stdio server', async () => {
  const f = await fixture(false)
  const sdk = await f.sdk()
  expect(sdk.getServerCapabilities()?.resources).toBeUndefined()
  expect(sdk.getInstructions()).toBe('Read product://schema before using the orders tool.')
  expect((await sdk.listTools()).tools.map(tool => tool.name)).toEqual(['orders'])
  const consumer = await f.native()
  expect((await consumer.call('list_mcp_resources')).isError).toBe(false)
  expect((await f.events()).some(event => event.method === 'resources/list')).toBe(false)
})

it.each([
  { mode: 'cancelled', operation: 'resources/read' }, { mode: 'timed-out', operation: 'resources/read' },
  { mode: 'cancelled', operation: 'tools/call' }, { mode: 'timed-out', operation: 'tools/call' },
] as const)('cancels $mode $operation without closing the shared stdio client', async ({ mode, operation }) => {
  const f = await fixture(true, mode === 'timed-out' ? 1 : 5)
  const consumer = await f.native()
  await writeFile(f.stallPath, 'stall')
  const controller = new AbortController()
  const name = operation === 'resources/read' ? 'read_mcp_resource' : 'mcp__resources__orders'
  const args = operation === 'resources/read' ? { uri: 'product://schema' } : {}
  const pending = consumer.call(name, args, controller.signal)
  await expect.poll(async () => (await f.events()).some(event => event.method === operation)).toBe(true)
  if (mode === 'cancelled') controller.abort(new Error('Resource read cancelled'))
  expect((await pending).isError).toBe(true)
  await expect.poll(async () => (await f.events()).some(event => event.method === 'notifications/cancelled')).toBe(true)
  const connections = (await f.events()).filter(event => event.method === 'started').length
  await rm(f.stallPath)
  expect((await consumer.call(name, args)).isError).toBe(false)
  expect((await f.events()).filter(event => event.method === 'started')).toHaveLength(connections)
})

it('replaces one Host session only after a valid initialize and releases it on DELETE', async () => {
  const f = await fixture()
  const first = await f.sdk()
  const firstId = f.transport(first).sessionId
  expect(firstId).toEqual(expect.any(String))
  const rejected = await fetch(f.relay.url, { method: 'POST', headers: { ...f.relay.headers,
    accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list' }) })
  expect(rejected.status).toBe(400)
  expect((await first.readResource({ uri: 'product://schema' })).contents).toHaveLength(1)
  const connections = (await f.events()).filter(event => event.method === 'started').length
  const second = await f.sdk()
  const secondId = f.transport(second).sessionId
  expect(secondId).not.toBe(firstId)
  await expect(first.readResource({ uri: 'product://schema' })).rejects.toThrow('MCP session is unavailable')
  const replaced = await fetch(f.relay.url, { headers: { ...f.relay.headers, 'mcp-session-id': firstId! } })
  expect(replaced.status).toBe(404)
  expect((await second.readResource({ uri: 'product://schema' })).contents).toHaveLength(1)
  await f.transport(second).terminateSession()
  const expired = await fetch(f.relay.url, { headers: { ...f.relay.headers, 'mcp-session-id': secondId! } })
  expect(expired.status).toBe(404)
  const third = await f.sdk()
  expect((await third.readResource({ uri: 'product://schema' })).contents).toHaveLength(1)
  expect((await f.events()).filter(event => event.method === 'started')).toHaveLength(connections)
})

it.each(['DELETE', 'identity change'] as const)('settles an in-flight resource read on %s', async (mode) => {
  const f = await fixture()
  const sdk = await f.sdk()
  await writeFile(f.stallPath, 'stall')
  const pending = sdk.readResource({ uri: 'product://schema' }).catch((error: unknown) => error)
  await expect.poll(async () => (await f.events()).some(event => event.method === 'resources/read')).toBe(true)
  if (mode === 'DELETE') await f.transport(sdk).terminateSession()
  else await f.manager.resetIdentity(undefined)
  await sdk.close()
  expect(await pending).toBeInstanceOf(Error)
  if (mode === 'DELETE') {
    await expect.poll(async () => (await f.events()).some(event => event.method === 'notifications/cancelled')).toBe(true)
    await rm(f.stallPath)
    const replacement = await f.sdk()
    expect((await replacement.readResource({ uri: 'product://schema' })).contents).toHaveLength(1)
  }
})
