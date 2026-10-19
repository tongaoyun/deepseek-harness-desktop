import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ExtensionDraftSchema } from '@deepseek-harness/product/authoring'
import { PersonalConnectors } from '../src/personal-connectors.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-lifecycle-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
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
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'fixture-token',
    fetch: async (_url, init) => Response.json({ success: true, data: init?.method ? {} : {
      ...draft, visibility: 'PERSONAL', ownerEmployeeId: 'employee', canEdit: true,
      authMode: 'none', ready: true, status: 'ready', tools: [{ name: 'read' }],
    } }) })
  const draft = ExtensionDraftSchema.parse({ kind: 'connector', id: 'lifecycle-mcp', version: '1.0.0', name: 'Lifecycle',
    summary: 'Cancellation fixture', category: 'other', transport: 'streamable-http',
    url: `http://127.0.0.1:${address.port}/mcp` })
  await manager.save(draft, api, 'employee', new AbortController().signal)
  const entry = { ...draft, visibility: 'PERSONAL', ownerEmployeeId: 'employee',
    authMode: 'none', ready: true, status: 'ready', tools: [{ name: 'read' }] }
  return { manager, entry, api, hold: () => { hold = true },
    switchEmployee: async (value: string) => { employee = value; await manager.resetIdentity(value) },
    reads: () => configurationReads, initializations: () => initializations,
    waiting: () => pending !== undefined, disconnected: () => pending?.response.destroyed === true,
    release: () => {
      hold = false
      if (pending) { initialize(pending.response, pending.id, pending.protocolVersion); pending = undefined }
    } }
}

it.each(['first', 'second'])('cancels the %s reader without cancelling another reader of the same MCP connection', async (cancelled) => {
  const test = await fixture()
  test.hold()
  const first = new AbortController()
  const second = new AbortController()
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
