import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { buffer } from 'node:stream/consumers'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ExtensionDraftSchema, extensionFiles } from '@deepseek-harness/product/authoring'
import { ExtensionAuthoring } from '../src/extension-authoring.ts'
import { readExtensionMarkdown, readExtensionTar } from '../src/extension-archives.ts'
import { c as createTar } from 'tar'

const skill = { kind: 'skill', id: 'my-review', version: '1.0.0', name: 'My review', summary: 'Review facts.',
  category: 'legal', body: 'Review the facts first.', triggers: ['Review a document'] } as const
const identity = { authenticated: true, employeeId: 'employee-one' }

it.each(['skill', 'expert-kit'])('deletes %s through authenticated main transport without changing local authoring or installations', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'extension-delete-test-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: true, data: true }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-secret', fetch })
  const install = vi.fn(async () => undefined)
  const authoring = new ExtensionAuthoring({ directory: root, selectImport: async () => undefined,
    installSkill: install, saveConnector: async () => undefined })
  onTestFinished(() => authoring.close())
  const signal = new AbortController().signal
  await expect(authoring.invoke('extensions.delete', { kind, id: 'my-extension', version: '1.0.0' }, api, identity, signal))
    .resolves.toEqual({ removed: true, id: 'my-extension' })
  expect(fetch.mock.calls).toHaveLength(1)
  expect(fetch.mock.calls[0]?.[0]).toBe(`https://product.example/api/v1/extension-submissions/${kind}/my-extension?version=1.0.0`)
  expect(fetch.mock.calls[0]?.[1]?.method).toBe('DELETE')
  expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  expect(install).not.toHaveBeenCalled()
  await expect(authoring.invoke('extensions.delete', { kind, id: '../another', version: '1.0.0' }, api, identity, signal)).rejects.toThrow('coordinate')
  await expect(authoring.invoke('extensions.delete', { kind, id: 'my-extension', version: '1.0.0' }, api, { authenticated: false }, signal)).rejects.toThrow('Authenticated')
  await expect(authoring.invoke('extensions.delete', { kind, id: 'my-extension', version: '1.0.0' }, api, identity, AbortSignal.abort())).rejects.toThrow()
})

it('accepts standalone SKILL.md and rejects links, other filenames and oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-markdown-test-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const path = join(root, 'SKILL.md')
  await writeFile(path, extensionFiles(ExtensionDraftSchema.parse(skill)).files['SKILL.md']!)
  const signal = new AbortController().signal
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => undefined })
  const authoring = new ExtensionAuthoring({ directory: join(root, 'conversations'), selectImport: async () => path, installSkill: async () => undefined, saveConnector: async () => undefined })
  onTestFinished(() => authoring.close())
  expect(await authoring.invoke('extensions.import.inspect', { kind: 'skill', source: 'file' }, api, identity, signal))
    .toMatchObject({ draft: { id: skill.id, body: skill.body }, files: [{ path: 'SKILL.md' }] })
  await expect(readExtensionMarkdown(join(root, 'OTHER.md'), signal)).rejects.toThrow('standard SKILL.md')
  const links = join(root, 'linked'); await mkdir(links); await symlink(path, join(links, 'SKILL.md'))
  await expect(readExtensionMarkdown(join(links, 'SKILL.md'), signal)).rejects.toThrow('Invalid')
  await writeFile(path, 'x'.repeat(65_537))
  await expect(readExtensionMarkdown(path, signal)).rejects.toThrow('oversized')
  await expect(readExtensionMarkdown(path, AbortSignal.abort())).rejects.toThrow()
})

it('previews missing metadata, retains failed imports, uploads fixed content, and installs after activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-authoring-test-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, 'SKILL.md'), extensionFiles(ExtensionDraftSchema.parse(skill)).files['SKILL.md']!)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'assets/example.txt'), 'fixed resource')
  const archives: Buffer[] = []
  const server = createServer((request, response) => { void (async () => {
    archives.push(await buffer(request)); response.end('ok')
  })() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() =>{  resolve() })) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('No fixture port')
  let fail = true
  const requests: { path: string; body: unknown }[] = []
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-secret', fetch: vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    requests.push({ path, body })
    if (fail) throw new Error('network failure')
    return Response.json({ success: true, data: path.endsWith('/releases')
      ? { uploadUrl: `http://127.0.0.1:${address.port}/upload`, assessment: { status: 'READY' } } : { activated: true } })
  }) })
  const install = vi.fn(async () => undefined)
  const authoring = new ExtensionAuthoring({ directory: join(root, 'conversations'), selectImport: async () => root, installSkill: install, saveConnector: async () => undefined })
  onTestFinished(() => authoring.close())
  const signal = new AbortController().signal
  const preview = await authoring.invoke('extensions.import.inspect', { kind: 'skill', source: 'directory' }, api, identity, signal) as { stageId: string; missingFields: string[] }
  expect(preview.missingFields).toContain('name')
  const draft = ExtensionDraftSchema.parse({ ...skill, stageId: preview.stageId })
  await expect(authoring.invoke('extensions.save', draft, api, identity, signal)).rejects.toThrow('network')
  expect(install).not.toHaveBeenCalled()
  fail = false
  await expect(authoring.invoke('extensions.save', draft, api, identity, signal)).resolves.toMatchObject({ installed: true, visibility: 'PERSONAL' })
  expect(install).toHaveBeenCalledExactlyOnceWith(skill.id, signal)
  const uploaded = archives[0]!
  expect(requests.at(-2)?.body).toMatchObject({ author: identity.employeeId,
    sha256: createHash('sha256').update(uploaded).digest('hex'), skillIds: [skill.id] })
  expect((await readExtensionTar(uploaded, signal)).get('assets/example.txt')?.toString()).toBe('fixed resource')
  expect(JSON.stringify(requests)).not.toContain('employee-secret')
  await expect(authoring.invoke('extensions.save', draft, api, identity, signal)).rejects.toThrow('expired')
})

it('does not save cancelled imports and denies stages from another employee', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-cancel-test-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => undefined })
  const authoring = new ExtensionAuthoring({ directory: join(root, 'conversations'), selectImport: async () => undefined, installSkill: async () => undefined, saveConnector: async () => undefined })
  const signal = new AbortController().signal
  expect(await authoring.invoke('extensions.import.inspect', { kind: 'skill', source: 'zip' }, api, identity, signal)).toEqual({ cancelled: true })
  await expect(authoring.invoke('extensions.save', ExtensionDraftSchema.parse({ ...skill, stageId: '00000000-0000-4000-8000-000000000000' }), api,
    { authenticated: true, employeeId: 'employee-two' }, signal)).rejects.toThrow('expired')
})

it('copies the selected immutable skill version and resources even after the directory changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-version-test-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const content = join(root, 'content')
  await mkdir(join(content, 'assets'), { recursive: true })
  const source = extensionFiles(ExtensionDraftSchema.parse(skill))
  for (const [path, text] of Object.entries(source.files)) {
    await mkdir(join(content, path, '..'), { recursive: true })
    await writeFile(join(content, path), text)
  }
  await writeFile(join(content, 'assets/fixed.txt'), 'original version resource')
  const archive = join(root, 'source.tgz')
  await createTar({ cwd: content, file: archive, gzip: true }, ['SKILL.md', '.deepseek-harness-skill/skill.json', 'assets/fixed.txt'])
  const bytes = await readFile(archive)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let uploaded: Buffer | undefined
  const server = createServer((request, response) => { void (async () => {
    if (request.method === 'GET') { response.end(bytes); return }
    uploaded = await buffer(request); response.end('ok')
  })() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() =>{  resolve() })) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Missing port')
  const paths: string[] = []
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-secret',
    fetch: async (url) => {
      const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname; paths.push(path)
      return Response.json({ success: true, data: path.endsWith('/artifacts')
        ? { version: skill.version, sha256, downloadUrl: `http://127.0.0.1:${address.port}/source` }
        : { uploadUrl: `http://127.0.0.1:${address.port}/upload`, assessment: { status: 'READY' } } })
    } })
  const authoring = new ExtensionAuthoring({ directory: join(root, 'conversations'), selectImport: async () => undefined, installSkill: async () => undefined, saveConnector: async () => undefined })
  const draft = ExtensionDraftSchema.parse({ ...skill, kind: 'expert-kit', id: 'my-kit', body: '# Guide', skills: [{
    id: skill.id, name: skill.name, summary: skill.summary, body: 'placeholder', source: { id: skill.id, version: skill.version, sha256 },
  }] })
  const signal = new AbortController().signal
  const { ExtensionAuthoringSnapshotSchema, ExtensionContentDraftSchema } = await import('@deepseek-harness/product/extension-draft')
  const initial = ExtensionAuthoringSnapshotSchema.parse(await authoring.invoke('extensions.authoring.begin',
    { kind: 'expert-kit', sessionId: 'kit-authoring' }, api, identity, signal))
  const coordinate = { sessionId: initial.sessionId, authoringId: initial.authoringId }
  const contentDraft = Object.fromEntries(Object.entries(draft).filter(([key]) => Object.hasOwn(ExtensionContentDraftSchema.shape, key)))
  const preview = ExtensionAuthoringSnapshotSchema.parse(await authoring.invoke('extensions.authoring.update',
    { ...coordinate, revision: 0, draft: contentDraft }, api, identity, signal))
  expect(preview.draft.skills?.[0]?.body).toBe(skill.body)
  expect(preview.draft.skills?.[0]?.triggers).toEqual(skill.triggers)
  expect(preview.draft.skills?.[0]?.source).toEqual({ id: skill.id, version: skill.version, sha256 })
  await authoring.invoke('extensions.authoring.save', { ...coordinate, revision: preview.revision }, api, identity, signal)
  expect(paths[0]).toBe(`/api/v1/skills/${skill.id}/versions/1.0.0/artifacts`)
  const files = await readExtensionTar(uploaded!, new AbortController().signal)
  expect(files.get(`skills/${skill.id}/assets/fixed.txt`)?.toString()).toBe('original version resource')
  expect(files.get(`skills/${skill.id}/SKILL.md`)?.toString()).toContain(skill.body)
  expect(files.get(`skills/${skill.id}/SKILL.md`)?.toString()).not.toContain('placeholder')
})
