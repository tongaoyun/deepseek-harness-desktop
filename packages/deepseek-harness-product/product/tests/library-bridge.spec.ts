import { expect, it, onTestFinished } from 'vitest'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'
import { DeepSeekHarnessProductBridge } from '../src/bridge.ts'
import { invokeLibrary } from '../src/library-bridge.ts'
const libraryId = '11111111-1111-4111-8111-111111111111'
const entryId = '22222222-2222-4222-8222-222222222222'
const timestamp = '2026-11-13T01:00:00Z'
const folder = { id: entryId, libraryId, name: '资料', parentId: null, kind: 'FOLDER', sha256: null, mediaType: null,
  sizeBytes: 0, favorite: false, version: 1, createdAt: timestamp, updatedAt: timestamp }
function fixture(data: unknown) {
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => 'token',
    fetch: async () => Response.json(typeof data === 'object' && data !== null && 'pageIndex' in data ? { success: true, ...data } : { success: true, data }) })
  onTestFinished(() => { api.close() })
  return (method: string, input: Readonly<Record<string, unknown>>) => invokeLibrary(api, method, input, new AbortController().signal)
}
it('accepts exact file identity without exposing storage metadata', async () => {
  const invoke = fixture({ ...folder, objectKey: 'private' })
  await expect(invoke('library.entries.get', { libraryId, entryId })).resolves.toEqual(folder)
})
it.each([{ libraryId: entryId }, { id: libraryId }, { mediaType: 'text/plain' }])('rejects a mismatched or malformed folder reply %j', async (change) => {
  const invoke = fixture({ ...folder, ...change })
  await expect(invoke('library.entries.get', { libraryId, entryId })).rejects.toThrow()
})
it('does not accept a successful mutation receipt for another directory or revision', async () => {
  const invoke = fixture({ ...folder, version: 2 })
  await expect(invoke('library.entries.update', { libraryId, entryId, name: folder.name, parentId: entryId, version: 1 })).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
  await expect(invoke('library.entries.update', { libraryId, entryId, name: folder.name, parentId: null, version: 2 })).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
})
it('requires explicit boolean acknowledgement before reporting deletion or a favorite change', async () => {
  const invoke = fixture({ done: true })
  await expect(invoke('library.entries.delete', { libraryId, entryId, version: 1 })).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
  await expect(invoke('library.entries.favorite', { libraryId, entryId, value: false })).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
})
it('rejects renderer paths and URLs instead of forwarding them to the server', async () => {
  const invoke = fixture(folder)
  await expect(invoke('library.entries.get', { libraryId, entryId, path: '/private/file' })).rejects.toThrow()
})

it('validates global file pages and rejects unrecognized ordering or duplicate identities', async () => {
  const file = { ...folder, kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/plain', sizeBytes: 3 }
  const row = { entry: file, libraryName: '团队资料', canManage: false, lastAccessedAt: timestamp, sourceKind: 'UPLOAD', sourceSessionId: null }
  const page = { data: [row], pageIndex: 2, pageSize: 20, totalCount: 21, totalPages: 2 }
  await expect(fixture(page)('library.files.list', { view: 'mine', category: 'document', sort: 'size', direction: 'desc', page: 2 })).resolves.toEqual(page)
  await expect(fixture(page)('library.files.list', { sort: 'size desc; drop table' })).rejects.toThrow()
  await expect(fixture({ ...page, data: [row, row] })('library.files.list', { page: 2 })).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
  await expect(fixture(page)('library.files.list', { page: 2, view: 'favorites' })).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
})
it('requires explicit acknowledgement for employee access records', async () => {
  await expect(fixture(true)('library.entries.access', { libraryId, entryId })).resolves.toBe(true)
  await expect(fixture(null)('library.entries.access', { libraryId, entryId })).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' })
})

it('routes global files through the authenticated metadata bridge without a native byte transport', async () => {
  const paths: string[] = []
  const bridge = new DeepSeekHarnessProductBridge({
    serverUrl: 'https://product.test', sessionToken: 'employee-session',
    initialSession: { authenticated: true, employeeId: 'employee' },
    fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      paths.push(url.pathname)
      return Response.json({ success: true, data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 })
    },
  })
  onTestFinished(() => bridge.dispose())
  await expect(bridge.invoke('library.files.list', { view: 'mine', category: 'html' })).resolves.toMatchObject({ data: [] })
  expect(paths).toEqual(['/api/v1/library-files'])
})
