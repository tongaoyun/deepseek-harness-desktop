import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import { ExtensionAuthoringSnapshotSchema } from '@deepseek-harness/product/extension-draft'
import { ExtensionAuthoring } from '../src/extension-authoring.ts'
import { AuthoringSessions } from '../src/authoring-sessions.ts'

it('keeps imported resources and conversation revisions through restart, employee changes, conflicts and failed saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-authoring-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const content = join(root, 'import')
  await mkdir(join(content, 'assets'), { recursive: true })
  await writeFile(join(content, 'SKILL.md'), '---\nname: fact-review\ndescription: Review facts\n---\nCheck the evidence.\n')
  await writeFile(join(content, 'assets/example.txt'), 'fixed imported resource')
  const options = { directory: join(root, 'drafts'), selectImport: async () => content,
    installSkill: vi.fn(async () => undefined), saveConnector: vi.fn(async () => undefined) }
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'employee-secret',
    fetch: vi.fn(async () => { throw new Error('offline') }) })
  const signal = new AbortController().signal
  const employee = { authenticated: true, employeeId: 'employee-one' }
  let authoring = new ExtensionAuthoring(options)
  const imported = await authoring.invoke('extensions.import.inspect', { kind: 'skill', source: 'directory' }, api, employee, signal) as { stageId: string }
  const initial = ExtensionAuthoringSnapshotSchema.parse(await authoring.invoke('extensions.authoring.begin', {
    kind: 'skill', sessionId: 'creation', stageId: imported.stageId, edit: true,
  }, api, employee, signal))
  await authoring.invoke('extensions.import.release', { stageId: imported.stageId }, api, employee, signal)
  await authoring.close()
  authoring = new ExtensionAuthoring(options)
  onTestFinished(() => authoring.close())
  const read = () => authoring.invoke('extensions.authoring.read', { sessionId: 'creation' }, api, employee, signal)
  expect(await read()).toEqual(initial)
  expect(await authoring.invoke('extensions.authoring.read', { sessionId: 'creation' }, api,
    { authenticated: true, employeeId: 'employee-two' }, signal)).toBeNull()
  const coordinate = { sessionId: 'creation', authoringId: initial.authoringId, revision: 0 }
  const draft = { ...initial.draft, name: 'Fact review', summary: 'Review evidence', triggers: ['Review facts'], body: '# Keep facts' }
  const updates = await Promise.allSettled([draft, { ...draft, body: '# Other update' }].map(value =>
    authoring.invoke('extensions.authoring.update', { ...coordinate, draft: value }, api, employee, signal)))
  expect(updates.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
  const current = ExtensionAuthoringSnapshotSchema.parse(await read())
  expect(current.revision).toBe(1)
  expect(current.draft.body).toBe('# Keep facts')
  await expect(authoring.invoke('extensions.authoring.save', coordinate, api, employee, signal)).rejects.toMatchObject({ code: 'EXTENSION_DRAFT_CHANGED' })
  await expect(authoring.invoke('extensions.authoring.update', { ...coordinate, revision: 1, draft: { ...draft, id: 'other-resource' } }, api, employee, signal)).rejects.toThrow('identity')
  await expect(authoring.invoke('extensions.authoring.update', { ...coordinate, revision: 1, draft: { ...draft, headers: { TOKEN: 'private' } } }, api, employee, signal)).rejects.toThrow()
  await expect(authoring.invoke('extensions.authoring.save', { ...coordinate, revision: 1 }, api, employee, signal)).rejects.toThrow('offline')
  expect(await read()).toEqual(current)
  const store = new AuthoringSessions(options.directory)
  expect((await store.files(employee.employeeId, 'creation', signal)).get('assets/example.txt')?.toString()).toBe('fixed imported resource')
  expect(JSON.stringify(current)).not.toContain('employee-secret')
  expect(options.installSkill).not.toHaveBeenCalled()
  await expect(authoring.invoke('extensions.authoring.read', { ...coordinate }, api,
    { authenticated: true, employeeId: 'employee-two' }, signal)).rejects.toMatchObject({ code: 'EXTENSION_OWNER_REQUIRED' })
})

it('preserves a damaged draft and its original bytes without blocking another creation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'damaged-authoring-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  const store = new AuthoringSessions(root)
  const signal = new AbortController().signal
  const state = await store.begin('owner', 'broken', { kind: 'skill', id: 'my-skill', version: '1.0.0' }, new Map(), signal)
  const { createHash } = await import('node:crypto')
  const path = join(root, createHash('sha256').update(JSON.stringify(['owner', 'broken'])).digest('hex'), 'draft.json')
  await writeFile(path, '{damaged')
  await expect(store.read('owner', state.sessionId, signal)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('{damaged')
  expect((await store.begin('owner', 'healthy', { kind: 'expert-kit', id: 'my-kit', version: '1.0.0' }, new Map(), signal)).sessionId).toBe('healthy')
})
