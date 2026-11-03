import { createHash } from 'node:crypto'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { ConnectorDraftSchema } from '@deepseek-harness/product/connector-draft'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { PersonalConnectors } from '../src/personal-connectors.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

it('does not overwrite a committed device configuration with a late pending recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-pending-race-'))
  const employee = 'employee'
  const child = `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const call=JSON.parse(line); if(call.id===undefined)return;
 const result=call.method==='initialize' ? {protocolVersion:call.params.protocolVersion,
  serverInfo:{name:'pending-race',version:'1'},capabilities:{tools:{}}}
  : {tools:[{name:'read',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:call.id,result})+'\\n');
});`
  const draft = ConnectorDraftSchema.parse({ kind: 'connector', id: 'pending-race', version: '1.0.0', name: 'Pending race',
    summary: 'Pending race fixture', category: 'other', transport: 'stdio', command: process.execPath,
    arguments: ['--input-type=module', '-e', child] })
  const entry = { ...draft, visibility: 'PERSONAL', ownerEmployeeId: employee, canEdit: true,
    authMode: 'none', status: 'ready', ready: true, tools: [{ name: 'read' }] }
  let uncertain = true
  const requests: string[] = []
  const request: typeof fetch = async (url) => {
    if (uncertain) throw new Error('Lost commit receipt and confirmation unavailable')
    const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname
    const id = path.split('/').at(-2)
    requests.push(path)
    return Response.json({ success: true, data: { ...entry, id } })
  }
  const manager = new PersonalConnectors(root, {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  }, () => employee)
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'fixture-token', fetch: request })
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const started = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<boolean>()
  const operations: Promise<unknown>[] = []
  onTestFinished(async () => {
    release.resolve(true)
    await Promise.allSettled(operations)
    await manager.close()
    api.close()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  await expect(manager.save(draft, api, employee, new AbortController().signal))
    .rejects.toMatchObject({ code: 'CONNECTOR_SAVE_PENDING' })
  uncertain = false
  const filename = join(root, createHash('sha256').update(JSON.stringify([employee, draft.id, draft.version])).digest('hex') + '.bin')
  let hold = true
  vi.mocked(rename).mockImplementation(async (...args) => {
    if (hold && args[1] === filename) {
      hold = false
      started.resolve(true)
      await release.promise
    }
    return actual.rename(...args)
  })
  const late = manager.enrich([entry], new AbortController().signal, false)
  operations.push(late)
  await started.promise
  const save = manager.manage('extensions.connector.configuration.save', {
    id: draft.id, version: draft.version,
    configuration: { headers: {}, environment: {}, timeoutSeconds: 30 },
  }, api, employee, new AbortController().signal)
  operations.push(save)
  expect(await manager.manage('extensions.connector.configuration.read', {
    id: 'other-mcp', version: draft.version,
  }, api, employee, new AbortController().signal)).toMatchObject({ configured: false })
  expect(requests).toEqual(['/api/v1/connectors/other-mcp/configuration-template'])
  release.resolve(true)
  await Promise.all([late, save])
  const restored = z.object({ timeoutSeconds: z.number() }).parse(JSON.parse((await actual.readFile(filename)).toString()))
  expect(restored.timeoutSeconds).toBe(30)
})
