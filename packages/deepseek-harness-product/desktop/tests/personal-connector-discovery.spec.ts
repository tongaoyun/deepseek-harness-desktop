import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '@modelcontextprotocol/client'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PersonalConnectors } from '../src/personal-connectors.ts'

interface ToolPage { tools: Tool[]; nextCursor?: string; ttlMs?: number }
const tool = (name: string, readOnlyHint = true): Tool => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint } })

async function fixture(page: (cursor?: string) => ToolPage | Promise<ToolPage>) {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-discovery-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const cursors: (string | undefined)[] = []
  const methods: string[] = []
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const call = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number
      method: string
      params?: { protocolVersion?: string; cursor?: string }
    }
    methods.push(call.method)
    if (call.id === undefined) { response.writeHead(202).end(); return }
    const result = call.method === 'initialize'
      ? { protocolVersion: call.params?.protocolVersion, serverInfo: { name: 'discovery', version: '1' }, capabilities: { tools: {} } }
      : (cursors.push(call.params?.cursor), await page(call.params?.cursor))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
  })().catch(() => { response.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()) }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const secure = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString() }
  const manager = new PersonalConnectors(root, secure, () => 'employee')
  onTestFinished(() => manager.close())
  const upload = vi.fn<typeof fetch>(async () => Response.json({ success: true, data: {} }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-token', fetch: upload })
  const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'discovery-mcp', version: '1.0.0', name: 'Discovery',
    summary: 'Discovery fixture', category: 'other', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp` })
  const save = (signal = new AbortController().signal) => manager.save(draft, api, 'employee', signal)
  return { root, cursors, methods, manager, upload, draft, save }
}

it('refreshes live annotations on the same connection even when the server advertises a fresh cache', async () => {
  let readOnly = true
  const f = await fixture(() => ({ tools: [tool('orders', readOnly)], ttlMs: 60_000 }))
  await f.save()
  const entry = { id: f.draft.id, version: f.draft.version, transport: f.draft.transport, url: f.draft.url,
    ownerEmployeeId: 'employee', visibility: 'PERSONAL', authMode: 'none', status: 'ready', ready: true, tools: [{ name: 'orders' }] }
  expect(await f.manager.enrich([entry])).toMatchObject([{ tools: [{ name: 'orders', access: 'READ' }] }])
  readOnly = false
  expect(await f.manager.enrich([entry])).toMatchObject([{ tools: [{ name: 'orders', access: 'WRITE' }] }])
  expect(f.methods.filter(method => method === 'initialize')).toHaveLength(2)
  expect(f.cursors).toHaveLength(3)
  expect(f.methods).not.toContain('tools/call')
})

it('saves the complete SDK-aggregated tool list including pages after an empty first page', async () => {
  const f = await fixture(cursor => cursor === undefined ? { tools: [], nextCursor: 'second' } : { tools: [tool('orders')] })
  await f.save()
  expect(f.cursors).toEqual([undefined, 'second'])
  expect(f.upload).toHaveBeenCalledTimes(1)
  expect(f.upload.mock.calls[0]?.[1]?.body).toContain('"toolNames":["orders"]')
  expect(f.methods).not.toContain('tools/call')
})

it.each(['tools', 'pages'] as const)('rejects excessive %s without saving configuration or posting a catalog entry', async (limit) => {
  const f = await fixture(cursor => limit === 'tools'
    ? { tools: Array.from({ length: 513 }, (_, index) => tool(`tool_${index}`)) }
    : { tools: [], nextCursor: String(Number(cursor ?? 0) + 1) })
  await expect(f.save()).rejects.toThrow(limit === 'tools' ? 'MCP tool limit exceeded' : 'listMaxPages')
  expect(f.cursors).toHaveLength(limit === 'tools' ? 1 : 64)
  expect(f.upload).not.toHaveBeenCalled()
  expect(await readdir(f.root)).toEqual([])
})
