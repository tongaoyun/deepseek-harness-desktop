/** Skill management through the actual Loader, Typert codecs, Gateway and owner Peer. */
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import Skills from '@deepseek-ai/dsh-skill'
import * as FileSkills from '@deepseek-ai/dsh-skill-filesystem'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Access from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import * as AtomicWrite from '@deepseek-ai/dsh-atomic-write'
import { promises as fs, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { setImmediate as checkpoint } from 'node:timers/promises'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { zipSync, strToU8 } from 'fflate'
import * as Managed from './index.ts'
import * as Core from './core.ts'
import { parseSkillDoc } from './skill-document.ts'
import { createRepositoryManager } from './repositories.ts'

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
    prompt: SystemPrompt, projections: Projections, directory: WorkingDirectory, fs: FileSystem,
    typert: Typert, gateway: Gateway, access: Access, manager: Managed })
  const config = join(root, 'cordis.yml')
  await writeFile(config, ['skills', 'sessions', 'tools', 'prompt', 'projections', 'fs', 'directory', 'typert', 'access', 'gateway', 'manager'].map(name => `- name: 'cordis:${name}'`).join('\n') + "\n- name: 'cordis:filesystem'\n  config:\n    watch: false\n")
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string, args: Record<string, unknown>, signal?: AbortSignal) => ctx.typertGateway.invoke({ namespace: 'skillsManager', method, args, peer, signal })
  return { ctx, root, invoke }
}
it('retains categories through creation, local edits, publication and company discovery without changing native skill instructions', async () => {
  const { ctx, root, invoke } = await boot()
  const company = join(root, 'company')
  vi.stubEnv('DSH_COMPANY_SKILLS_ROOT', company)
  await invoke('createSkill', { request: { name: 'categorized-writing', description: 'Organize documents', body: 'Keep {{literal}} unchanged.', category: '企业协作' } })
  const file = join(root, '.dsh/skills/categorized-writing/SKILL.md')
  const original = await readFile(file, 'utf8')
  const signal = new AbortController().signal
  const personal = async () => {
    const value = (await ctx.skillsManager.readState({}, false, signal)).roots.find(item => item.key === 'dsh')
    if (!value) throw new Error('Personal skill source is missing')
    return value
  }
  const initial = await personal()
  expect(initial.categories).toHaveLength(1)
  const category = initial.categories[0]
  expect(category.name).toBe('企业协作')
  expect(initial.skills[0]?.categoryId).toBe(category.id)
  expect((await ctx.skills.get('categorized-writing'))?.content).toBe('Keep {{literal}} unchanged.')
  await invoke('renameCategory', { target: { root: 'dsh', id: category.id, name: '文档办公' } })
  const published = await ctx.skillsManager.exportSkill({ root: 'dsh', name: 'categorized-writing' }, signal)
  const exported = Buffer.from(published.files['skills/categorized-writing/SKILL.md'], 'base64').toString()
  expect(parseSkillDoc(exported)).toMatchObject({ data: { metadata: { category: '文档办公' } }, body: '\nKeep {{literal}} unchanged.\n' })
  expect(await readFile(file, 'utf8')).toBe(original)
  await mkdir(join(company, 'categorized-writing'), { recursive: true })
  await writeFile(join(company, 'categorized-writing/SKILL.md'), exported)
  const shared = (await ctx.skillsManager.readState({}, false, signal)).roots.find(item => item.key === 'company')
  if (!shared) throw new Error('Company skill source is missing')
  expect(shared.categories[0]?.name).toBe('文档办公')
  expect(shared.skills[0]?.categoryId).toBe(shared.categories[0]?.id)
  await expect(ctx.skillsManager.assignCategory({ root: 'company', name: 'categorized-writing', category: '' }, signal)).rejects.toMatchObject({ code: 'skills/operation' })
  await invoke('assignCategory', { target: { root: 'dsh', name: 'categorized-writing', category: '' } })
  expect((await personal()).skills[0]?.categoryId).toBeNull()
  const unclassified = await ctx.skillsManager.exportSkill({ root: 'dsh', name: 'categorized-writing' }, signal)
  expect(parseSkillDoc(Buffer.from(unclassified.files['skills/categorized-writing/SKILL.md'], 'base64').toString()).data).not.toHaveProperty('metadata.category')
  await invoke('assignCategory', { target: { root: 'dsh', name: 'categorized-writing', category: category.id } })
  await invoke('deleteCategory', { target: { root: 'dsh', id: category.id } })
  expect(await personal()).toMatchObject({ categories: [], skills: [{ categoryId: null }] })
  await expect(invoke('createSkill', { request: { name: 'invalid-category', description: 'No', body: 'No', category: 'x'.repeat(25) } })).rejects.toMatchObject({ details: { code: 'error.category.name' } })
  await expect(readFile(join(root, '.dsh/skills/invalid-category/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 30000)
it('reads project skills from the native current directory, including replay, without leaking another Session', async () => {
  const { ctx, root, invoke } = await boot()
  const original = join(root, 'original'), current = join(root, 'current')
  for (const [path, name] of [[original, 'original-orders'], [current, 'current-orders']]) {
    await mkdir(join(path, '.git'), { recursive: true })
    await mkdir(join(path, '.dsh', 'skills', name), { recursive: true })
    await writeFile(join(path, '.dsh', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Orders\n---\n${name}`)
  }
  const selected = ctx.sessions.create(SessionId('selected'), { meta: { cwd: original } })
  const sibling = ctx.sessions.create(SessionId('sibling'), { meta: { cwd: original } })
  const projectSkills = async (sessionId?: string) => {
    const result = z.object({ roots: z.array(z.object({ scope: z.string(), skills: z.array(z.object({ name: z.string() })) })) })
      .parse(await invoke('readState', { scope: sessionId === undefined ? {} : { sessionId }, refreshCompany: false }))
    return result.roots.filter(item => item.scope === 'project').flatMap(item => item.skills.map(skill => skill.name))
  }
  expect(await projectSkills(selected.id)).toEqual(['original-orders'])
  const change = selected.append('working-directory/change', { cwd: current })
  expect(selected.header.cwd).toBe(original)
  expect(ctx.workingDirectory.get(selected)).toBe(current)
  const restored = ctx.sessions.create(SessionId('restored'), { meta: { cwd: original }, seed: [change] })
  expect({
    current: await projectSkills(selected.id),
    restored: await projectSkills(restored.id),
    sibling: await projectSkills(sibling.id),
    absent: await projectSkills(),
    unknown: await projectSkills('unknown'),
  }).toMatchInlineSnapshot(`
    {
      "absent": [],
      "current": [
        "current-orders",
      ],
      "restored": [
        "current-orders",
      ],
      "sibling": [
        "original-orders",
      ],
      "unknown": [],
    }
  `)
}, 30000)

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

it('detects a user-root alias before a missing project skill directory is created', async () => {
  const { ctx, root, invoke } = await boot()
  const project = join(root, 'project'), alias = join(root, 'project-alias')
  await mkdir(join(project, '.git'), { recursive: true })
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  vi.stubEnv('DSH_CODEX_HOME', join(alias, '.dsh'))
  ctx.provide('workspaceRegistry', { list: () => [{ path: project }] })
  const request = { name: 'project-orders', description: 'Orders', body: 'Review orders.', workspace: project }
  await expect(invoke('createSkill', { request })).rejects.toMatchObject({
    code: 'skills/operation', details: { code: 'error.root.unsafe' },
  })
  await expect(lstat(join(project, '.dsh'))).rejects.toMatchObject({ code: 'ENOENT' })
  vi.stubEnv('DSH_CODEX_HOME', join(root, '.codex'))
  await invoke('createSkill', { request })
  expect(await readFile(join(project, '.dsh/skills/project-orders/SKILL.md'), 'utf8')).toContain('Review orders.')
}, 30000)

it('hides unverifiable project skills and blocks writes until the configured source directory is repaired', async () => {
  const { ctx, root, invoke } = await boot()
  const project = join(root, 'project'), configured = join(root, 'codex-home')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(join(project, '.dsh/skills/project-orders'), { recursive: true })
  await writeFile(join(project, '.dsh/skills/project-orders/SKILL.md'), '---\nname: project-orders\ndescription: Orders\n---\nReview orders.')
  await writeFile(configured, 'not a directory')
  vi.stubEnv('DSH_CODEX_HOME', configured)
  ctx.provide('workspaceRegistry', { list: () => [{ path: project }] })
  const session = ctx.sessions.create(SessionId('unverifiable-project'), { meta: { cwd: project } })
  const snapshot = z.object({
    roots: z.array(z.object({ scope: z.string(), skills: z.array(z.object({ name: z.string() })) })),
    warnings: z.array(z.object({ code: z.string().optional() })),
  })
  const read = async () => snapshot.parse(await invoke('readState', { scope: { sessionId: session.id }, refreshCompany: false }))
  const unavailable = await read()
  expect({ projectRoots: unavailable.roots.filter(item => item.scope === 'project'),
    warnings: unavailable.warnings.map(item => item.code) }).toMatchInlineSnapshot(`
    {
      "projectRoots": [],
      "warnings": [
        "warning.project.unavailable",
      ],
    }
  `)
  const request = { name: 'new-orders', description: 'Orders', body: 'New orders.', workspace: project }
  await expect(invoke('createSkill', { request })).rejects.toMatchObject({
    code: 'skills/operation', details: { code: 'error.root.unsafe' },
  })
  const created = join(project, '.dsh/skills/new-orders/SKILL.md')
  await expect(readFile(created)).rejects.toMatchObject({ code: 'ENOENT' })
  await rm(configured)
  await mkdir(configured)
  expect((await read()).roots.filter(item => item.scope === 'project').flatMap(item => item.skills.map(skill => skill.name))).toEqual(['project-orders'])
  await invoke('createSkill', { request })
  expect(await readFile(created, 'utf8')).toContain('New orders.')
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

it.each(['caller', 'unload'] as const)('stops exporting skill resources after %s cancellation and closes the active file', async (source) => {
  const { ctx, root, invoke } = await boot()
  const name = 'cancelled-export'
  await invoke('createSkill', { request: { name, description: 'Export cancellation', body: 'Keep this personal skill.' } })
  const directory = join(root, '.dsh/skills', name)
  await writeFile(join(directory, 'first.txt'), 'First resource')
  await writeFile(join(directory, 'second.txt'), 'Second resource')
  const started = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const open = fs.open
  const opened: Awaited<ReturnType<typeof open>>[] = []
  let readingSignal: AbortSignal | undefined
  const probe = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (typeof args[0] !== 'string' || !args[0].startsWith(directory)) return handle
    opened.push(handle)
    if (opened.length === 1) {
      const read = handle.readFile.bind(handle)
      vi.spyOn(handle, 'readFile').mockImplementation(async (...options) => {
        const input = options[0]
        readingSignal = typeof input === 'object' && input !== null ? input.signal : undefined
        started.resolve(undefined)
        await release.promise
        return read(...options)
      })
    }
    return handle
  })
  onTestFinished(() => { probe.mockRestore() })
  const controller = new AbortController()
  const pending = invoke('exportSkill', { target: { root: 'dsh', name } }, controller.signal)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  const manager = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:manager')
  let disposal: Promise<unknown> | undefined
  try {
    await started.promise
    if (source === 'caller') controller.abort(new Error('Export view closed'))
    else {
      if (!manager?.fiber) throw new Error('Skills manager is not mounted')
      disposal = manager.fiber.dispose()
      await vi.waitFor(() => { expect(readingSignal?.aborted).toBe(true) })
    }
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ error: { code: 'gateway/cancelled' } })
    await disposal
    expect(opened).toHaveLength(1)
    expect(opened[0].fd).toBe(-1)
    expect(readingSignal?.aborted).toBe(true)
    expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain('Keep this personal skill.')
  } finally {
    release.resolve(undefined)
    await outcome
    await disposal
    probe.mockRestore()
    await Promise.all(opened.map(handle => handle.close()))
  }
}, 30000)

it('invalidates the native catalog after a committed skill write even when the caller cancels at commit', async () => {
  const { ctx, root, invoke } = await boot()
  const name = 'committed-orders'
  const target = join(root, '.dsh', 'skills', name)
  expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain(name)
  const changes = vi.fn()
  ctx.on('skills/change', changes)
  const controller = new AbortController()
  const rename = fs.rename
  const probe = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    await rename(source, destination)
    if (destination === target) controller.abort(new Error('View closed after commit'))
  })
  onTestFinished(() => { probe.mockRestore() })
  try {
    await expect(invoke('createSkill', { request: { name, description: 'Committed orders', body: 'Review committed orders.' } }, controller.signal))
      .rejects.toMatchObject({ code: 'gateway/cancelled' })
  } finally {
    probe.mockRestore()
  }
  expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Review committed orders.')
  expect((await ctx.skills.list()).map(skill => skill.name)).toContain(name)
  expect(changes).toHaveBeenCalled()
}, 30000)

it.each(['upload', 'stage', 'unload-stage'] as const)('cancels skill import during %s without replacing the existing skill', async (phase) => {
  const { ctx, root, invoke } = await boot()
  const name = 'cancelled-import', target = join(root, '.dsh/skills', name)
  await invoke('createSkill', { request: { name, description: 'Original', body: 'Original body' } })
  await writeFile(join(target, 'original.txt'), 'Original resource')
  const started = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const mkdir = fs.mkdir, copy = fs.cp
  const probe = phase === 'upload'
    ? vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
      const result = await mkdir(...args)
      if (typeof args[0] === 'string' && args[0].includes(join('uploads', '.upload-'))) {
        started.resolve(undefined)
        await release.promise
      }
      return result
    })
    : vi.spyOn(fs, 'cp').mockImplementation(async (...args) => {
      await copy(...args)
      if (typeof args[1] === 'string' && basename(args[1]).startsWith(`.${name}.dssm-stage-`)) {
        started.resolve(undefined)
        await release.promise
      }
    })
  onTestFinished(() => { probe.mockRestore() })
  const controller = new AbortController()
  const pending = invoke('uploadSkill', { request: { conflict: 'overwrite', entries: [
    { path: 'SKILL.md', data: Buffer.from(`---\nname: ${name}\ndescription: Replacement\n---\nReplacement body`).toString('base64') },
    { path: 'replacement.txt', data: Buffer.from('Replacement resource').toString('base64') },
  ] } }, controller.signal)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  let disposal: Promise<unknown> | undefined
  let queued: Promise<unknown> | undefined
  try {
    await started.promise
    if (phase === 'unload-stage') {
      const manager = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:manager')
      if (!manager?.fiber) throw new Error('Skills manager is not mounted')
      disposal = manager.fiber.dispose()
    } else {
      controller.abort(new Error('Import view closed before commit'))
      queued = invoke('createSkill', { request: { name: 'after-cancel', description: 'Queued', body: 'Queued body' } })
      await expect(lstat(join(root, '.dsh/skills/after-cancel'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ error: { code: 'gateway/cancelled' } })
    await Promise.all([disposal, queued])
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Original body')
    expect((await readdir(target)).sort()).toEqual(['SKILL.md', 'original.txt'])
    expect((await readdir(join(root, '.dsh/skills'))).filter(path => path.includes('.dssm-'))).toEqual([])
    expect(await readdir(join(root, '.dsh/skills-manager/uploads'))).toEqual([])
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([outcome, disposal, queued])
    probe.mockRestore()
  }
}, 30000)

it.each(['backup', 'target'] as const)('finishes the complete import replacement after cancellation at %s rename', async (phase) => {
  const { ctx, root, invoke } = await boot()
  const name = 'committed-import', target = join(root, '.dsh/skills', name)
  await invoke('createSkill', { request: { name, description: 'Original', body: 'Original body' } })
  await writeFile(join(target, 'original.txt'), 'Original resource')
  expect((await ctx.skills.get(name))?.content).toBe('Original body')
  const started = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const controller = new AbortController(), rename = fs.rename
  const probe = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    await rename(source, destination)
    if (phase === 'backup' ? source === target : destination === target) {
      controller.abort(new Error('Import view closed during commit'))
      started.resolve(undefined)
      await release.promise
    }
  })
  onTestFinished(() => { probe.mockRestore() })
  const pending = invoke('uploadSkill', { request: { conflict: 'overwrite', entries: [
    { path: 'SKILL.md', data: Buffer.from(`---\nname: ${name}\ndescription: Replacement\n---\nReplacement body`).toString('base64') },
    { path: 'replacement.txt', data: Buffer.from('Replacement resource').toString('base64') },
  ] } }, controller.signal)
  const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  let queued: Promise<unknown> | undefined
  try {
    await started.promise
    queued = invoke('createSkill', { request: { name, description: 'Queued', body: 'Queued body' } })
      .then(value => ({ value }), (error: unknown) => ({ error }))
    release.resolve(undefined)
    expect(await outcome).toMatchObject({ error: { code: 'gateway/cancelled' } })
    expect(await queued).toMatchObject({ error: { code: 'skills/operation', details: { code: 'error.create.conflict' } } })
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toContain('Replacement body')
    expect((await readdir(target)).sort()).toEqual(['SKILL.md', 'replacement.txt'])
    expect((await ctx.skills.get(name))?.content).toBe('Replacement body')
    expect((await readdir(join(root, '.dsh/skills'))).filter(path => path.includes('.dssm-'))).toEqual([])
    expect(await readdir(join(root, '.dsh/skills-manager/uploads'))).toEqual([])
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([outcome, queued])
    probe.mockRestore()
  }
}, 30000)

it('keeps committed skills and refreshes the native catalog while cancelling later batch imports', async () => {
  const { ctx, root, invoke } = await boot()
  const first = join(root, '.dsh/skills/first-import')
  expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('first-import')
  const controller = new AbortController(), rename = fs.rename
  const probe = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
    await rename(source, destination)
    if (destination === first) controller.abort(new Error('Stop the remaining batch after the first commit'))
  })
  onTestFinished(() => { probe.mockRestore() })
  try {
    await expect(invoke('uploadSkill', { request: { entries: ['first-import', 'second-import'].map(name => ({
      path: `${name}/SKILL.md`, data: Buffer.from(`---\nname: ${name}\ndescription: Batch\n---\n${name} body`).toString('base64'),
    })) } }, controller.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(await readFile(join(first, 'SKILL.md'), 'utf8')).toContain('first-import body')
    await expect(lstat(join(root, '.dsh/skills/second-import'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await ctx.skills.get('first-import'))?.content).toBe('first-import body')
    expect((await ctx.skills.list()).map(skill => skill.name)).not.toContain('second-import')
    expect((await readdir(join(root, '.dsh/skills'))).filter(path => path.includes('.dssm-'))).toEqual([])
    expect(await readdir(join(root, '.dsh/skills-manager/uploads'))).toEqual([])
  } finally { probe.mockRestore() }
}, 30000)

it.each(['entries', 'zip'] as const)('rejects nonportable %s resource paths without installing a skill, then accepts portable resources', async (format) => {
  const { ctx, root, invoke } = await boot()
  const document = '---\nname: portable-orders\ndescription: Portable resources\n---\nRead the resources.'
  const request = (resources: Record<string, string>) => {
    const files = { 'SKILL.md': document, ...resources }
    return format === 'zip'
      ? { zip: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])))).toString('base64') }
      : { entries: Object.entries(files).map(([path, text]) => ({ path, data: Buffer.from(text).toString('base64') })) }
  }
  const changes = vi.fn()
  ctx.on('skills/change', changes)
  for (const path of ['assets/note.md:stream', 'assets/ref.', 'assets/ref /note.md', 'assets/a?b.md', 'assets/a\u0001b.md']) {
    await expect(invoke('uploadSkill', { request: request({ [path]: 'Invalid resource.' }) }))
      .rejects.toMatchObject({ code: 'skills/operation', details: { code: 'error.upload.path', params: { path } } })
    await expect(lstat(join(root, '.dsh/skills/portable-orders'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(root, '.dsh/skills-manager/uploads'))).toEqual([])
  }
  expect(changes).not.toHaveBeenCalled()
  const resources = { 'assets/参考.md': 'Read this.', '.config/settings.json': '{}', 'assets\\nested\\note.md': 'Nested resource.' }
  await invoke('uploadSkill', { request: request(resources) })
  for (const [path, text] of Object.entries(resources)) {
    expect(await readFile(join(root, '.dsh/skills/portable-orders', path.replaceAll('\\', '/')), 'utf8')).toBe(text)
  }
  expect((await ctx.skills.get('portable-orders'))?.content).toBe('Read the resources.')
  expect(changes).toHaveBeenCalled()
}, 30000)

it.each([
  ['createSkill', { zip: 'unused archive' }],
  ['uploadSkill', { source: '/unused-host-path' }],
  ['uploadSkill', { dryRun: true }],
  ['uploadSkill', { description: 'Unused creation field' }],
  ['installCatalog', { name: 'Unused upload field' }],
] as const)('strips fields from another operation in %s: %j through the native Gateway', async (method, extra) => {
  const { ctx, root, invoke } = await boot()
  const called = vi.spyOn(ctx.skillsManager, method)
  const fetching = vi.fn<typeof fetch>().mockRejectedValue(new Error('Catalog unavailable'))
  vi.stubGlobal('fetch', fetching)
  onTestFinished(() => { vi.unstubAllGlobals() })
  const document = Buffer.from('---\nname: imported-orders\ndescription: Orders\n---\nImported body').toString('base64')
  const create = { name: 'imported-orders', description: 'Orders', body: 'Created body' }
  const upload = { entries: [{ path: 'SKILL.md', data: document }] }
  const target = { catalog: 'clawhub', owner: 'orders', slug: 'imported-orders' }
  const args = method === 'createSkill' ? { request: { ...create, ...extra } }
    : method === 'uploadSkill' ? { request: { ...upload, ...extra } }
      : { target, destination: { ...extra } }
  if (method === 'installCatalog') {
    await expect(invoke(method, args)).rejects.toMatchObject({ code: 'skills/operation' })
    expect(called.mock.calls[0]).toEqual([target, {}, expect.any(AbortSignal)])
    expect(fetching).toHaveBeenCalledOnce()
    await expect(readFile(join(root, '.dsh/skills/imported-orders/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  } else {
    await invoke(method, args)
    expect(called.mock.calls[0]).toEqual([method === 'createSkill' ? create : upload, expect.any(AbortSignal)])
    expect(fetching).not.toHaveBeenCalled()
    expect(await readFile(join(root, '.dsh/skills/imported-orders/SKILL.md'), 'utf8')).toContain(method === 'createSkill' ? 'Created body' : 'Imported body')
  }
}, 30000)

it.each(['request', 'disposal'] as const)('does not write a skill after %s while waiting for company roots', async (kind) => {
  const { ctx, root } = await boot()
  let release!: (roots: { skillsRoot: string }) => void
  const reading = new Promise<{ skillsRoot: string }>((resolve) => { release = resolve })
  const read = vi.fn((_signal?: AbortSignal) => reading)
  ctx.provide('companyContent', { read })
  const controller = new AbortController()
  const pending = ctx.skillsManager.createSkill({ name: 'cancelled-preparation', description: 'No', body: 'No' }, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
  await vi.waitFor(() => { expect(read).toHaveBeenCalledOnce() })
  const manager = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:manager')
  const disposed = kind === 'disposal' ? manager?.fiber?.dispose() : undefined
  if (kind === 'request') controller.abort()
  await vi.waitFor(() => { expect(read.mock.calls[0][0]?.aborted).toBe(true) })
  release({ skillsRoot: join(root, 'company') })
  await rejected
  await disposed
  await expect(readFile(join(root, '.dsh/skills/cancelled-preparation/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
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

it.each(['request', 'disposal'].flatMap(kind => [false, true].map(blocked => ({ kind, blocked }))))(
  'releases stalled market reads on $kind, blocked abort propagation=$blocked', async ({ kind, blocked }) => {
    const { ctx, invoke } = await boot()
    const started = Promise.withResolvers<Response>()
    const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const cleanup = Promise.withResolvers<undefined>()
    const cancel = vi.fn(() => cleanup.promise)
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((_input, init) => {
      if (blocked) init?.signal?.addEventListener('abort', (event) => { event.stopImmediatePropagation() }, { once: true })
      const response = new Response(new ReadableStream<Uint8Array>({ start(value) { body.resolve(value) }, cancel }))
      started.resolve(response)
      return Promise.resolve(response)
    }))
    onTestFinished(() => { vi.unstubAllGlobals() })
    const controller = new AbortController()
    const pending = invoke('searchSkillsSh', { query: 'audit' }, controller.signal)
    const outcome = pending.catch((error: unknown) => error)
    let disposal: Promise<void> | undefined
    try {
      const response = await started.promise
      await vi.waitFor(() => { expect(response.body?.locked).toBe(true) })
      if (kind === 'request') controller.abort()
      else {
        const manager = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:manager')
        disposal = manager?.fiber?.dispose()
      }
      await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
      await disposal
      expect(await outcome).toMatchObject({ code: 'gateway/cancelled' })
      expect(response.body?.locked).toBe(false)
    } finally {
      controller.abort()
      ;(await body.promise).error(new Error('Test response released'))
      cleanup.resolve(undefined)
      await outcome
      await disposal
    }
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

async function readRecoveryState(path: string) {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  return z.object({ catalogInstalls: z.array(z.object({ name: z.string(), complete: z.boolean() }).loose()) }).loose().parse(value)
}

async function pendingRecovery(method: 'listRepositories' | 'previewUpdate', options: { uninstall?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(zipSync({ 'repo-main/skills/audit-orders/SKILL.md': strToU8('---\nname: audit-orders\ndescription: Audit orders\n---\nOriginal\n') })))))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const { ctx, root, invoke } = await boot()
  const signal = new AbortController().signal
  let request = { id: '', path: 'skills/audit-orders', root: 'dsh' as const }
  if (method === 'previewUpdate') {
    const repo = z.object({ id: z.string() }).parse(await invoke('addRepository', { request: { url: 'instudio/skills' } }))
    request = { ...request, id: repo.id }
    await invoke('refreshRepository', { request: { id: repo.id } })
    await invoke('installRepository', { request })
    if (options.uninstall) await invoke('uninstallRepository', { request })
  }
  expect(await ctx.skills.get('recovered-orders')).toBeUndefined()
  const document = '---\nname: recovered-orders\ndescription: Recovered order review\n---\nRecovered instructions.\n'
  await createRepositoryManager().installCatalog('clawhub:instudio/recovered-orders', {
    name: 'recovered-orders', entries: [{ path: 'SKILL.md', data: Buffer.from(document).toString('base64') }],
  }, { root: 'dsh' })
  const repositoryPath = join(root, '.dsh/skills-manager/repositories.json')
  const stored = await readRecoveryState(repositoryPath)
  const intent = stored.catalogInstalls.find(item => item.name === 'recovered-orders')
  if (!intent) throw new Error('Catalog installation intent is missing')
  intent.complete = false
  await writeFile(repositoryPath, JSON.stringify(stored))
  return { ctx, root, signal, document, repositoryPath, recover: () => method === 'listRepositories'
    ? ctx.skillsManager.listRepositories(signal) : ctx.skillsManager.previewUpdate(request, signal) }
}

it.each((['listRepositories', 'previewUpdate'] as const).flatMap(method => ['disable', 'category'].map(change => ({ method, change }))))(
  'preserves a concurrent user $change when $method recovers an installation', async ({ method, change }) => {
    const { ctx, root, signal, document, repositoryPath, recover } = await pendingRecovery(method)
    const started = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const policyPath = Core.managerStatePath(), policyDirectory = Core.managerHomePath()
    const read = fs.readFile, makeDirectory = fs.mkdir, write = AtomicWrite.writeFileAtomic
    let reads = 0
    // Synchronous policy I/O lets the checkpoint drain ready user-write microtasks; recovery keeps its promise barrier.
    const policyRead = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (args[0] !== policyPath) return read(...args)
      const value = readFileSync(policyPath, 'utf8')
      if (++reads === 2) {
        started.resolve(undefined)
        await release.promise
      }
      return value
    })
    const policyDirectoryWrite = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
      return args[0] === policyDirectory ? mkdirSync(...args) : makeDirectory(...args)
    })
    const policyWrite = vi.spyOn(AtomicWrite, 'writeFileAtomic').mockImplementation(async (...args) => {
      if (args[0] === policyPath) writeFileSync(args[0], args[1], { mode: args[2].mode })
      else await write(...args)
    })
    const pending: Promise<unknown>[] = []
    try {
      const reading = recover()
      pending.push(reading)
      await Promise.race([started.promise, reading.then(() => { throw new Error('Pending installation was not recovered') })])
      const writing = change === 'disable'
        ? ctx.skillsManager.setSkillEnabled({ root: 'dsh', name: 'recovered-orders' }, false, signal)
        : ctx.skillsManager.createCategory({ root: 'dsh', name: 'Retained category' }, signal)
      pending.push(writing)
      await checkpoint()
      release.resolve(undefined)
      await Promise.all(pending)
      const policy = (await Core.readManagerState()).state
      if (change === 'disable') {
        expect(policy.disabledSkills.dsh).toContain('recovered-orders')
        expect(policy.enabledSkills.dsh).not.toContain('recovered-orders')
      } else {
        expect(policy.categories.dsh).toMatchObject([{ name: 'Retained category' }])
        expect(policy.enabledSkills.dsh).toContain('recovered-orders')
      }
      const confirmed = await readRecoveryState(repositoryPath)
      expect(confirmed.catalogInstalls.find(item => item.name === 'recovered-orders')?.complete).toBe(true)
      expect(await ctx.skills.get('recovered-orders')).toMatchObject({
        invocation: { modelInvocable: change !== 'disable', userInvocable: change !== 'disable' },
      })
      expect(await readFile(join(root, '.dsh/skills/recovered-orders/SKILL.md'), 'utf8')).toBe(document)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled(pending)
      policyRead.mockRestore()
      policyDirectoryWrite.mockRestore()
      policyWrite.mockRestore()
    }
  })

it.each(['listRepositories', 'previewUpdate'] as const)('refreshes native discovery after %s recovers an installation without a user write', async (method) => {
  const { ctx, root, document, repositoryPath, recover } = await pendingRecovery(method)
  expect(await ctx.skills.get('recovered-orders')).toBeUndefined()
  await recover()
  const stored = await readRecoveryState(repositoryPath)
  expect(stored.catalogInstalls.find(item => item.name === 'recovered-orders')?.complete).toBe(true)
  expect(await ctx.skills.get('recovered-orders')).toMatchObject({
    content: 'Recovered instructions.', invocation: { modelInvocable: true, userInvocable: true },
  })
  expect(await readFile(join(root, '.dsh/skills/recovered-orders/SKILL.md'), 'utf8')).toBe(document)
})

it('refreshes native discovery when installation recovery commits before an update preview is rejected', async () => {
  const { ctx, root, document, repositoryPath, recover } = await pendingRecovery('previewUpdate', { uninstall: true })
  expect(await ctx.skills.get('recovered-orders')).toBeUndefined()
  await expect(recover()).rejects.toMatchObject({ code: 'skills/operation', details: { code: 'error.repo.invalid' } })
  const stored = await readRecoveryState(repositoryPath)
  expect(stored.catalogInstalls.find(item => item.name === 'recovered-orders')?.complete).toBe(true)
  expect((await Core.readManagerState()).state.enabledSkills.dsh).toContain('recovered-orders')
  expect(await ctx.skills.get('recovered-orders')).toMatchObject({
    content: 'Recovered instructions.', invocation: { modelInvocable: true, userInvocable: true },
  })
  expect(await readFile(join(root, '.dsh/skills/recovered-orders/SKILL.md'), 'utf8')).toBe(document)
})

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
