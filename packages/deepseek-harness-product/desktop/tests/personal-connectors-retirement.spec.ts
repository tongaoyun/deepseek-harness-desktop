import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { DeepSeekHarnessProductBridge } from '@deepseek-harness/product/bridge'
import { PersonalConnectors } from '../src/personal-connectors.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-retirement-'))
  const spawns = join(root, 'spawns')
  const employee = 'employee'
  const child = `import { appendFileSync } from 'node:fs'; import readline from 'node:readline';
appendFileSync(${JSON.stringify(spawns)}, String(process.pid) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const call=JSON.parse(line); if(call.id===undefined)return;
 const result=call.method==='initialize' ? {protocolVersion:call.params.protocolVersion,
  serverInfo:{name:'retirement',version:'1'},capabilities:{tools:{}}}
  : {tools:[{name:'read',description:String(process.pid),inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:call.id,result})+'\\n');
});`
  const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'retirement-mcp', version: '1.0.0', name: 'Retirement',
    summary: 'Retirement fixture', category: 'other', transport: 'stdio', command: process.execPath,
    arguments: ['--input-type=module', '-e', child] })
  const entry = (version = draft.version) => ({ ...draft, version, visibility: 'PERSONAL', ownerEmployeeId: employee,
    canEdit: true, authMode: 'none', status: 'ready', ready: true, tools: [{ name: 'read' }] })
  let current = entry()
  const templateStarted = Promise.withResolvers<boolean>()
  const templateRelease = Promise.withResolvers<boolean>()
  let holdTemplate = false
  let templateSignal: AbortSignal | undefined
  const request: typeof fetch = async (url, init) => {
    const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error('Missing connector request body')
      const body = z.object({ version: z.string() }).parse(JSON.parse(init.body))
      current = entry(body.version)
      return Response.json({ success: true, data: {} })
    }
    if (path.endsWith('/configuration-template') && holdTemplate) {
      const captured = current
      holdTemplate = false
      templateSignal = init?.signal ?? undefined
      templateStarted.resolve(true)
      await templateRelease.promise
      return Response.json({ success: true, data: captured })
    }
    if (path === '/api/v1/connectors') return Response.json({ success: true, data: [current],
      pageIndex: 1, pageSize: 100, totalCount: 1, totalPages: 1 })
    if (path === '/api/v1/knowledge-bases') return Response.json({ success: true, data: [],
      pageIndex: 1, pageSize: 100, totalCount: 0, totalPages: 0 })
    return Response.json({ success: true, data: current })
  }
  const manager = new PersonalConnectors(root, {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  }, () => employee, undefined, () => { bridge.invalidateConnectorCatalog() })
  const bridge = new DeepSeekHarnessProductBridge({ serverUrl: 'https://product.example', sessionToken: 'fixture-token',
    initialSession: { authenticated: true, employeeId: employee }, fetch: request,
    connectorRuntime: (value, signal, discover) => manager.enrich(value, signal, discover),
    connectorManagement: async (method, input, api, session, signal) => {
      if (!session.employeeId || !signal) throw new Error('Missing authenticated request')
      if (method === 'extensions.save') return manager.save(ConnectorDraftSchema.parse(input), api, session.employeeId, signal)
      return manager.manage(method, input, api, session.employeeId, signal)
    } })
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'fixture-token', fetch: request })
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const processes = async () => (await actual.readFile(spawns, 'utf8')).trim().split('\n').map(Number)
  onTestFinished(async () => {
    templateRelease.resolve(true)
    await bridge.dispose()
    await manager.close()
    api.close()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  await manager.save(draft, api, employee, new AbortController().signal)
  return { manager, bridge, api, draft, entry, employee, processes, actual,
    filename: join(root, createHash('sha256').update(JSON.stringify([employee, draft.id, draft.version])).digest('hex') + '.bin'),
    holdTemplate: () => { holdTemplate = true }, templateStarted: templateStarted.promise,
    releaseTemplate: () => { templateRelease.resolve(true) }, templateSignal: () => templateSignal }
}

it.each(['publish', 'configure', 'delete'])('prevents a buffered old configuration from starting a connection after %s commits', async (operation) => {
  const test = await fixture()
  const started = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<boolean>()
  let hold = true
  vi.mocked(readFile).mockImplementation(async (...args) => {
    const value = await test.actual.readFile(...args)
    if (hold && args[0] === test.filename) {
      hold = false
      started.resolve(true)
      await release.promise
    }
    return value
  })
  const late = test.manager.enrich([test.entry()])
  onTestFinished(async () => { release.resolve(true); await late })
  await started.promise
  if (operation === 'publish') {
    await test.manager.save({ ...test.draft, version: '1.0.1' }, test.api, test.employee, new AbortController().signal)
  } else {
    await test.manager.manage(`extensions.connector.${operation === 'configure' ? 'configuration.save' : 'delete'}`, {
      id: test.draft.id, version: test.draft.version,
      configuration: { headers: {}, environment: {}, timeoutSeconds: 30 },
    }, test.api, test.employee, new AbortController().signal)
  }
  const committed = await test.processes()
  release.resolve(true)
  expect(await late).toMatchObject([{ ready: false, tools: [] }])
  expect(await test.processes()).toEqual(committed)
  if (operation !== 'delete') {
    const version = operation === 'publish' ? '1.0.1' : '1.0.0'
    expect(await test.manager.enrich([test.entry(version)])).toMatchObject([{ version, configurationStatus: 'CONFIGURED' }])
  }
  await test.manager.close()
  for (const pid of await test.processes()) expect(() => process.kill(pid, 0)).toThrow()
})

it('cancels an old HTTP catalog at commit while cached-client cleanup is still waiting', async () => {
  const test = await fixture()
  // oxlint-disable-next-line typescript/unbound-method -- The original SDK method is called with its receiver.
  const originalList = Client.prototype.listTools
  const cached = new Set<Client>()
  const list = vi.spyOn(Client.prototype, 'listTools').mockImplementation(function (this: Client, ...args) {
    cached.add(this)
    return originalList.apply(this, args)
  })
  await test.manager.enrich([test.entry()])
  list.mockRestore()
  if (cached.size !== 1) throw new Error('Missing cached MCP client')
  const cleanupStarted = Promise.withResolvers<boolean>()
  const cleanupRelease = Promise.withResolvers<boolean>()
  // oxlint-disable-next-line typescript/unbound-method -- The original SDK method is called with its receiver.
  const originalClose = Client.prototype.close
  vi.spyOn(Client.prototype, 'close').mockImplementation(async function (this: Client) {
    if (cached.has(this)) { cleanupStarted.resolve(true); await cleanupRelease.promise }
    await originalClose.call(this)
  })
  test.holdTemplate()
  const late = test.bridge.invokeRuntime('connectors.list', { ids: [test.draft.id] })
    .then(value => ({ value }), (error: unknown) => ({ error }))
  await test.templateStarted
  const save = test.bridge.invoke('extensions.save', { ...test.draft, version: '1.0.1' })
    .then(() => ({ saved: true }), (error: unknown) => ({ error }))
  onTestFinished(async () => { cleanupRelease.resolve(true); test.releaseTemplate(); await Promise.allSettled([late, save]) })
  await cleanupStarted.promise
  expect(test.templateSignal()?.aborted).toBe(true)
  const committed = await test.processes()
  test.releaseTemplate()
  expect(await late).toHaveProperty('error')
  expect(await test.processes()).toEqual(committed)
  cleanupRelease.resolve(true)
  expect(await save).toEqual({ saved: true })
  expect(await test.bridge.invokeRuntime('connectors.list', { ids: [test.draft.id] }))
    .toMatchObject([{ version: '1.0.1', configurationStatus: 'CONFIGURED' }])
})
