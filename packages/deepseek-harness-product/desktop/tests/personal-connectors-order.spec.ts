import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { PersonalConnectors } from '../src/personal-connectors.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-mcp-order-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const deleting = Promise.withResolvers<boolean>()
  const release = Promise.withResolvers<boolean>()
  const requests: string[] = []
  let deleted = false
  const entry = { id: 'owned-mcp', version: '1.0.0', name: 'Owned MCP', summary: 'Ordering fixture', category: 'other',
    visibility: 'PERSONAL', ownerEmployeeId: 'employee', canEdit: true, authMode: 'none', ready: true, status: 'ready',
    transport: 'streamable-http', url: 'https://mcp.example', tools: [{ name: 'read' }] }
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'fixture-token',
    fetch: async (url, init) => {
      const id = (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).split('/').at(-1)
      requests.push(`${init?.method ?? 'GET'} ${id}`)
      if (init?.method === 'DELETE') {
        deleting.resolve(true)
        const abort = () => { release.reject(init.signal?.reason) }
        init.signal?.addEventListener('abort', abort, { once: true })
        try {
          if (init.signal?.aborted) abort()
          await release.promise
          init.signal?.throwIfAborted()
          deleted = true
          return Response.json({ success: true, data: true })
        } finally { init.signal?.removeEventListener('abort', abort) }
      }
      return deleted && id === entry.id
        ? Response.json({ success: false, errCode: 'CONNECTOR_RELEASE_NOT_FOUND', errMessage: 'Connector was removed' }, { status: 404 })
        : Response.json({ success: true, data: { ...entry, id } })
    } })
  const manager = new PersonalConnectors(root, {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  }, () => 'employee')
  const controller = new AbortController()
  const pending: Promise<unknown>[] = []
  onTestFinished(async () => {
    release.resolve(true)
    controller.abort()
    await manager.close()
    await Promise.allSettled(pending)
    api.close()
  })
  const manage = (method: string, id = entry.id, signal = controller.signal) => {
    const result = manager.manage(`extensions.connector.${method}`, { id, version: entry.version }, api, 'employee', signal)
      .then(value => ({ value }), (error: unknown) => ({ error }))
    pending.push(result)
    return result
  }
  return { manager, api, requests, deleting: deleting.promise, release: () => { release.resolve(true) }, manage,
    deleted: () => deleted }
}

it.each(['read', 'delete'])('checks access for a queued %s after deletion commits without blocking another connector', async (method) => {
  const test = await fixture()
  const deleting = test.manage('delete')
  await test.deleting
  const queued = test.manage(method)
  expect(await test.manage('read', 'other-mcp')).toMatchObject({ value: { draft: { id: 'other-mcp' } } })
  test.release()
  expect(await deleting).toMatchObject({ value: { removed: true } })
  expect(await queued).toMatchObject({ error: { status: 404 } })
  expect(test.requests.filter(request => request === 'DELETE owned-mcp')).toHaveLength(1)
})

it('does not dispatch a cancelled queued read and permits a later operation', async () => {
  const test = await fixture()
  const deleting = test.manage('delete')
  await test.deleting
  const controller = new AbortController()
  const queued = test.manage('read', 'owned-mcp', controller.signal)
  await test.manage('read', 'other-mcp')
  const reason = new Error('Queued operation cancelled')
  controller.abort(reason)
  test.release()
  await deleting
  expect(await queued).toEqual({ error: reason })
  expect(test.requests.filter(request => request === 'GET owned-mcp')).toHaveLength(1)
  expect(await test.manage('read')).toMatchObject({ error: { status: 404 } })
})

it('cancels deletion on close, settles its queued read and refuses subsequent management requests', async () => {
  const test = await fixture()
  const deleting = test.manage('delete')
  await test.deleting
  const queued = test.manage('read')
  await test.manager.close()
  test.release()
  expect(await deleting).toHaveProperty('error')
  expect(await queued).toHaveProperty('error')
  expect(test.deleted()).toBe(false)
  expect(await test.manage('read')).toHaveProperty('error')
  expect(test.requests).toEqual(['GET owned-mcp', 'DELETE owned-mcp'])
})
