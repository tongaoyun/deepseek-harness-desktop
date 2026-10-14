import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { buffer } from 'node:stream/consumers'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ExtensionAuthoringSnapshotSchema } from '@deepseek-harness/product/extension-draft'
import { ExtensionDraftSchema, extensionFiles } from '@deepseek-harness/product/authoring'
import { ExtensionAuthoring } from '../src/extension-authoring.ts'
import { AuthoringSessions } from '../src/authoring-sessions.ts'

const draft = { kind: 'skill' as const, id: 'fact-review', version: '1.0.0', name: 'Fact review',
  summary: 'Check facts.', category: 'knowledge-research', body: '# Review\nCheck facts.', triggers: ['Review claims'] }
const employee = { authenticated: true, employeeId: 'employee-one', displayName: 'Original author' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'authoring-recovery-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const uploads: Buffer[] = []
  const server = createServer((request, response) => { void (async () => {
    uploads.push(await buffer(request)); response.end('ok')
  })() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() })) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  const releases: unknown[] = []
  let activated = false
  let loseReceipt = false
  let rejectPreparation = false
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'private-token',
    fetch: async (url, init) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (path.endsWith('/releases')) {
        if (rejectPreparation) {
          rejectPreparation = false
          return Response.json({ success: false, errCode: 'EXPERT_KIT_RELEASE_CONFLICT', errMessage: 'Resource belongs to another owner' }, { status: 409 })
        }
        if (typeof init?.body !== 'string') throw new Error('Missing preparation body')
        const release: unknown = JSON.parse(init.body)
        if (releases.length) expect(release).toEqual(releases[0])
        releases.push(release)
        return Response.json({ success: true, data: { uploadUrl: `http://127.0.0.1:${address.port}/upload`, assessment: { status: 'READY' } } })
      }
      activated = true
      if (loseReceipt) { loseReceipt = false; throw new Error('Activation receipt lost') }
      return Response.json({ success: true, data: { activated: true } })
    } })
  const install = vi.fn(async (_id: string, _signal: AbortSignal) => undefined)
  const importedDirectory = join(root, 'import')
  await mkdir(importedDirectory)
  const options = { directory: join(root, 'drafts'), selectImport: async () => importedDirectory,
    installSkill: install, saveConnector: async () => undefined }
  let authoring = new ExtensionAuthoring(options)
  onTestFinished(() => authoring.close())
  const signal = new AbortController().signal
  const read = async () => ExtensionAuthoringSnapshotSchema.parse(await authoring.invoke('extensions.authoring.read',
    { sessionId: 'creation' }, api, employee, signal))
  const initial = ExtensionAuthoringSnapshotSchema.parse(await authoring.invoke('extensions.authoring.begin',
    { kind: 'skill', sessionId: 'creation' }, api, employee, signal))
  const coordinate = { sessionId: 'creation', authoringId: initial.authoringId }
  await authoring.invoke('extensions.authoring.update', { ...coordinate, revision: 0, draft }, api, employee, signal)
  return { api, install, uploads, releases, importedDirectory, directory: options.directory, read, coordinate, signal,
    get authoring() { return authoring }, get activated() { return activated },
    loseReceipt: () => { loseReceipt = true },
    rejectPreparation: () => { rejectPreparation = true },
    restart: async () => { await authoring.close(); authoring = new ExtensionAuthoring(options) } }
}

it('records server success before installation failure and retries only installation after restart', async () => {
  const test = await fixture()
  test.install.mockRejectedValueOnce(new Error('Host unavailable'))
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXTENSION_INSTALL_FAILED', retryable: true, resources: [{ kind: 'skill', id: draft.id }] })
  expect(test.activated).toBe(true)
  expect(await test.read()).toMatchObject({ revision: 2, saved: { id: draft.id, version: draft.version } })
  expect((await test.read()).pendingSave).toBeUndefined()
  await test.restart()
  await expect(test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 2, draft: { ...draft, body: 'Changed' } }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXTENSION_VERSION_CONFLICT' })
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 2 }, test.api, employee, test.signal))
    .resolves.toMatchObject({ installed: true })
  expect(test.install).toHaveBeenCalledTimes(2)
  expect(test.releases).toHaveLength(1)
  expect(test.uploads).toHaveLength(1)
  expect(JSON.stringify(await test.read())).not.toContain('private-token')
})

it('keeps a definitely rejected first preparation editable without marking it saved', async () => {
  const test = await fixture()
  test.rejectPreparation()
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXPERT_KIT_RELEASE_CONFLICT' })
  expect(test.activated).toBe(false)
  expect((await test.read()).pendingSave).toBeUndefined()
  await expect(test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 1, draft: { ...draft, id: 'another-review' } }, test.api, employee, test.signal))
    .resolves.toMatchObject({ revision: 2, draft: { id: 'another-review' } })
  expect(test.install).not.toHaveBeenCalled()
  expect(test.uploads).toEqual([])
})

it('seals an uncertain activation and retries identical release bytes across restart and display-name changes', async () => {
  const test = await fixture()
  test.loseReceipt()
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toThrow('receipt lost')
  expect(test.activated).toBe(true)
  expect(test.install).not.toHaveBeenCalled()
  await test.restart()
  expect(await test.read()).toMatchObject({ revision: 1, pendingSave: { author: employee.displayName } })
  await expect(test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 1, draft: { ...draft, body: 'Changed' } }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXTENSION_SAVE_PENDING' })
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api,
    { ...employee, displayName: 'Changed author' }, test.signal)).resolves.toMatchObject({ installed: true })
  expect(test.releases).toHaveLength(2)
  expect(test.uploads[1]).toEqual(test.uploads[0])
  expect(await test.read()).toMatchObject({ revision: 2, saved: { id: draft.id } })
})

it.each(['cancel', 'disk-failure'])('keeps committed content recoverable when %s follows activation', async (failure) => {
  const test = await fixture()
  const controller = new AbortController()
  const store = new AuthoringSessions(test.directory)
  const write = store.write.bind(store)
  const fault = vi.spyOn(AuthoringSessions.prototype, 'write').mockImplementation(async function (this: AuthoringSessions, owner, snapshot, signal) {
    if (snapshot.saved) {
      if (failure === 'disk-failure') throw new Error('Receipt disk unavailable')
      controller.abort(new Error('User cancelled'))
    }
    return write(owner, snapshot, signal)
  })
  onTestFinished(() => { fault.mockRestore() })
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, controller.signal))
    .rejects.toThrow(failure === 'cancel' ? 'User cancelled' : 'Receipt disk unavailable')
  fault.mockRestore()
  expect(test.activated).toBe(true)
  expect(test.install).not.toHaveBeenCalled()
  await test.restart()
  const state = await test.read()
  expect(state.revision).toBe(failure === 'cancel' ? 2 : 1)
  expect(Boolean(state.saved)).toBe(failure === 'cancel')
  expect(Boolean(state.pendingSave)).toBe(failure === 'disk-failure')
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: state.revision }, test.api, employee, test.signal))
    .resolves.toMatchObject({ installed: true })
  expect(test.releases).toHaveLength(failure === 'cancel' ? 1 : 2)
  expect(test.uploads.at(-1)).toEqual(test.uploads[0])
})

it('retains a saved import after failed installation and denies changed content or a different owner', async () => {
  const test = await fixture()
  await writeFile(join(test.importedDirectory, 'SKILL.md'), extensionFiles(ExtensionDraftSchema.parse(draft)).files['SKILL.md']!)
  const imported = await test.authoring.invoke('extensions.import.inspect', { kind: 'skill', source: 'directory' }, test.api, employee, test.signal) as { stageId: string }
  const content = ExtensionDraftSchema.parse({ ...draft, stageId: imported.stageId })
  test.install.mockRejectedValueOnce(new Error('Installation unavailable'))
  await expect(test.authoring.invoke('extensions.save', content, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXTENSION_INSTALL_FAILED' })
  await expect(test.authoring.invoke('extensions.save', { ...content, body: 'Changed' }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXTENSION_VERSION_CONFLICT' })
  await expect(test.authoring.invoke('extensions.save', content, test.api, employee, test.signal)).resolves.toMatchObject({ installed: true })
  expect(test.releases).toHaveLength(1)
  expect(test.uploads).toHaveLength(1)
  await expect(test.authoring.invoke('extensions.save', content, test.api, { authenticated: true, employeeId: 'employee-two' }, test.signal))
    .rejects.toThrow('expired')
})
