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
import { readExtensionTar } from '../src/extension-archives.ts'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as ConversationAuthoring from '@deepseek-harness/product-runtime/conversation-authoring'

const draft = { kind: 'skill' as const, id: 'fact-review', version: '1.0.0', name: 'Fact review',
  summary: 'Check facts.', category: 'knowledge-research', body: '# Review\nCheck facts.', triggers: ['Review claims'] }
const employee = { authenticated: true, employeeId: 'employee-one', displayName: 'Original author' }
const kitDraft = { ...draft, kind: 'expert-kit' as const, id: 'fact-review-kit',
  skills: [{ id: 'review', name: draft.name, summary: draft.summary, body: draft.body, triggers: draft.triggers }] }

async function fixture(content: typeof draft | typeof kitDraft = draft, editing = false) {
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
  const versions = new Map<string, unknown>()
  let activated = false
  let loseReceipt = false
  let preparationRejectionStatus: number | undefined
  let blockAssessment = false
  let activationRejectionStatus: number | undefined
  let failPreparation = false
  const api = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.example', getSessionToken: () => 'private-token',
    fetch: async (url, init) => {
      const path = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (path.endsWith('/releases')) {
        if (failPreparation) { failPreparation = false; throw new Error('Preparation receipt lost') }
        if (preparationRejectionStatus !== undefined) {
          const status = preparationRejectionStatus
          preparationRejectionStatus = undefined
          return Response.json({ success: false, errCode: 'EXPERT_KIT_RELEASE_CONFLICT', errMessage: 'Preparation rejected' }, { status })
        }
        if (typeof init?.body !== 'string') throw new Error('Missing preparation body')
        const release = JSON.parse(init.body) as { id: string; version: string }
        const coordinate = `${release.id}@${release.version}`
        if (versions.has(coordinate)) expect(release).toEqual(versions.get(coordinate))
        versions.set(coordinate, release)
        releases.push(release)
        if (blockAssessment) {
          blockAssessment = false
          return Response.json({ success: true, data: { uploadUrl: `http://127.0.0.1:${address.port}/upload`,
            assessment: { status: 'BLOCKED', issues: [{ severity: 'ERROR', code: 'CONNECTOR_MISSING', message: 'Missing connector: company-erp' }] } } })
        }
        return Response.json({ success: true, data: { uploadUrl: `http://127.0.0.1:${address.port}/upload`, assessment: { status: 'READY' } } })
      }
      if (activationRejectionStatus !== undefined) {
        const status = activationRejectionStatus
        activationRejectionStatus = undefined
        return Response.json({ success: false, errCode: 'EXPERT_KIT_PACKAGE_INVALID', errMessage: 'Activation rejected' }, { status })
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
  let stageId: string | undefined
  if (editing) {
    for (const [path, value] of Object.entries(extensionFiles(ExtensionDraftSchema.parse(content)).files)) {
      await mkdir(join(importedDirectory, path, '..'), { recursive: true })
      await writeFile(join(importedDirectory, path), value)
    }
    await mkdir(join(importedDirectory, 'assets'))
    await writeFile(join(importedDirectory, 'assets', 'reference.txt'), 'original reference')
    const imported = await authoring.invoke('extensions.import.inspect', { kind: content.kind, source: 'directory' }, api, employee, signal) as { stageId: string }
    stageId = imported.stageId
  }
  const initial = ExtensionAuthoringSnapshotSchema.parse(await authoring.invoke('extensions.authoring.begin',
    { kind: content.kind, sessionId: 'creation', edit: editing, ...stageId ? { stageId } : {} }, api, employee, signal))
  const coordinate = { sessionId: 'creation', authoringId: initial.authoringId }
  await authoring.invoke('extensions.authoring.update', { ...coordinate, revision: 0,
    draft: { ...content, version: editing ? initial.draft.version : content.version } }, api, employee, signal)
  return { api, install, uploads, releases, importedDirectory, directory: options.directory, read, coordinate, signal,
    get authoring() { return authoring }, get activated() { return activated },
    loseReceipt: () => { loseReceipt = true },
    rejectPreparation: (status = 409) => { preparationRejectionStatus = status },
    blockAssessment: () => { blockAssessment = true },
    rejectActivation: (status = 422) => { activationRejectionStatus = status },
    failPreparation: () => { failPreparation = true },
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

it.each([draft, kitDraft])('keeps $kind content editable at a new version after blocked dependencies and restart', async (content) => {
  const test = await fixture(content)
  test.blockAssessment()
  const saving = test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal)
  await expect(saving).rejects.toMatchObject({ code: 'EXTENSION_DEPENDENCY_BLOCKED', retryable: false })
  await expect(saving).rejects.toThrow('CONNECTOR_MISSING: Missing connector: company-erp')
  expect(test.activated).toBe(false)
  expect(test.uploads).toEqual([])
  expect(test.install).not.toHaveBeenCalled()
  await test.restart()
  const state = await test.read()
  expect(state).toMatchObject({ revision: 2, draft: { ...content, version: '1.0.1' } })
  expect(state.pendingSave).toBeUndefined()
  expect(state.saved).toBeUndefined()
  await expect(test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 1, draft: content }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXTENSION_DRAFT_CHANGED' })
  await test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 2,
    draft: { ...state.draft, body: 'Corrected content' } }, test.api, employee, test.signal)
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 3 }, test.api, employee, test.signal))
    .resolves.toMatchObject({ id: content.id, version: '1.0.1', installed: content.kind === 'skill' })
  expect(test.releases).toMatchObject([{ version: '1.0.0' }, { version: '1.0.1' }])
  expect(test.uploads).toHaveLength(1)
})

it('keeps an existing resource ID fixed while recovering a rejected activation to the next editable version', async () => {
  const test = await fixture(draft, true)
  test.rejectActivation()
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXPERT_KIT_PACKAGE_INVALID' })
  expect(test.activated).toBe(false)
  expect(test.install).not.toHaveBeenCalled()
  await test.restart()
  const state = await test.read()
  expect(state).toMatchObject({ revision: 2, editing: true, draft: { ...draft, version: '1.0.2' } })
  expect(state.pendingSave).toBeUndefined()
  await expect(test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 2,
    draft: { ...state.draft, id: 'different-resource' } }, test.api, employee, test.signal)).rejects.toThrow('identity and version are fixed')
  await test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 2,
    draft: { ...state.draft, body: 'Repaired package' } }, test.api, employee, test.signal)
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 3 }, test.api, employee, test.signal))
    .resolves.toMatchObject({ id: draft.id, version: '1.0.2', installed: true })
  expect(test.releases).toMatchObject([{ version: '1.0.1' }, { version: '1.0.2' }])
  const files = await readExtensionTar(test.uploads.at(-1)!, test.signal)
  expect(files.get('assets/reference.txt')?.toString()).toBe('original reference')
})

it('retains sealed content if persisting editable recovery fails after a blocked preparation', async () => {
  const test = await fixture()
  test.blockAssessment()
  const store = new AuthoringSessions(test.directory)
  const write = store.write.bind(store)
  const fault = vi.spyOn(AuthoringSessions.prototype, 'write').mockImplementation(async (owner, state, signal) => {
    if (state.draft.version === '1.0.1') throw new Error('Recovery disk unavailable')
    return write(owner, state, signal)
  })
  onTestFinished(() => { fault.mockRestore() })
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toThrow('Recovery disk unavailable')
  fault.mockRestore()
  await test.restart()
  expect(await test.read()).toMatchObject({ revision: 1, pendingSave: { author: employee.displayName }, draft })
  await expect(test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 1,
    draft: { ...draft, body: 'Changed' } }, test.api, employee, test.signal)).rejects.toMatchObject({ code: 'EXTENSION_SAVE_PENDING' })
  expect(test.uploads).toEqual([])
})

it('uses the recovered draft version through Loader, the official loop and durable tool results', async () => {
  const test = await fixture()
  test.blockAssessment()
  const ctx = new Context()
  ctx.baseUrl = import.meta.url
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(Agents)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.loader.builtins['authoring-recovery'] = { name: 'authoring-recovery', inject: ConversationAuthoring.inject,
    apply: (owner: Context) => { ConversationAuthoring.apply(owner, { product: {
      invoke: async (method, payload, signal) => test.authoring.invoke(method, payload as Record<string, unknown>,
        test.api, employee, signal ?? test.signal),
    } }) } }
  await ctx.loader.root.update([{ id: 'authoring', name: 'cordis:authoring-recovery' }])
  await ctx.loader.await()
  await ctx.loader.resolve('authoring').fiber?.await()
  const calls = [
    { name: 'extension_save', arguments: '{"revision":1}' },
    { name: 'extension_draft', arguments: '{}' },
    { name: 'extension_draft_update', arguments: JSON.stringify({ revision: 2,
      content: JSON.stringify({ ...draft, version: '1.0.1', body: 'Corrected content' }) }) },
    { name: 'extension_save', arguments: '{"revision":3}' },
  ]
  class RecoveryAdapter extends LlmAdapter {
    readonly requests: GenerateOptions[] = []
    override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
    override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests.push(request)
      const call = calls[this.requests.length - 1]
      if (call) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`recovery-${this.requests.length}`), ...call } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Skill corrected, saved and installed.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  const adapter = new RecoveryAdapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('creation'), agentOptions: { provider: 'fixture', model: 'fixture' } })
  onTestFinished(() => handle.dispose())
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Save the skill and correct missing dependencies.' }], source: { kind: 'user' } }))
  await vi.waitFor(() => { expect(handle.agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) })
  const events = handle.agent.session.snapshotEvents()
  const recording = {
    system: events.filter(event => event.type === 'system/message').map(event => event.data.message.content),
    results: events.filter(event => event.type === 'tool/result').map(event => event.data.message.content),
    saved: (await test.read()).saved,
  }
  expect(recording.saved).toEqual({ id: draft.id, version: '1.0.1' })
  expect(test.releases).toMatchObject([{ version: '1.0.0' }, { version: '1.0.1' }])
  expect(JSON.stringify(recording)).not.toContain('private-token')
  await expect(JSON.stringify(recording, null, 2) + '\n').toMatchFileSnapshot('expected/authoring-validation-recovery.json')
})

it('does not unlock a lost preparation receipt after a later rejection', async () => {
  const test = await fixture()
  test.failPreparation()
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toThrow('Preparation receipt lost')
  await test.restart()
  test.rejectPreparation()
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXPERT_KIT_RELEASE_CONFLICT' })
  expect(await test.read()).toMatchObject({ revision: 1, pendingSave: { author: employee.displayName }, draft })
  expect(test.activated).toBe(false)
})

it.each([408, 429, 500].flatMap(status => (['prepare', 'activate'] as const).map(phase => ({ status, phase }))))(
  'keeps $phase HTTP $status recoverable only with the unchanged content', async ({ status, phase }) => {
    const test = await fixture()
    if (phase === 'prepare') test.rejectPreparation(status)
    else test.rejectActivation(status)
    await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
      .rejects.toMatchObject({ status })
    await test.restart()
    expect(await test.read()).toMatchObject({ revision: 1, pendingSave: { author: employee.displayName }, draft })
    await expect(test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 1,
      draft: { ...draft, body: 'Changed' } }, test.api, employee, test.signal)).rejects.toMatchObject({ code: 'EXTENSION_SAVE_PENDING' })
    await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
      .resolves.toMatchObject({ version: draft.version, installed: true })
  })

it.each(['assessment', 'activation'] as const)('keeps an uncertain earlier activation fixed when retry receives a rejected %s', async (failure) => {
  const test = await fixture()
  test.loseReceipt()
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toThrow('receipt lost')
  await test.restart()
  if (failure === 'assessment') test.blockAssessment()
  else test.rejectActivation()
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .rejects.toMatchObject({ code: 'EXTENSION_SAVE_PENDING', retryable: true })
  expect(await test.read()).toMatchObject({ revision: 1, pendingSave: { author: employee.displayName }, draft })
  await expect(test.authoring.invoke('extensions.authoring.update', { ...test.coordinate, revision: 1,
    draft: { ...draft, body: 'Changed' } }, test.api, employee, test.signal)).rejects.toMatchObject({ code: 'EXTENSION_SAVE_PENDING' })
  await expect(test.authoring.invoke('extensions.authoring.save', { ...test.coordinate, revision: 1 }, test.api, employee, test.signal))
    .resolves.toMatchObject({ version: draft.version, installed: true })
  expect(test.uploads.every(bytes => bytes.equals(test.uploads[0]!))).toBe(true)
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
