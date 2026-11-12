import { createServer, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { PersonalConnectors } from '../src/personal-connectors.ts'
import { savedConnectorResponse } from './connector-receipt-fixture.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm), writeFile: vi.fn(actual.writeFile) }
})
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(rm).mockReset().mockImplementation(actual.rm)
  vi.mocked(writeFile).mockReset().mockImplementation(actual.writeFile)
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-lifecycle-'))
  onTestFinished(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    await actual.rm(root, { recursive: true, force: true })
  })
  let pending: { response: ServerResponse; id: number; protocolVersion: string } | undefined
  let hold = false
  let initializations = 0
  const initialize = (response: ServerResponse, id: number, protocolVersion: string): void => {
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result: {
      protocolVersion, serverInfo: { name: 'lifecycle-fixture', version: '1' }, capabilities: { tools: {} },
    } }))
  }
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const call = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number
        method: string
        params: { protocolVersion: string }
      }
      if (call.id === undefined) { response.writeHead(202).end(); return }
      response.setHeader('content-type', 'application/json')
      if (call.method === 'initialize') {
        initializations += 1
        if (hold) { pending = { response, id: call.id, protocolVersion: call.params.protocolVersion }; return }
        initialize(response, call.id, call.params.protocolVersion)
      } else {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
          tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
        } }))
      }
    })().catch(() => { response.writeHead(500).end() })
  })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  let configurationReads = 0
  let employee = 'employee'
  const manager = new PersonalConnectors(root, {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value),
    decryptString: (value) => { configurationReads += 1; return value.toString() },
  }, () => employee)
  onTestFinished(() => manager.close())
  let version = '1.0.0'
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'fixture-token',
    fetch: async (url, init) => {
      if (init?.method === 'POST' && typeof init.body === 'string') {
        const saved: unknown = JSON.parse(init.body)
        if (typeof saved !== 'object' || saved === null || !('version' in saved) || typeof saved.version !== 'string') {
          throw new Error('Expected a saved connector version')
        }
        version = saved.version
      }
      const id = (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).split('/').at(-1)
      if (init?.method === 'DELETE') return Response.json({ success: true, data: true })
      if (init?.method === 'POST') return savedConnectorResponse(init, 'employee')
      return Response.json({ success: true, data: {
        ...draft, id, version: id === draft.id ? version : draft.version,
        visibility: 'PERSONAL', ownerEmployeeId: 'employee', canEdit: true,
        authMode: 'none', ready: true, status: 'ready', tools: [{ name: 'read' }],
      } })
    } })
  onTestFinished(() => { api.close() })
  const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'lifecycle-mcp', version: '1.0.0', name: 'Lifecycle',
    summary: 'Cancellation fixture', category: 'other', transport: 'streamable-http',
    url: `http://127.0.0.1:${address.port}/mcp` })
  await manager.save(draft, api, 'employee', new AbortController().signal)
  const entry = { ...draft, visibility: 'PERSONAL', ownerEmployeeId: 'employee',
    authMode: 'none', ready: true, status: 'ready', tools: [{ name: 'read' }] }
  return { manager, entry, draft, api, root, hold: () => { hold = true },
    switchEmployee: async (value: string) => { employee = value; await manager.resetIdentity(value) },
    reads: () => configurationReads, initializations: () => initializations,
    waiting: () => pending !== undefined, disconnected: () => pending?.response.destroyed === true,
    release: () => {
      hold = false
      if (pending) { initialize(pending.response, pending.id, pending.protocolVersion); pending = undefined }
    } }
}

it.each(['read', 'update', 'delete'])('rechecks the version for a queued %s after an in-flight save commits', async (method) => {
  const test = await fixture()
  const controller = new AbortController()
  const pending: Promise<unknown>[] = []
  onTestFinished(async () => { controller.abort(); test.release(); await Promise.allSettled(pending) })
  test.hold()
  const save = test.manager.save({ ...test.draft, version: '1.0.1' }, test.api, 'employee', controller.signal)
    .then(() => ({ saved: true }), (error: unknown) => ({ error }))
  pending.push(save)
  await expect.poll(test.waiting).toBe(true)
  const queued = test.manager.manage(`extensions.connector.${method}`, {
    id: test.entry.id, version: '1.0.0', draft: { ...test.draft, version: '1.0.1', name: 'Queued edit' },
  }, test.api, 'employee', controller.signal).then(value => ({ value }), (error: unknown) => ({ error }))
  pending.push(queued)
  expect(await test.manager.manage('extensions.connector.read', { id: 'other-mcp', version: '1.0.0' },
    test.api, 'employee', controller.signal)).toMatchObject({ draft: { id: 'other-mcp' } })
  test.release()
  expect(await save).toEqual({ saved: true })
  expect(await queued).toMatchObject({ error: { code: 'EXTENSION_VERSION_CONFLICT' } })
})

it.each(['first', 'second'])('cancels the %s reader without cancelling another reader of the same MCP connection', async (cancelled) => {
  const test = await fixture()
  test.hold()
  const first = new AbortController()
  const second = new AbortController()
  first.signal.addEventListener('abort', (event) => { event.stopImmediatePropagation() })
  second.signal.addEventListener('abort', (event) => { event.stopImmediatePropagation() })
  const firstResult = test.manager.enrich([test.entry], first.signal).then(value => ({ value }), (error: unknown) => ({ error }))
  await expect.poll(test.waiting).toBe(true)
  const secondResult = test.manager.enrich([test.entry], second.signal).then(value => ({ value }), (error: unknown) => ({ error }))
  await expect.poll(test.reads).toBe(2)
  const reason = new Error('Only this reader cancelled')
  const cancelledController = cancelled === 'first' ? first : second
  cancelledController.abort(reason)
  const cancelledResult = cancelled === 'first' ? firstResult : secondResult
  const liveResult = cancelled === 'first' ? secondResult : firstResult
  expect(await cancelledResult).toEqual({ error: reason })
  test.release()
  expect(await liveResult).toMatchObject({ value: [{ ready: true, tools: [{ name: 'read', access: 'READ' }] }] })
  expect(test.initializations()).toBe(2)
  expect(await test.manager.enrich([test.entry])).toMatchObject([{ ready: true }])
  expect(test.initializations()).toBe(2)
})

it('aborts an unneeded MCP handshake when its last reader cancels and permits a fresh connection', async () => {
  const test = await fixture()
  test.hold()
  const controller = new AbortController()
  const result = test.manager.enrich([test.entry], controller.signal).catch((error: unknown) => error)
  await expect.poll(test.waiting).toBe(true)
  const reason = new Error('No remaining reader')
  controller.abort(reason)
  expect(await result).toBe(reason)
  await expect.poll(test.disconnected).toBe(true)
  test.release()
  expect(await test.manager.enrich([test.entry])).toMatchObject([{ ready: true }])
  expect(test.initializations()).toBe(3)
})

it.each([true, false])('closes a shared in-flight MCP handshake with external signal %s and prevents reconnecting', async (externalSignal) => {
  const test = await fixture()
  test.hold()
  const signal = externalSignal ? new AbortController().signal : undefined
  const first = test.manager.enrich([test.entry], signal).catch((error: unknown) => error)
  const second = test.manager.enrich([test.entry], signal).catch((error: unknown) => error)
  await expect.poll(test.reads).toBe(2)
  await expect.poll(test.waiting).toBe(true)
  await test.manager.close()
  expect(await first).toBeInstanceOf(Error)
  expect(await second).toBeInstanceOf(Error)
  await expect.poll(test.disconnected).toBe(true)
  await expect(test.manager.enrich([test.entry])).rejects.toThrow()
  expect(test.initializations()).toBe(2)
})

it('deletes a connector without waiting for its stalled MCP handshake to time out', async () => {
  const test = await fixture()
  test.hold()
  const discovery = test.manager.enrich([test.entry])
  onTestFinished(async () => { await test.manager.close(); await discovery })
  await expect.poll(test.waiting).toBe(true)
  expect(await test.manager.manage('extensions.connector.delete', { id: test.entry.id, version: test.entry.version },
    test.api, 'employee', new AbortController().signal)).toMatchObject({ removed: true })
  await expect.poll(test.disconnected).toBe(true)
  expect(await discovery).toMatchObject([{ ready: false, tools: [] }])
})

it('releases a previous employee handshake before allowing a new connection', async () => {
  const test = await fixture()
  test.hold()
  const discovery = test.manager.enrich([test.entry])
  onTestFinished(async () => { await test.manager.close(); await discovery })
  await expect.poll(test.waiting).toBe(true)
  await test.switchEmployee('employee-two')
  await expect.poll(test.disconnected).toBe(true)
  expect(await discovery).toMatchObject([{ ready: false, tools: [] }])
  test.release()
  expect(await test.manager.enrich([{ ...test.entry, ownerEmployeeId: 'employee-two' }]))
    .toMatchObject([{ ready: false, configurationStatus: 'REQUIRED' }])
  expect(test.initializations()).toBe(2)
  await test.switchEmployee('employee')
  expect(await test.manager.enrich([test.entry])).toMatchObject([{ ready: true }])
  expect(test.initializations()).toBe(3)
})

it('commits encrypted pending and final settings without deleting temporary paths already moved into place', async () => {
  const test = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(rm).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.tmp')) throw new Error('Temporary path deletion unavailable')
    return actual.rm(...args)
  })
  const draft = { ...test.draft, version: '1.0.1', timeoutSeconds: 30 }
  await test.manager.save(draft, test.api, 'employee', new AbortController().signal)
  expect(await test.manager.enrich([{ ...test.entry, version: draft.version }], undefined, false))
    .toMatchObject([{ configurationStatus: 'CONFIGURED', timeoutSeconds: 30 }])
  const files = await actual.readdir(test.root)
  expect(files.filter(name => name.endsWith('.bin'))).toHaveLength(2)
  expect(files.some(name => name.endsWith('.tmp') || name.endsWith('.pending'))).toBe(false)
})

it.each(['write', 'rename'] as const)('preserves the original %s failure when encrypted staging cleanup also fails', async (failure) => {
  const test = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const cause = new Error('Encrypted settings could not be committed')
  const cleanup = new Error('Encrypted temporary file could not be removed')
  if (failure === 'write') vi.mocked(writeFile).mockRejectedValueOnce(cause)
  else vi.mocked(rename).mockRejectedValueOnce(cause)
  vi.mocked(rm).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.tmp')) throw cleanup
    return actual.rm(...args)
  })
  const saved = test.manager.save({ ...test.draft, version: '1.0.1' }, test.api, 'employee', new AbortController().signal)
  await expect(saved).rejects.toMatchObject({ cause, errors: [cause, cleanup] })
  expect(await test.manager.enrich([test.entry], undefined, false)).toMatchObject([{ configurationStatus: 'CONFIGURED' }])
  expect(await test.manager.manage('extensions.connector.read', { id: test.entry.id, version: '1.0.0' },
    test.api, 'employee', new AbortController().signal)).toMatchObject({ draft: { version: '1.0.1' } })
})

it('retains confirmed server settings for recovery after both finalization and staging cleanup fail', async () => {
  const test = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const cause = new Error('Final configuration replacement unavailable')
  const cleanup = new Error('Encrypted temporary file could not be removed')
  const filename = join(test.root, createHash('sha256').update(JSON.stringify(['employee', test.draft.id, '1.0.1'])).digest('hex') + '.bin')
  vi.mocked(rename).mockImplementation(async (...args) => {
    if (args[1] === filename) throw cause
    return actual.rename(...args)
  })
  vi.mocked(rm).mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.tmp')) throw cleanup
    return actual.rm(...args)
  })
  await expect(test.manager.save({ ...test.draft, version: '1.0.1', timeoutSeconds: 30 }, test.api, 'employee', new AbortController().signal))
    .rejects.toMatchObject({ code: 'CONNECTOR_SAVE_PENDING', cause: { cause, errors: [cause, cleanup] } })
  expect((await actual.stat(`${filename}.pending`)).isFile()).toBe(true)
  await expect(actual.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' })
  vi.mocked(rename).mockImplementation(actual.rename)
  vi.mocked(rm).mockImplementation(actual.rm)
  expect(await test.manager.enrich([{ ...test.entry, version: '1.0.1' }], undefined, false))
    .toMatchObject([{ configurationStatus: 'CONFIGURED', timeoutSeconds: 30 }])
  await expect(actual.stat(`${filename}.pending`)).rejects.toMatchObject({ code: 'ENOENT' })
})
