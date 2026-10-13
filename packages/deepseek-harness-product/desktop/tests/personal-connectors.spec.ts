import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ExtensionDraftSchema } from '@deepseek-harness/product/authoring'
import { PersonalConnectors } from '../src/personal-connectors.ts'
import { ConnectorProxy } from '../src/connector-proxy.ts'

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
  const draft = ExtensionDraftSchema.parse({ kind: 'connector', id: 'my-orders', version: '1.0.0', name: 'Orders', summary: 'Orders',
    category: 'developer-tools', transport: 'streamable-http', url: endpoint, headers: { 'x-private-secret': 'device-secret' } })
  await manager.save(draft, api, owner, signal)
  expect(saved).toMatchObject([{ headers: {}, environment: {}, toolNames: ['read_orders', 'destructive_read', 'write_orders', 'undeclared'] }])
  expect(JSON.stringify(saved)).not.toContain('device-secret')
  const encrypted = await readFile(join(root, (await readdir(root))[0]!))
  expect(encrypted.toString()).not.toContain('device-secret')
  const entry = { id: draft.id, version: draft.version, transport: draft.transport, url: endpoint, command: '', arguments: [],
    ownerEmployeeId: owner, visibility: 'PERSONAL', authMode: 'none', status: 'ready', ready: true,
    tools: [{ name: 'read_orders', access: 'WRITE' }, { name: 'destructive_read', access: 'WRITE' }, { name: 'write_orders', access: 'WRITE' }] }
  storedEntry = { ...entry, canEdit: true, name: draft.name, summary: draft.summary, category: draft.category }
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
  const oauth = new PersonalConnectors(join(root, 'oauth'), secure, () => owner, async () => ({
    id: 'configured-provider', version: '1.0.0', transport: 'streamable-http', url: endpoint,
    authMode: 'oauth', ready: true, visibility: 'SHARED', headers: { 'x-private-secret': 'device-secret' },
  }))
  onTestFinished(() => oauth.close())
  const oauthDraft = ExtensionDraftSchema.parse({ kind: 'connector', id: 'my-oauth', version: '1.0.0',
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
  const update = ExtensionDraftSchema.parse(editing.draft)
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
  expect(saved[2]).toMatchObject({ version: '1.0.1', name: 'Updated orders', headers: {} })
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
  const lastDraft = ExtensionDraftSchema.parse(last.draft)
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
  await manager.resetIdentity(undefined)
  owner = 'employee-two'
  expect(await manager.enrich([{ ...entry, ownerEmployeeId: owner }], signal)).toMatchObject([{ ready: false, configurationStatus: 'REQUIRED' }])
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
  const draft = ExtensionDraftSchema.parse({ kind: 'connector', id: 'my-stdio', version: '1.0.0', name: 'Stdio', summary: 'Stdio test',
    category: 'developer-tools', transport: 'stdio', command: process.execPath, arguments: ['--input-type=module', '-e', child], environment: { PRIVATE_VALUE: 'secret' } })
  await manager.save(draft, api, 'employee-one', new AbortController().signal)
  const enriched = await manager.enrich([{ id: draft.id, version: draft.version, ownerEmployeeId: 'employee-one', visibility: 'PERSONAL',
    transport: 'stdio', command: draft.command, arguments: draft.arguments, ready: true, status: 'ready', tools: [{ name: 'read' }] }]) as { tools: { description: string }[] }[]
  const evidence = JSON.parse(enriched[0]!.tools[0]!.description) as { pid: number; scrubbed: boolean; configured: boolean }
  expect(evidence).toMatchObject({ scrubbed: true, configured: true })
  expect(() => process.kill(evidence.pid, 0)).not.toThrow()
  await manager.close()
  expect(() => process.kill(evidence.pid, 0)).toThrow()
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
  const draft = ExtensionDraftSchema.parse({ kind: 'connector', id: 'stalled-mcp', version: '1.0.0', name: 'Stalled', summary: 'Stalled fixture',
    category: 'other', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, timeoutSeconds: 1 })
  const started = Date.now()
  await expect(manager.save(draft, api, 'employee', new AbortController().signal)).rejects.toThrow()
  expect(requests).toContain(stalledMethod)
  expect(Date.now() - started).toBeGreaterThanOrEqual(800)
  expect(Date.now() - started).toBeLessThan(4000)
  expect(upload).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})
