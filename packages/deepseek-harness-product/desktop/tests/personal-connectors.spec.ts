import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { PersonalConnectors } from '../src/personal-connectors.ts'
import { ConnectorProxy } from '../src/connector-proxy.ts'

it('rejects query-bearing MCP endpoints at the shared draft boundary', () => {
  expect(() => ConnectorDraftSchema.parse({ kind: 'connector', id: 'query-mcp', version: '1.0.0',
    name: 'Query MCP', summary: 'Query MCP', category: 'other', transport: 'streamable-http',
    url: 'https://example.test/mcp?tenant=hidden' })).toThrow()
})

it('discovers real MCP annotations without business calls, encrypts secrets, isolates failures and revokes device access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-test-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const requests: string[] = []
  const headers: string[] = []
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const call = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { protocolVersion?: string } }
    requests.push(call.method); headers.push(request.headers['x-private-secret'] as string)
    if (call.id === undefined) { response.writeHead(202).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: call.method === 'initialize'
      ? { protocolVersion: call.params?.protocolVersion, serverInfo: { name: 'personal-fixture', version: '1.0.0' }, capabilities: { tools: {} } }
      : { tools: [{ name: 'read_orders', description: 'Read orders', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'destructive_read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } },
        { name: 'write_orders', inputSchema: { type: 'object' } }, { name: 'undeclared', inputSchema: { type: 'object' } }] } }))
  })().catch(() => { response.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('No fixture port')
  const endpoint = `http://127.0.0.1:${address.port}/mcp`
  const key = randomBytes(32)
  const secure = { isEncryptionAvailable: () => true, encryptString: (value: string): Buffer => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv)
    return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()])
  }, decryptString: (value: Buffer): string => {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16))
    return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString()
  } }
  let owner = 'employee-one'
  const manager = new PersonalConnectors(root, secure, () => owner)
  onTestFinished(() => manager.close())
  const saved: unknown[] = []
  let storedEntry: Record<string, unknown> = {}
  let failUpdate = false
  let lostReceipt = false
  let confirmationOffline = false
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-token',
    fetch: vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === 'DELETE') return Response.json({ success: true, data: true })
      if (!init?.body) {
        if (confirmationOffline) throw new Error('confirmation offline')
        return Response.json({ success: true, data: storedEntry })
      }
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request body')
      if (failUpdate) throw new Error('offline')
      const value = JSON.parse(init.body) as Record<string, unknown>
      saved.push(value)
      if (value.id === 'my-orders') storedEntry = { ...storedEntry, ...value, tools: (value.toolNames as string[]).map(name => ({ name })) }
      if (lostReceipt) throw new Error('commit receipt lost')
      return Response.json({ success: true, data: {} })
    }) })
  const signal = new AbortController().signal
  const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'my-orders', version: '1.0.0', name: 'Orders', summary: 'Orders',
    category: 'developer-tools', transport: 'streamable-http', url: endpoint, headers: { 'x-private-secret': 'device-secret' } })
  await manager.save(draft, api, owner, signal)
  expect(saved).toMatchObject([{ headers: { 'x-private-secret': '' }, environment: {}, toolNames: ['read_orders', 'destructive_read', 'write_orders', 'undeclared'] }])
  expect(JSON.stringify(saved)).not.toContain('device-secret')
  const encrypted = await readFile(join(root, (await readdir(root))[0]!))
  expect(encrypted.toString()).not.toContain('device-secret')
  const entry = { id: draft.id, version: draft.version, transport: draft.transport, url: endpoint, command: '', arguments: [],
    headers: { 'x-private-secret': '' },
    ownerEmployeeId: owner, visibility: 'PERSONAL', authMode: 'none', status: 'ready', ready: true,
    tools: [{ name: 'read_orders', access: 'WRITE' }, { name: 'destructive_read', access: 'WRITE' }, { name: 'write_orders', access: 'WRITE' }] }
  storedEntry = { ...entry, canEdit: true, name: draft.name, summary: draft.summary, category: draft.category }
  const discoveryRequests = requests.length
  expect(await manager.enrich([entry, { ...entry, id: 'missing-config' }], signal, false))
    .toMatchObject([{ configurationStatus: 'CONFIGURED' }, { configurationStatus: 'REQUIRED' }])
  expect(requests).toHaveLength(discoveryRequests)
  const enriched = await manager.enrich([entry, { ...entry, id: 'missing-config' }], signal) as Record<string, unknown>[]
  expect(enriched[0]?.tools).toMatchObject([{ name: 'read_orders', access: 'READ' }, { name: 'destructive_read', access: 'WRITE' }, { name: 'write_orders', access: 'WRITE' }])
  expect(enriched[1]).toMatchObject({ status: 'needs-configuration', ready: false })
  expect(requests).not.toContain('tools/call')
  expect(headers.every(value => value === 'device-secret')).toBe(true)
  const proxy = new ConnectorProxy(async () => enriched)
  onTestFinished(() => proxy.close())
  await proxy.start()
  const safe = proxy.catalog(enriched)
  expect(JSON.stringify(safe)).not.toContain('device-secret')
  expect(JSON.stringify(safe)).not.toContain('employee-token')
  const device = new PersonalConnectors(join(root, 'another-device'), secure, () => owner)
  onTestFinished(() => device.close())
  expect(await device.enrich([storedEntry], signal)).toMatchObject([{ configurationStatus: 'REQUIRED', canConfigure: true }])
  const personalEntry = storedEntry
  storedEntry = { ...storedEntry, visibility: 'COMPANY', canEdit: false, canSubmit: false, canDelete: false }
  owner = 'recipient'
  const target = { id: draft.id, version: draft.version }
  const deviceRead = await device.manage('extensions.connector.configuration.read', target, api, owner, signal)
  expect(deviceRead).toMatchObject({ configured: false, headers: ['x-private-secret'], environment: [] })
  expect(JSON.stringify(deviceRead)).not.toContain('device-secret')
  await expect(device.manage('extensions.connector.read', target, api, owner, signal)).rejects.toMatchObject({ code: 'EXTENSION_OWNER_REQUIRED' })
  await expect(device.manage('extensions.connector.configuration.save', { ...target,
    configuration: { headers: {}, environment: {}, timeoutSeconds: 60 } }, api, owner, signal))
    .rejects.toMatchObject({ code: 'CONNECTOR_CONFIGURATION_REQUIRED' })
  await expect(device.manage('extensions.connector.configuration.save', { ...target,
    configuration: { headers: { 'x-private-secret': 'device-secret' }, environment: {}, timeoutSeconds: 60, url: 'https://other.example' } }, api, owner, signal)).rejects.toThrow()
  const beforeConfigure = saved.length
  expect(await device.manage('extensions.connector.configuration.save', { ...target,
    configuration: { headers: { 'x-private-secret': 'device-secret' }, environment: {}, timeoutSeconds: 60 } }, api, owner, signal))
    .toEqual({ ...target, configured: true })
  expect(saved).toHaveLength(beforeConfigure)
  expect(await device.enrich([storedEntry], signal)).toMatchObject([{ version: '1.0.0', configurationStatus: 'CONFIGURED',
    tools: [{ access: 'READ' }, { access: 'WRITE' }, { access: 'WRITE' }] }])
  expect(JSON.stringify(await device.manage('extensions.connector.configuration.read', target, api, owner, signal))).not.toContain('device-secret')
  expect(await device.manage('extensions.connector.configuration.save', { ...target,
    configuration: { headers: { 'x-private-secret': '' }, environment: {}, timeoutSeconds: 30 } }, api, owner, signal)).toMatchObject({ configured: true })
  owner = 'another-recipient'
  expect(await device.enrich([storedEntry], signal)).toMatchObject([{ configurationStatus: 'REQUIRED' }])
  const disabled = { ...storedEntry, status: 'disabled', ready: false }
  expect(await device.enrich([disabled], signal)).toMatchObject([{ status: 'disabled', ready: false }])
  storedEntry = disabled
  await expect(device.manage('extensions.connector.configuration.save', { ...target, configuration: {} }, api, owner, signal)).rejects.toMatchObject({ code: 'FEATURE_UNAVAILABLE' })
  storedEntry = personalEntry; owner = 'employee-one'
  await device.close()
  const oauth = new PersonalConnectors(join(root, 'oauth'), secure, () => owner, async () => ({
    id: 'configured-provider', version: '1.0.0', transport: 'streamable-http', url: endpoint,
    authMode: 'oauth', ready: true, visibility: 'SHARED', headers: { 'x-private-secret': 'device-secret' },
  }))
  onTestFinished(() => oauth.close())
  const oauthDraft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'my-oauth', version: '1.0.0',
    name: 'Personal OAuth', summary: 'Configured provider', category: 'developer-tools',
    transport: 'streamable-http', oauthProviderId: 'configured-provider' })
  await oauth.save(oauthDraft, api, owner, signal)
  expect(saved[1]).toMatchObject({ authMode: 'oauth', oauthProviderId: 'configured-provider',
    url: endpoint, headers: {}, environment: {} })
  expect(JSON.stringify(saved)).not.toContain('device-secret')
  expect(requests).not.toContain('tools/call')
  const unauthorized = new PersonalConnectors(join(root, 'unauthorized'), secure, () => owner, async () => ({
    id: 'configured-provider', version: '1.0.0', transport: 'streamable-http', url: endpoint,
    authMode: 'oauth', ready: false, visibility: 'SHARED',
  }))
  onTestFinished(() => unauthorized.close())
  await expect(unauthorized.save(oauthDraft, api, owner, signal)).rejects.toMatchObject({ code: 'CONNECTOR_AUTHORIZATION_REQUIRED' })
  expect(saved).toHaveLength(2)
  const editing = await manager.manage('extensions.connector.read', { id: draft.id, version: draft.version }, api, owner, signal) as { draft: unknown }
  const update = ConnectorDraftSchema.parse(editing.draft)
  expect(update.version).toBe('1.0.1')
  expect(update.headers).toEqual({ 'x-private-secret': '' })
  expect(JSON.stringify(editing)).not.toContain('device-secret')
  await expect(manager.manage('extensions.connector.update', { id: draft.id, version: draft.version,
    draft: { ...update, url: 'https://another.example/mcp' } }, api, owner, signal)).rejects.toMatchObject({ code: 'CONNECTOR_CONFIGURATION_REQUIRED' })
  failUpdate = true
  const edited = { ...update, name: 'Updated orders' }
  await expect(manager.manage('extensions.connector.update', { id: draft.id, version: draft.version, draft: edited }, api, owner, signal))
    .rejects.toMatchObject({ code: 'CONNECTOR_SAVE_PENDING', retryable: true })
  expect((await readdir(root)).filter(name => name.endsWith('.pending'))).toHaveLength(1)
  const resumed = await manager.manage('extensions.connector.read', { id: draft.id, version: draft.version }, api, owner, signal)
  expect(resumed).toMatchObject({ savePending: true, draft: { name: 'Updated orders', headers: { 'x-private-secret': '' } } })
  expect(JSON.stringify(resumed)).not.toContain('device-secret')
  await expect(manager.manage('extensions.connector.update', { id: draft.id, version: draft.version, draft: update }, api, owner, signal))
    .rejects.toMatchObject({ code: 'CONNECTOR_SAVE_PENDING' })
  failUpdate = false
  expect(await manager.manage('extensions.connector.update', { id: draft.id, version: draft.version, draft: edited }, api, owner, signal))
    .toMatchObject({ version: '1.0.1' })
  expect(saved[2]).toMatchObject({ version: '1.0.1', name: 'Updated orders', headers: { 'x-private-secret': '' } })
  expect(headers.every(value => value === 'device-secret')).toBe(true)
  await expect(manager.manage('extensions.connector.read', { id: draft.id, version: '1.0.0' }, api, owner, signal)).rejects.toMatchObject({ code: 'EXTENSION_VERSION_CONFLICT' })
  await expect(manager.manage('extensions.connector.read', { id: draft.id, version: '1.0.1' }, api, 'another', signal)).rejects.toMatchObject({ code: 'EXTENSION_OWNER_REQUIRED' })
  const next = await manager.manage('extensions.connector.read', { id: draft.id, version: '1.0.1' }, api, owner, signal) as { draft: unknown }
  lostReceipt = true
  expect(await manager.manage('extensions.connector.update', { id: draft.id, version: '1.0.1', draft: next.draft }, api, owner, signal))
    .toMatchObject({ version: '1.0.2' })
  expect((await readdir(root)).some(name => name.endsWith('.pending'))).toBe(false)
  expect(await manager.enrich([storedEntry], signal)).toMatchObject([{ configurationStatus: 'CONFIGURED' }])
  const last = await manager.manage('extensions.connector.read', { id: draft.id, version: '1.0.2' }, api, owner, signal) as { draft: unknown }
  // The commit succeeds, then neither its receipt nor the confirmation request is available.
  const lastDraft = ConnectorDraftSchema.parse(last.draft)
  confirmationOffline = true
  await expect(manager.save({ ...lastDraft, headers: draft.headers }, api, owner, signal))
    .rejects.toMatchObject({ code: 'CONNECTOR_SAVE_PENDING' })
  const pendingFiles = (await readdir(root)).filter(name => name.endsWith('.pending'))
  expect(pendingFiles).toHaveLength(1)
  expect((await readFile(join(root, pendingFiles[0]!))).toString()).not.toContain('device-secret')
  await manager.close()
  const reopened = new PersonalConnectors(root, secure, () => owner)
  onTestFinished(() => reopened.close())
  owner = 'employee-two'
  expect(await reopened.enrich([{ ...storedEntry, ownerEmployeeId: owner }], signal)).toMatchObject([{ configurationStatus: 'REQUIRED' }])
  expect((await readdir(root)).filter(name => name.endsWith('.pending'))).toHaveLength(1)
  owner = 'employee-one'
  confirmationOffline = false; lostReceipt = false
  expect(await reopened.enrich([storedEntry], signal)).toMatchObject([{ configurationStatus: 'CONFIGURED' }])
  expect((await readdir(root)).some(name => name.endsWith('.pending'))).toBe(false)
  const restored = await reopened.manage('extensions.connector.read', { id: draft.id, version: '1.0.3' }, api, owner, signal)
  expect(restored).toMatchObject({ configured: true })
  expect(JSON.stringify(restored)).not.toContain('device-secret')
  expect(await reopened.manage('extensions.connector.delete', { id: draft.id, version: '1.0.3' }, api, owner, signal)).toMatchObject({ removed: true })
  expect(requests).not.toContain('tools/call')
  await reopened.resetIdentity(undefined)
  owner = 'employee-two'
  expect(await reopened.enrich([{ ...entry, ownerEmployeeId: owner }], signal)).toMatchObject([{ ready: false, configurationStatus: 'REQUIRED' }])
})

it('closes discovery and cached stdio children and scrubs ambient credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-stdio-test-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AMBIENT_EMPLOYEE_TOKEN', 'must-not-reach-child')
  onTestFinished(() => { vi.unstubAllEnvs() })
  const child = `
    import readline from 'node:readline';
    readline.createInterface({input: process.stdin}).on('line', line => {
      const call = JSON.parse(line);
      if (call.id === undefined) return;
      const result = call.method === 'initialize' ? {
        protocolVersion: call.params.protocolVersion, serverInfo: {name:'stdio-fixture',version:'1'}, capabilities:{tools:{}}
      } : {tools:[{name:'read',description:JSON.stringify({pid:process.pid,scrubbed:!process.env.AMBIENT_EMPLOYEE_TOKEN,configured:process.env.PRIVATE_VALUE==='secret'}),
        inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:call.id,result})+'\\n');
    });`
  const secure = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => bytes.toString() }
  const manager = new PersonalConnectors(root, secure, () => 'employee-one')
  onTestFinished(() => manager.close())
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-token',
    fetch: async () => Response.json({ success: true, data: {} }) })
  const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'my-stdio', version: '1.0.0', name: 'Stdio', summary: 'Stdio test',
    category: 'developer-tools', transport: 'stdio', command: process.execPath, arguments: ['--input-type=module', '-e', child], environment: { PRIVATE_VALUE: 'secret' } })
  await manager.save(draft, api, 'employee-one', new AbortController().signal)
  const enriched = await manager.enrich([{ id: draft.id, version: draft.version, ownerEmployeeId: 'employee-one', visibility: 'PERSONAL',
    transport: 'stdio', command: draft.command, arguments: draft.arguments, authMode: 'none', ready: true, status: 'ready', tools: [{ name: 'read' }] }]) as { tools: { description: string }[] }[]
  const evidence = JSON.parse(enriched[0]!.tools[0]!.description) as { pid: number; scrubbed: boolean; configured: boolean }
  expect(evidence).toMatchObject({ scrubbed: true, configured: true })
  expect(() => process.kill(evidence.pid, 0)).not.toThrow()
  await manager.close()
  expect(() => process.kill(evidence.pid, 0)).toThrow()
})

it('deletes only the selected connector connections while another connector finishes an in-flight call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-delete-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const started = join(root, 'call-started')
  const released = join(root, 'call-released')
  const child = `
    import readline from 'node:readline';
    import { existsSync, writeFileSync } from 'node:fs';
    const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const call = JSON.parse(line);
      if (call.id === undefined) return;
      if (call.method === 'tools/call') {
        writeFileSync(process.env.CALL_STARTED, 'started');
        const wait = setInterval(() => {
          if (!existsSync(process.env.CALL_RELEASED)) return;
          clearInterval(wait);
          reply(call.id, {content:[{type:'text',text:'completed'}]});
        }, 10);
        return;
      }
      reply(call.id, call.method === 'initialize' ? {
        protocolVersion:call.params.protocolVersion,serverInfo:{name:'delete-fixture',version:'1'},capabilities:{tools:{}}
      } : {tools:[{name:'read',description:String(process.pid),inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]});
    });`
  const employee = 'employee-one'
  const secure = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString() }
  const manager = new PersonalConnectors(root, secure, () => employee)
  onTestFinished(() => manager.close())
  const drafts = [
    { id: 'connector-a', version: '1.0.0' }, { id: 'connector-a', version: '1.0.1' }, { id: 'connector-b', version: '1.0.0' },
  ].map(identity => ConnectorDraftSchema.parse({ ...identity, kind: 'connector', name: identity.id, summary: 'Deletion fixture',
    category: 'other', transport: 'stdio', command: process.execPath, arguments: ['--input-type=module', '-e', child],
    environment: { CALL_STARTED: started, CALL_RELEASED: released } }))
  const entries = drafts.map(draft => ({ ...draft, visibility: 'PERSONAL', ownerEmployeeId: employee, canEdit: true,
    authMode: 'none', ready: true, status: 'ready', tools: [{ name: 'read' }] }))
  let rejectDeletion = true
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'fixture-token',
    fetch: async (_url, init) => {
      if (init?.method === 'DELETE' && rejectDeletion) return Response.json({ success: false }, { status: 503 })
      return Response.json({ success: true, data: init?.method ? {} : entries[1] })
    } })
  const signal = new AbortController().signal
  for (const draft of drafts) await manager.save(draft, api, employee, signal)
  const connections = await manager.enrich(entries, signal) as { tools: { description: string }[] }[]
  const pids = connections.map(entry => Number(entry.tools[0]!.description))
  const target = { id: 'connector-a', version: '1.0.1' }
  await expect(manager.manage('extensions.connector.delete', target, api, employee, signal)).rejects.toThrow()
  for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow()

  const proxy = new ConnectorProxy(async () => [entries[2]], (request, response, entry, signal) =>
    manager.serveStdio(request, response, entry, signal))
  onTestFinished(() => proxy.close())
  await proxy.start()
  const [relay] = proxy.catalog([entries[2]]) as { url: string; headers: Record<string, string> }[]
  const client = new Client({ name: 'delete-test', version: '1.0.0' })
  onTestFinished(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(relay!.url), { requestInit: { headers: relay!.headers } }))
  const completion = client.callTool({ name: 'read', arguments: {} }).then(result => ({ result }), (error: unknown) => ({ error }))
  await expect.poll(() => readFile(started, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  })).toBe('started')
  rejectDeletion = false
  expect(await manager.manage('extensions.connector.delete', target, api, employee, signal)).toMatchObject({ removed: true })
  await writeFile(released, 'released')
  expect(await completion).toMatchObject({ result: { content: [{ type: 'text', text: 'completed' }] } })
  for (const pid of pids.slice(0, 2)) expect(() => process.kill(pid, 0)).toThrow()
  expect(() => process.kill(pids[2]!, 0)).not.toThrow()
  const remaining = await manager.enrich([entries[2]], signal) as { tools: { description: string }[] }[]
  expect(Number(remaining[0]!.tools[0]!.description)).toBe(pids[2])
  await manager.resetIdentity(undefined)
  expect(() => process.kill(pids[2]!, 0)).toThrow()
})

it.each(['initialize', 'tools/list'])('applies the configured timeout to stalled %s without activating a resource', async (stalledMethod) => {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-timeout-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const requests: string[] = []
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const call = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string; params?: { protocolVersion?: string } }
    requests.push(call.method)
    if (call.method === stalledMethod) return
    if (call.id === undefined) { response.writeHead(202).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
      protocolVersion: call.params?.protocolVersion, serverInfo: { name: 'stalled', version: '1' }, capabilities: { tools: {} },
    } }))
  })().catch(() => { response.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port')
  const secure = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => bytes.toString() }
  const manager = new PersonalConnectors(root, secure, () => 'employee')
  onTestFinished(() => manager.close())
  const upload = vi.fn(async () => Response.json({ success: true, data: {} }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-token', fetch: upload })
  const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'stalled-mcp', version: '1.0.0', name: 'Stalled', summary: 'Stalled fixture',
    category: 'other', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, timeoutSeconds: 1 })
  const started = Date.now()
  await expect(manager.save(draft, api, 'employee', new AbortController().signal)).rejects.toThrow()
  expect(requests).toContain(stalledMethod)
  expect(Date.now() - started).toBeGreaterThanOrEqual(800)
  expect(Date.now() - started).toBeLessThan(4000)
  expect(upload).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})
