/** Skill management through the actual Loader, Typert codecs, Gateway and owner Peer. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import Skills from '@deepseek-ai/dsh-skill'
import * as FileSkills from '@deepseek-ai/dsh-skill-filesystem'
import Sessions from '@deepseek-ai/dsh-session'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Access from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { zipSync, strToU8 } from 'fflate'
import * as Managed from './index.ts'

const user = vi.hoisted(() => ({ root: '' }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => user.root }))
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { 'skills-test-guest': { kind: 'skills-test-guest' } }
}
async function boot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'skills-native-remote-')))
  user.root = root
  vi.stubEnv('DSH_HOME', join(root, '.dsh'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, '.agents'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, skills: Skills, filesystem: FileSkills, sessions: Sessions, tools: Tools,
    prompt: SystemPrompt, typert: Typert, gateway: Gateway, access: Access, manager: Managed })
  const config = join(root, 'cordis.yml')
  await writeFile(config, ['skills', 'sessions', 'tools', 'prompt', 'typert', 'access', 'gateway', 'manager'].map(name => `- name: 'cordis:${name}'`).join('\n') + "\n- name: 'cordis:filesystem'\n  config:\n    watch: false\n")
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string, args: Record<string, unknown>, signal?: AbortSignal) => ctx.typertGateway.invoke({ namespace: 'skillsManager', method, args, peer, signal })
  return { ctx, root, invoke }
}
it.each(['listWorkspaces', 'readWorkspace'] as const)('reports a failed native workspace registry through %s without claiming it is empty or unregistered', async (method) => {
  const { ctx, root, invoke } = await boot()
  const failure = new Error('Workspace storage could not be read')
  ctx.provide('workspaceRegistry', { list: () => { throw failure } })
  await expect(invoke(method, method === 'readWorkspace' ? { workspace: root } : {})).rejects.toMatchObject({
    code: 'skills/operation', details: { code: 'error.workspace.registryUnavailable' }, cause: failure,
  })
  expect(await invoke('createSkill', { request: { name: 'independent-orders', description: 'Local', body: 'Local body' } })).toMatchObject({ name: 'independent-orders' })
  expect(await readFile(join(root, '.dsh/skills/independent-orders/SKILL.md'), 'utf8')).toContain('Local body')
}, 30000)

it('preserves creation, policy, upload, export and trash through native dispatch; rejects invalid inputs', async () => {
  const { ctx, root, invoke } = await boot()
  const session = ctx.sessions.create(undefined, { meta: { agentPreset: 'default' } })
  const changes = vi.fn(), presetChanges = vi.fn(), commandChanges = vi.fn()
  ctx.on('skills/change', changes)
  ctx.on('agent-preset/selected', presetChanges)
  ctx.on('commands/change', commandChanges)
  const created = await invoke('createSkill', { request: { name: 'audit-orders', description: 'Audit orders', body: 'Review orders.' } })
  expect(created).toMatchObject({ name: 'audit-orders', root: 'dsh' })
  expect(changes).toHaveBeenCalled()
  expect(presetChanges).not.toHaveBeenCalled()
  expect(commandChanges).not.toHaveBeenCalled()
  expect(session.header.agentPreset).toBe('default')
  expect((await ctx.skills.get('audit-orders'))?.content).toBe('Review orders.')
  await invoke('setSkillEnabled', { target: { root: 'dsh', name: 'audit-orders' }, enabled: false })
  expect((await ctx.skills.get('audit-orders'))?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  const exported = await invoke('exportSkill', { target: { root: 'dsh', name: 'audit-orders' } })
  expect(exported).toMatchObject({ resourceKey: 'skills/audit-orders' })
  await invoke('uploadSkill', { request: { entries: [{ path: 'SKILL.md', data: Buffer.from('---\nname: upload-orders\ndescription: Imported\n---\nUploaded body').toString('base64') }] } })
  expect((await invoke('readDetail', { target: { root: 'dsh', name: 'upload-orders' } }))).toMatchObject({ body: 'Uploaded body' })
  const trashed = z.object({ id: z.string() }).parse(await invoke('trashSkill', { target: { root: 'dsh', name: 'upload-orders' } }))
  await expect(readFile(join(root, '.dsh/skills/upload-orders/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  await invoke('restoreTrash', { id: trashed.id, scope: {} })
  expect(await readFile(join(root, '.dsh/skills/upload-orders/SKILL.md'), 'utf8')).toContain('Uploaded body')
  const again = z.object({ id: z.string() }).parse(await invoke('trashSkill', { target: { root: 'dsh', name: 'upload-orders' } }))
  await invoke('deleteTrash', { id: again.id })
  await expect(invoke('createSkill', { request: { name: 'outside-orders', description: 'No', body: 'No', workspace: root } })).rejects.toMatchObject({ code: 'skills/operation', details: { code: 'error.workspace.unregistered' } })
  await expect(invoke('setSkillEnabled', { target: { root: 'dsh', name: 'audit-orders' }, enabled: 'yes' })).rejects.toMatchObject({ code: 'gateway/input-invalid' })
  const snapshot = z.object({ summary: z.object({ total: z.number(), disabled: z.number() }), trash: z.array(z.unknown()) }).parse(await invoke('readState', { scope: {}, refreshCompany: false }))
  expect({ summary: snapshot.summary, trashCount: snapshot.trash.length }).toMatchSnapshot()
  const guest = new Peer(ctx, { principal: { kind: 'skills-test-guest' } })
  ctx.remoteAccess.registerPolicy('skills-test-guest', { bindings: () => [{ resource: { kind: 'global' }, role: { name: 'test-wide', resource: 'global', actions: ['skillsManager/createSkill'] } }] })
  await expect(ctx.typertGateway.invoke({ namespace: 'skillsManager', method: 'createSkill', args: { request: { name: 'guest-orders', description: 'No', body: 'No' } }, peer: guest })).rejects.toMatchObject({ code: 'skills/operation', details: { code: 'error.proto.forbidden' } })
}, 30000)

it('cancels queued mutations before they write and unmounts the service on disposal', async () => {
  const { ctx, root } = await boot()
  await mkdir(join(root, 'company'), { recursive: true })
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  ctx.provide('companyContent', { read: async () => { entered(); await gate; return { skillsRoot: join(root, 'company') } } })
  const first = ctx.skillsManager.createSkill({ name: 'first-orders', description: 'First', body: 'First' }, new AbortController().signal)
  await started
  const controller = new AbortController()
  const second = ctx.skillsManager.createSkill({ name: 'cancelled-orders', description: 'No', body: 'No' }, controller.signal)
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  release()
  await first
  await rejected
  await expect(readFile(join(root, '.dsh/skills/cancelled-orders/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  const manager = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:manager')
  await manager?.fiber?.dispose()
  expect(ctx.get('skillsManager')).toBeUndefined()
}, 30000)

it('cancels market fetches on request abort and plugin disposal', async () => {
  const { ctx, invoke } = await boot()
  const starts: AbortSignal[] = []
  let entered!: () => void
  let started = new Promise<void>((resolve) => { entered = resolve })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((_input, init) => {
    const signal = init?.signal
    if (!signal) throw new Error('Market fetch requires a cancellation signal')
    starts.push(signal)
    entered()
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Market fetch cancelled')) }, { once: true })
    })
  }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const controller = new AbortController()
  const request = invoke('searchSkillsSh', { query: 'audit' }, controller.signal)
  const cancelled = expect(request).rejects.toMatchObject({ code: 'gateway/cancelled' })
  await started
  controller.abort()
  await cancelled
  expect(starts[0]?.aborted).toBe(true)
  started = new Promise<void>((resolve) => { entered = resolve })
  const pending = ctx.skillsManager.searchSkillsSh('audit', new AbortController().signal)
  const unloaded = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
  await started
  const manager = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:manager')
  await manager?.fiber?.dispose()
  await unloaded
  expect(starts[1]?.aborted).toBe(true)
}, 30000)

it.each(['request', 'disposal'] as const)('releases stalled market response reads on %s through the native Host lifetime', async (kind) => {
  const { ctx, invoke } = await boot()
  let entered!: (response: Response) => void
  const started = new Promise<Response>((resolve) => { entered = resolve })
  const cancel = vi.fn(() => new Promise<void>(() => {}))
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => {
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }))
    entered(response)
    return Promise.resolve(response)
  }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const controller = new AbortController()
  const pending = invoke('searchSkillsSh', { query: 'audit' }, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
  const response = await started
  await vi.waitFor(() => { expect(response.body?.locked).toBe(true) })
  if (kind === 'request') controller.abort()
  else {
    const manager = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:manager')
    await manager?.fiber?.dispose()
  }
  await rejected
  expect(cancel).toHaveBeenCalledOnce()
  expect(response.body?.locked).toBe(false)
}, 30000)

it('retains repository install, confirmed update, rollback and uninstall through native codecs', async () => {
  let body = 'Original'
  const document = () => `---\nname: audit-orders\ndescription: Audit orders\n---\n${body}\n`
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(zipSync({ 'repo-main/skills/audit-orders/SKILL.md': strToU8(document()) })))))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const { root, invoke } = await boot()
  const repo = z.object({ id: z.string() }).parse(await invoke('addRepository', { request: { url: 'instudio/skills' } }))
  await invoke('refreshRepository', { request: { id: repo.id } })
  const request = { id: repo.id, path: 'skills/audit-orders', root: 'dsh' }
  await invoke('readRepository', { request })
  await invoke('installRepository', { request })
  const file = join(root, '.dsh/skills/audit-orders/SKILL.md')
  expect(await readFile(file, 'utf8')).toContain('Original')
  body = 'Updated'
  await invoke('refreshRepository', { request: { id: repo.id } })
  const preview = z.object({ token: z.string() }).parse(await invoke('previewUpdate', { request }))
  await invoke('updateRepository', { request: { ...request, token: preview.token } })
  expect(await readFile(file, 'utf8')).toContain('Updated')
  const rollback = z.object({ token: z.string() }).parse(await invoke('previewUpdate', { request: { ...request, rollback: true } }))
  await invoke('rollbackRepository', { request: { ...request, token: rollback.token } })
  expect(await readFile(file, 'utf8')).toContain('Original')
  await invoke('uninstallRepository', { request })
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await invoke('removeRepository', { id: repo.id })
  expect(await invoke('listRepositories', {})).toMatchObject({ repositories: [] })
}, 30000)

it.each(['request', 'disposal'] as const)('cancels repository downloads on %s without persisting a scan failure', async (kind) => {
  let entered!: (signal: AbortSignal) => void
  let finish!: (error: Error) => void
  const started = new Promise<AbortSignal>((resolve) => { entered = resolve })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>((_input, init) => {
    const signal = init?.signal
    if (!signal) throw new Error('Repository download requires a cancellation signal')
    return new Promise<Response>((_resolve, reject) => {
      finish = reject
      signal.addEventListener('abort', () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Download cancelled')) }, { once: true })
      entered(signal)
    })
  }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const { ctx, root, invoke } = await boot()
  const repo = z.object({ id: z.string() }).parse(await invoke('addRepository', { request: { url: 'instudio/skills' } }))
  const stateFile = join(root, '.dsh/skills-manager/repositories.json')
  const before = await readFile(stateFile, 'utf8')
  const controller = new AbortController()
  const pending = ctx.skillsManager.refreshRepository({ id: repo.id }, controller.signal)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  const downloadSignal = await started
  let disposed: Promise<unknown> | undefined
  try {
    if (kind === 'request') controller.abort()
    else {
      const manager = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:manager')
      if (!manager?.fiber) throw new Error('Skills manager is not mounted')
      disposed = manager.fiber.dispose()
    }
    await vi.waitFor(() => { expect(downloadSignal.aborted).toBe(true) }, { timeout: 1000 })
    expect(await outcome).toMatchObject({ error: { code: 'gateway/cancelled' } })
    expect(await readFile(stateFile, 'utf8')).toBe(before)
  } finally {
    finish(new Error('Test download released'))
    await outcome
    await disposed
  }
}, 30000)

it('rejects a late repository response after cancellation without replacing the last complete snapshot', async () => {
  const archive = (body: string) => new Response(zipSync({ 'repo-main/skills/audit-orders/SKILL.md': strToU8(`---\nname: audit-orders\ndescription: Audit orders\n---\n${body}\n`) }))
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(archive('Original')))
  vi.stubGlobal('fetch', fetchMock)
  onTestFinished(() => { vi.unstubAllGlobals() })
  const { ctx, root, invoke } = await boot()
  const repo = z.object({ id: z.string() }).parse(await invoke('addRepository', { request: { url: 'instudio/skills' } }))
  await invoke('refreshRepository', { request: { id: repo.id } })
  const stateFile = join(root, '.dsh/skills-manager/repositories.json')
  const before = await readFile(stateFile, 'utf8')
  let entered!: () => void
  let finish!: (response: Response) => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; entered() }))
  const controller = new AbortController()
  const pending = ctx.skillsManager.refreshRepository({ id: repo.id }, controller.signal)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  await started
  controller.abort()
  finish(archive('Late response'))
  expect(await outcome).toMatchObject({ error: { code: 'gateway/cancelled' } })
  expect(await readFile(stateFile, 'utf8')).toBe(before)
  const request = { id: repo.id, path: 'skills/audit-orders', root: 'dsh' }
  const retained = await invoke('readRepository', { request })
  expect(retained).toMatchObject({ body: 'Original' })
  const commit: unknown = expect.stringMatching(/^[a-f0-9]{64}$/u)
  expect(retained).toMatchSnapshot({ commit })
  await invoke('installRepository', { request })
  expect(await readFile(join(root, '.dsh/skills/audit-orders/SKILL.md'), 'utf8')).toContain('Original')
}, 30000)

it('aborts a streaming repository response and waits for the transport to close', async () => {
  let closed = false
  const server = createServer((_request, response) => {
    response.on('close', () => { closed = true })
    response.writeHead(200, { 'content-type': 'application/zip' })
    response.write(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Test server has no TCP address')
  const nativeFetch = globalThis.fetch
  let entered!: () => void
  const headersReceived = new Promise<void>((resolve) => { entered = resolve })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
    const response = await nativeFetch(`http://127.0.0.1:${address.port}/archive.zip`, init)
    entered()
    return response
  }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const { ctx, root, invoke } = await boot()
  const repo = z.object({ id: z.string() }).parse(await invoke('addRepository', { request: { url: 'instudio/skills' } }))
  const stateFile = join(root, '.dsh/skills-manager/repositories.json')
  const before = await readFile(stateFile, 'utf8')
  const controller = new AbortController()
  const pending = ctx.skillsManager.refreshRepository({ id: repo.id }, controller.signal)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await headersReceived
    controller.abort()
    expect(await outcome).toMatchObject({ error: { code: 'gateway/cancelled' } })
    await vi.waitFor(() => { expect(closed).toBe(true) })
    expect(await readFile(stateFile, 'utf8')).toBe(before)
  } finally {
    controller.abort()
    server.closeAllConnections()
    await outcome
  }
}, 30000)

it('retains genuine repository network diagnostics and allows an explicit retry', async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('Connection refused'))
    .mockImplementation(() => Promise.resolve(new Response(zipSync({ 'repo-main/SKILL.md': strToU8('---\nname: audit-orders\ndescription: Audit orders\n---\nRetry succeeded\n') }))))
  vi.stubGlobal('fetch', fetchMock)
  onTestFinished(() => { vi.unstubAllGlobals() })
  const { invoke } = await boot()
  const repo = z.object({ id: z.string() }).parse(await invoke('addRepository', { request: { url: 'instudio/skills' } }))
  expect(await invoke('refreshRepository', { request: { id: repo.id } })).toMatchObject({ error: { code: 'error.repo.network' }, commit: null })
  expect(await invoke('listRepositories', {})).toMatchObject({ repositories: [{ id: repo.id, error: { code: 'error.repo.network' } }] })
  expect(await invoke('refreshRepository', { request: { id: repo.id } })).toMatchObject({ error: null })
  expect(await invoke('readRepository', { request: { id: repo.id, path: '' } })).toMatchObject({ body: 'Retry succeeded' })
}, 30000)
