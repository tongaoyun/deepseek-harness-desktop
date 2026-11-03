import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import { createRepositoryManager } from './repositories.ts'
import { assignSkillCategory, createCategory, getProviderSkill, listProviderCandidates, managerHomePath, managerStatePath, projectRoots, readManagerState, resolveWorkspaceTarget, scanEntries, setSkillEnabled, toKebab, trashRootPath, userRoots } from './core.ts'
import { selectInstallRecord } from './repository-updates.ts'
import type { Log, RepositoryState } from './types.ts'

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => process.env.DSH_HOME! }))
let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'harness-skills-state-')))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_CODEX_HOME', join(home, '.codex'))
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
const text = (body: string) => `---\nname: audit-orders\ndescription: Review ERP orders\n---\n${body}\n`
const pack = (body: string) => ({ name: 'audit-orders', entries: [{ path: 'SKILL.md', data: Buffer.from(text(body)).toString('base64') }] })
async function store(value: unknown) {
  await mkdir(managerHomePath(), { recursive: true })
  const file = join(managerHomePath(), 'repositories.json')
  const raw = JSON.stringify(value)
  await writeFile(file, raw)
  return { file, raw }
}
const catalogId = 'clawhub:instudio/audit-orders'
async function repositoryFixture(log?: Log, workspace?: string) {
  let body = 'Original'
  if (workspace) await mkdir(workspace, { recursive: true })
  const registered = workspace ? [workspace] : undefined
  const fetchImpl = vi.fn(async () => new Response(zipSync({ 'repo-main/skills/audit-orders/SKILL.md': strToU8(text(body)) })))
  const manager = createRepositoryManager({ fetchImpl, log, registeredWorkspaces: () => registered })
  const repo = await manager.add({ url: 'instudio/skills' })
  await manager.refresh({ id: repo.id })
  const input = { id: repo.id, path: 'skills/audit-orders', root: 'dsh' as const, ...(workspace ? { workspace } : {}) }
  await manager.install(input, registered)
  const destination = workspace ? await resolveWorkspaceTarget(workspace, registered) : { root: userRoots().find(root => root.key === 'dsh')! }
  if (!('root' in destination)) throw new Error('Destination unavailable')
  const root = destination.root
  return {
    manager, input, fetchImpl, root,
    file: join(root.path, 'audit-orders/SKILL.md'),
    stateFile: join(managerHomePath(), 'repositories.json'),
    backupRoot: join(managerHomePath(), 'repository-backups'),
    async refresh(value: string) { body = value; await manager.refresh({ id: repo.id }) },
    async update(value: string) {
      await this.refresh(value)
      const preview = await manager.preview(input)
      return manager.update({ ...input, token: preview.token })
    },
    async saved(): Promise<RepositoryState> { return JSON.parse(await readFile(this.stateFile, 'utf8')) },
    async uninstall(entry: 'repository' | 'mine' = 'repository') {
      const result = entry === 'mine' ? await manager.trashSkill(root, 'audit-orders') : await manager.uninstall(input)
      if (!('id' in result) || typeof result.id !== 'string') throw new Error('Uninstall failed')
      return { id: result.id, path: join(trashRootPath(), result.id) }
    },
  }
}
it.each([
  { version: 1, repositories: [], installs: [], catalogInstalls: [] },
  { version: 2, repositories: [], installs: [] },
  { version: 2, repositories: [], installs: [], catalogInstalls: [{ id: catalogId, name: 'audit-orders', root: 'dsh', complete: true }] },
  { version: 2, repositories: [], installs: [], catalogInstalls: [catalogId] },
  { version: 2, repositories: [], installs: [], catalogInstalls: [{ id: catalogId, name: 'audit-orders', complete: true, files: [{ path: 'SKILL.md', hash: 'a'.repeat(64) }] }] },
])('rejects unsupported installation state without rewriting files: %j', async (value) => {
  const { file, raw } = await store(value)
  const fetchImpl = vi.fn()
  await expect(createRepositoryManager({ fetchImpl }).list()).rejects.toMatchObject({ code: 'error.repo.state' })
  expect(await readFile(file, 'utf8')).toBe(raw)
  expect(fetchImpl).not.toHaveBeenCalled()
})
it('requires an explicit copy when managing an installation', async () => {
  await expect(selectInstallRecord([], { id: 'repo', path: '' }, [], 'missing')).rejects.toThrow('请明确选择安装位置')
})
it('installs catalog content, preserves collisions, and restores the exact copy after restart', async () => {
  const manager = createRepositoryManager()
  await manager.installCatalog(catalogId, pack('Original'), { root: 'dsh' })
  const file = join(home, 'skills', 'audit-orders', 'SKILL.md')
  const current = await manager.list()
  expect(current.catalogCopies).toMatchObject([{ id: catalogId, installedRoot: 'dsh' }])
  expect(current).not.toHaveProperty('catalogUnknownIds')
  await expect(manager.installCatalog(catalogId, pack('Replacement'), { root: 'dsh' })).rejects.toMatchObject({ code: 'error.repo.conflict' })
  expect(await readFile(file, 'utf8')).toBe(text('Original'))
  const root = userRoots().find(root => root.key === 'dsh')!
  const trashed = await manager.trashSkill(root, 'audit-orders')
  if (!('id' in trashed) || typeof trashed.id !== 'string') throw new Error('Trash failed')
  const restarted = createRepositoryManager()
  expect((await restarted.list()).catalogCopies).toEqual([])
  await restarted.restoreTrash(trashed.id)
  expect((await restarted.list()).catalogCopies).toMatchObject([{ id: catalogId, installedRoot: 'dsh' }])
  expect(await readFile(file, 'utf8')).toBe(text('Original'))
})
it('uses archive hashes and per-copy status across update, rollback and restart', async () => {
  let body = 'Original'
  const fetchImpl = vi.fn(async () => new Response(zipSync({ 'repo-main/skills/audit-orders/SKILL.md': strToU8(text(body)) })))
  const manager = createRepositoryManager({ fetchImpl })
  const repo = await manager.add({ url: 'instudio/skills' })
  await manager.refresh({ id: repo.id })
  await manager.install({ id: repo.id, path: 'skills/audit-orders', root: 'dsh' })
  body = 'Updated'
  await manager.refresh({ id: repo.id })
  const skill = (await manager.list()).repositories[0].skills[0]
  expect(skill.installations).toMatchObject([{ installedRoot: 'dsh', updateAvailable: true }])
  expect(skill).not.toHaveProperty('installedRoot')
  expect(skill).not.toHaveProperty('tracked')
  const input = { id: repo.id, path: 'skills/audit-orders', root: 'dsh' as const }
  const preview = await manager.preview(input)
  await manager.update({ ...input, token: preview.token })
  const restarted = createRepositoryManager({ fetchImpl })
  const rollback = await restarted.preview({ ...input, rollback: true })
  await restarted.rollback({ ...input, token: rollback.token })
  expect(await readFile(join(home, 'skills/audit-orders/SKILL.md'), 'utf8')).toBe(text('Original'))
  const saved: unknown = JSON.parse(await readFile(join(managerHomePath(), 'repositories.json'), 'utf8'))
  expect(saved).toHaveProperty('installs.0.commit', expect.stringMatching(/^[a-f0-9]{64}$/))
  expect(saved).toMatchObject({ version: 2, installs: [{
    files: [{ hash: createHash('sha256').update(text('Original')).digest('hex') }] }] })
})
it('retains one usable previous version across consecutive repository updates, rollback and restart', async () => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const firstBackup = (await fixture.saved()).installs[0].backup!.key
  await fixture.update('Third')
  const secondBackup = (await fixture.saved()).installs[0].backup!.key
  expect(await readdir(fixture.backupRoot)).toEqual([secondBackup])
  expect(secondBackup).not.toBe(firstBackup)
  expect(await readFile(join(fixture.backupRoot, secondBackup, 'SKILL.md'), 'utf8')).toBe(text('Second'))
  const restarted = createRepositoryManager({ fetchImpl: fixture.fetchImpl })
  const preview = await restarted.preview({ ...fixture.input, rollback: true })
  await restarted.rollback({ ...fixture.input, token: preview.token })
  const rollbackBackup = (await fixture.saved()).installs[0].backup!.key
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Second'))
  expect(await readdir(fixture.backupRoot)).toEqual([rollbackBackup])
  expect(await readFile(join(fixture.backupRoot, rollbackBackup, 'SKILL.md'), 'utf8')).toBe(text('Third'))
  const reopened = createRepositoryManager({ fetchImpl: fixture.fetchImpl })
  const reverse = await reopened.preview({ ...fixture.input, rollback: true })
  await reopened.rollback({ ...fixture.input, token: reverse.token })
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Third'))
  expect(await readdir(fixture.backupRoot)).toEqual([(await fixture.saved()).installs[0].backup!.key])
})
it('keeps the installed files and existing rollback when repository metadata cannot commit', async () => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const previousBackup = (await fixture.saved()).installs[0].backup!.key
  await fixture.refresh('Third')
  const refreshedState = await readFile(fixture.stateFile, 'utf8')
  const preview = await fixture.manager.preview(fixture.input)
  vi.spyOn(atomicWrite, 'writeFileAtomic').mockRejectedValueOnce(Object.assign(new Error('metadata unavailable'), { code: 'EACCES' }))
  await expect(fixture.manager.update({ ...fixture.input, token: preview.token })).rejects.toThrow('metadata unavailable')
  expect(await readFile(fixture.stateFile, 'utf8')).toBe(refreshedState)
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Second'))
  expect(await readdir(fixture.backupRoot)).toEqual([previousBackup])
  expect(await readFile(join(fixture.backupRoot, previousBackup, 'SKILL.md'), 'utf8')).toBe(text('Original'))
  const restarted = createRepositoryManager({ fetchImpl: fixture.fetchImpl })
  const rollback = await restarted.preview({ ...fixture.input, rollback: true })
  await restarted.rollback({ ...fixture.input, token: rollback.token })
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Original'))
})
it.each(['log', 'console', 'failed-log'] as const)('reports backup cleanup failure through %s while preserving the committed update', async mode => {
  const log = mode === 'console' ? undefined : vi.fn<Log>(async event => {
    if (mode === 'failed-log' && event === 'repository-backup-warning') throw new Error('logger unavailable')
  })
  const fallback = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const fixture = await repositoryFixture(log)
  await fixture.update('Second')
  const previousBackup = (await fixture.saved()).installs[0].backup!.key
  const previousPath = join(fixture.backupRoot, previousBackup)
  const remove = fs.rm.bind(fs)
  vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
    if (path === previousPath) throw Object.assign(new Error('backup locked'), { code: 'EACCES' })
    return remove(path, options)
  })
  const result = await fixture.update('Third')
  const state = await fixture.saved()
  expect(result).toEqual({ name: 'audit-orders', commit: state.installs[0].commit })
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Third'))
  expect((await readdir(fixture.backupRoot)).sort()).toEqual([previousBackup, state.installs[0].backup!.key].sort())
  expect(await readFile(join(fixture.backupRoot, state.installs[0].backup!.key, 'SKILL.md'), 'utf8')).toBe(text('Second'))
  if (log) expect(log).toHaveBeenCalledWith('repository-backup-warning', expect.stringContaining(previousPath))
  if (mode !== 'log') expect(fallback).toHaveBeenCalledWith(expect.stringContaining(previousPath))
  else expect(fallback).not.toHaveBeenCalled()
})
it('preserves an old repository backup still referenced by another installation', async () => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const state = await fixture.saved()
  const previousBackup = state.installs[0].backup!.key
  state.installs.push({ ...state.installs[0], root: 'agents' })
  await writeFile(fixture.stateFile, JSON.stringify(state))
  await fixture.update('Third')
  const saved = await fixture.saved()
  expect((await readdir(fixture.backupRoot)).sort()).toEqual([previousBackup, saved.installs[0].backup!.key].sort())
  expect(saved.installs[1].backup!.key).toBe(previousBackup)
  expect(await readFile(join(fixture.backupRoot, previousBackup, 'SKILL.md'), 'utf8')).toBe(text('Original'))
})
it('does not use an unsafe persisted backup key as a cleanup path', async () => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const state = await fixture.saved()
  const outside = join(home, 'keep-backup')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'Keep local files')
  state.installs[0].backup!.key = '../../keep-backup'
  await writeFile(fixture.stateFile, JSON.stringify(state))
  await fixture.update('Third')
  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('Keep local files')
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Third'))
})
it.each(['repository', 'mine'] as const)('keeps the repository source and rollback backup through %s trash and restore', async entry => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const backup = (await fixture.saved()).installs[0].backup!.key
  const trash = await fixture.uninstall(entry)
  expect((await fixture.saved()).installs[0]).toMatchObject({ trashId: trash.id, backup: { key: backup } })
  expect(await readFile(join(fixture.backupRoot, backup, 'SKILL.md'), 'utf8')).toBe(text('Original'))
  const restarted = createRepositoryManager({ fetchImpl: fixture.fetchImpl })
  await restarted.restoreTrash(trash.id)
  expect((await fixture.saved()).installs[0]).not.toHaveProperty('trashId')
  const rollback = await restarted.preview({ ...fixture.input, rollback: true })
  await restarted.rollback({ ...fixture.input, token: rollback.token })
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Original'))
  expect(await readdir(fixture.backupRoot)).toEqual([(await fixture.saved()).installs[0].backup!.key])
})
it.each(['repository', 'mine'] as const)('retires repository ownership and backups after %s trash and permanent deletion before reinstalling', async entry => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const trash = await fixture.uninstall(entry)
  expect(await fixture.manager.permanentlyDeleteTrash(trash.id)).toEqual({ id: trash.id, name: 'audit-orders' })
  expect((await fixture.saved()).installs).toEqual([])
  expect(await readdir(fixture.backupRoot)).toEqual([])
  await expect(fs.lstat(trash.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const restarted = createRepositoryManager({ fetchImpl: fixture.fetchImpl })
  await restarted.install(fixture.input)
  const installs = (await fixture.saved()).installs
  expect(installs).toHaveLength(1)
  expect(installs[0]).not.toHaveProperty('backup')
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Second'))
  expect(await readdir(fixture.backupRoot)).toEqual([])
})
it.each(['repository', 'mine'] as const)('keeps %s trash history when reinstalling before permanent deletion', async entry => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const backup = (await fixture.saved()).installs[0].backup!.key
  const trash = await fixture.uninstall(entry)
  await fixture.manager.install(fixture.input)
  const installed = await fixture.saved()
  expect(installed.installs).toHaveLength(2)
  expect(installed.installs.find(record => record.trashId === trash.id)).toMatchObject({ backup: { key: backup } })
  expect(installed.installs.filter(record => !record.trashId)).toHaveLength(1)
  expect(await fixture.manager.restoreTrash(trash.id)).toMatchObject({ ok: false, code: 'error.trash.conflict' })
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Second'))
  await fixture.manager.permanentlyDeleteTrash(trash.id)
  expect((await fixture.saved()).installs).toHaveLength(1)
  expect((await fixture.saved()).installs[0]).not.toHaveProperty('trashId')
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Second'))
  expect(await readdir(fixture.backupRoot)).toEqual([])
})
it.each(['user', 'project'] as const)('keeps the replacement %s skill category when deleting its old trash entry', async scope => {
  const workspace = scope === 'project' ? join(home, 'workspace') : undefined
  const fixture = await repositoryFixture(undefined, workspace)
  const options = workspace ? { projectCwds: [workspace] } : {}
  const original = await createCategory(fixture.root.key, 'Original', undefined, options)
  if (!('category' in original)) throw new Error('Category unavailable')
  await assignSkillCategory(fixture.root.key, 'audit-orders', original.category.id, undefined, options)
  const trash = await fixture.uninstall()
  await fixture.manager.install(fixture.input, workspace ? [workspace] : undefined)
  const replacement = await createCategory(fixture.root.key, 'Replacement', undefined, options)
  if (!('category' in replacement)) throw new Error('Category unavailable')
  await assignSkillCategory(fixture.root.key, 'audit-orders', replacement.category.id, undefined, options)
  const before = (await readManagerState()).state

  await fixture.manager.permanentlyDeleteTrash(trash.id)

  expect((await readManagerState()).state).toEqual(before)
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Original'))
  await expect(fs.lstat(trash.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each(['user', 'project'] as const)('keeps another recoverable %s copy category until its last trash entry is deleted', async scope => {
  const workspace = scope === 'project' ? join(home, 'workspace') : undefined
  const fixture = await repositoryFixture(undefined, workspace)
  const options = workspace ? { projectCwds: [workspace], registeredWorkspaces: [workspace] } : {}
  const original = await fixture.uninstall()
  await fixture.manager.install(fixture.input, workspace ? [workspace] : undefined)
  const category = await createCategory(fixture.root.key, 'Replacement', undefined, options)
  if (!('category' in category)) throw new Error('Category unavailable')
  await assignSkillCategory(fixture.root.key, 'audit-orders', category.category.id, undefined, options)
  const replacement = await fixture.uninstall()
  const before = (await readManagerState()).state

  await fixture.manager.permanentlyDeleteTrash(original.id)
  expect((await readManagerState()).state).toEqual(before)
  await fixture.manager.restoreTrash(replacement.id, options)
  expect((await readManagerState()).state).toEqual(before)
  const final = await fixture.uninstall()
  await fixture.manager.permanentlyDeleteTrash(final.id)

  const after = (await readManagerState()).state
  expect(after.categoryMembers[fixture.root.key]).not.toHaveProperty('audit-orders')
  expect(after.categoryOrder[fixture.root.key][category.category.id]).toEqual([])
  expect(after.categories[fixture.root.key]).toEqual(before.categories[fixture.root.key])
})
it.each(['available', 'unavailable'] as const)('keeps a successful deletion committed when category cleanup fails and logging is %s', async logging => {
  const log: Log = vi.fn(async () => undefined)
  const fixture = await repositoryFixture(log)
  await fixture.update('Second')
  const category = await createCategory(fixture.root.key, 'Review')
  if (!('category' in category)) throw new Error('Category unavailable')
  await assignSkillCategory(fixture.root.key, 'audit-orders', category.category.id)
  const trash = await fixture.uninstall()
  const before = (await readManagerState()).state
  const write = atomicWrite.writeFileAtomic
  vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementation(async (path, ...args) => {
    if (path === managerStatePath()) throw Object.assign(new Error('policy locked'), { code: 'EACCES' })
    return write(path, ...args)
  })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  if (logging === 'unavailable') vi.mocked(log).mockRejectedValue(new Error('log locked'))

  await expect(fixture.manager.permanentlyDeleteTrash(trash.id)).resolves.toEqual({ id: trash.id, name: 'audit-orders' })

  expect((await fixture.saved()).installs).toEqual([])
  expect(await readdir(fixture.backupRoot)).toEqual([])
  await expect(fs.lstat(trash.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readManagerState()).state).toEqual(before)
  expect(log).toHaveBeenCalledWith('trash-category-warning', expect.stringContaining('policy locked'))
  if (logging === 'unavailable') expect(warning).toHaveBeenCalled()
})
it('preserves categories when the deleted skill source can no longer be verified', async () => {
  const workspace = join(home, 'workspace')
  const fixture = await repositoryFixture(undefined, workspace)
  const category = await createCategory(fixture.root.key, 'Review', undefined, { projectCwds: [workspace] })
  if (!('category' in category)) throw new Error('Category unavailable')
  await assignSkillCategory(fixture.root.key, 'audit-orders', category.category.id, undefined, { projectCwds: [workspace] })
  const trash = await fixture.uninstall()
  const before = (await readManagerState()).state
  const outside = join(home, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep.txt'), 'Keep external files')
  await fs.rename(join(workspace, '.dsh'), join(workspace, '.dsh-saved'))
  await fs.symlink(outside, join(workspace, '.dsh'), 'dir')

  await fixture.manager.permanentlyDeleteTrash(trash.id)

  expect((await readManagerState()).state).toEqual(before)
  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('Keep external files')
  await expect(fs.lstat(trash.path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('cleans the last source category without affecting another source with the same name', async () => {
  const fixture = await repositoryFixture()
  const shared = userRoots().find(root => root.key === 'agents')!
  await fixture.manager.installCatalog(catalogId, pack('Shared'), { root: 'agents' })
  const personalCategory = await createCategory(fixture.root.key, 'Personal')
  const sharedCategory = await createCategory(shared.key, 'Shared')
  if (!('category' in personalCategory) || !('category' in sharedCategory)) throw new Error('Category unavailable')
  await assignSkillCategory(fixture.root.key, 'audit-orders', personalCategory.category.id)
  await assignSkillCategory(shared.key, 'audit-orders', sharedCategory.category.id)
  const sharedTrash = await fixture.manager.trashSkill(shared, 'audit-orders')
  if (!('id' in sharedTrash)) throw new Error('Trash failed')
  const personalTrash = await fixture.uninstall()
  const before = (await readManagerState()).state

  await fixture.manager.permanentlyDeleteTrash(personalTrash.id)

  const after = (await readManagerState()).state
  expect(after.categoryMembers[fixture.root.key]).not.toHaveProperty('audit-orders')
  expect(after.categoryOrder[fixture.root.key][personalCategory.category.id]).toEqual([])
  expect(after.categoryMembers[shared.key]).toEqual(before.categoryMembers[shared.key])
  expect(after.categoryOrder[shared.key]).toEqual(before.categoryOrder[shared.key])
  await fixture.manager.restoreTrash(sharedTrash.id)
  expect(await readFile(join(shared.path, 'audit-orders/SKILL.md'), 'utf8')).toBe(text('Shared'))
})
it.each(['metadata', 'move'] as const)('keeps repository source, files and rollback when Mine trash fails at %s', async failure => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const before = await fixture.saved()
  const backup = before.installs[0].backup!.key
  if (failure === 'metadata') {
    vi.spyOn(atomicWrite, 'writeFileAtomic').mockRejectedValueOnce(Object.assign(new Error('metadata unavailable'), { code: 'EACCES' }))
  } else {
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (source === join(fixture.root.path, 'audit-orders')) throw Object.assign(new Error('skill locked'), { code: 'EACCES' })
      return rename(source, target)
    })
  }
  await expect(fixture.manager.trashSkill(fixture.root, 'audit-orders')).rejects.toMatchObject({ code: 'EACCES' })
  expect(await fixture.saved()).toEqual(before)
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Second'))
  expect(await readdir(fixture.backupRoot)).toEqual([backup])
  expect(await readFile(join(fixture.backupRoot, backup, 'SKILL.md'), 'utf8')).toBe(text('Original'))
})
it('keeps Mine trash scoped to the selected registered project', async () => {
  const project = join(home, 'project')
  const fixture = await repositoryFixture(undefined, project)
  await fixture.update('Second')
  const user = userRoots().find(root => root.key === 'dsh')!
  const localFile = join(user.path, 'audit-orders/SKILL.md')
  await mkdir(join(user.path, 'audit-orders'), { recursive: true })
  await writeFile(localFile, text('Personal'))
  const trash = await fixture.uninstall('mine')
  expect((await fixture.saved()).installs[0]).toMatchObject({ workspace: project, trashId: trash.id })
  expect(await readFile(localFile, 'utf8')).toBe(text('Personal'))
  await fixture.manager.restoreTrash(trash.id, { projectCwds: [project], registeredWorkspaces: [project] })
  const preview = await fixture.manager.preview({ ...fixture.input, rollback: true })
  await fixture.manager.rollback({ ...fixture.input, token: preview.token })
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Original'))
  expect(await readFile(localFile, 'utf8')).toBe(text('Personal'))
})
it('does not claim repository ownership from another user or project source during Mine trash', async () => {
  const project = join(home, 'project')
  const fixture = await repositoryFixture(undefined, project)
  await fixture.update('Second')
  const before = await fixture.saved()
  const shared = userRoots().find(root => root.key === 'agents')!
  await mkdir(join(shared.path, 'audit-orders'), { recursive: true })
  await writeFile(join(shared.path, 'audit-orders/SKILL.md'), text('Shared'))
  const trash = await fixture.manager.trashSkill(shared, 'audit-orders')
  if (!('id' in trash) || typeof trash.id !== 'string') throw new Error('Trash failed')
  await fixture.manager.permanentlyDeleteTrash(trash.id)
  expect(await fixture.saved()).toEqual(before)
  await mkdir(join(project, '.codex/skills/audit-orders'), { recursive: true })
  await writeFile(join(project, '.codex/skills/audit-orders/SKILL.md'), text('Project Codex'))
  const readonly = (await projectRoots([project])).find(root => root.kind === 'project-codex')!
  expect(await fixture.manager.trashSkill(readonly, 'audit-orders')).toMatchObject({ ok: false })
  expect(await fixture.saved()).toEqual(before)
  expect(await readFile(fixture.file, 'utf8')).toBe(text('Second'))
})
it.each(['metadata', 'files', 'missing'] as const)('preserves repository ownership and backups when permanent deletion fails at %s', async failure => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const trash = await fixture.uninstall()
  const previous = await fixture.saved()
  const backup = previous.installs[0].backup!.key
  if (failure === 'metadata') {
    vi.spyOn(atomicWrite, 'writeFileAtomic').mockRejectedValueOnce(Object.assign(new Error('metadata unavailable'), { code: 'EACCES' }))
  } else if (failure === 'files') {
    const remove = fs.rm.bind(fs)
    vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
      if (path === trash.path) throw Object.assign(new Error('trash locked'), { code: 'EACCES' })
      return remove(path, options)
    })
  } else await rm(trash.path, { recursive: true })
  if (failure === 'missing') expect(await fixture.manager.permanentlyDeleteTrash(trash.id)).toMatchObject({ ok: false, code: 'error.trash.notFound' })
  else await expect(fixture.manager.permanentlyDeleteTrash(trash.id)).rejects.toMatchObject({ code: 'EACCES' })
  expect(await fixture.saved()).toEqual(previous)
  expect(await readdir(fixture.backupRoot)).toEqual([backup])
  expect(await readFile(join(fixture.backupRoot, backup, 'SKILL.md'), 'utf8')).toBe(text('Original'))
  if (failure !== 'missing') expect(await readFile(join(trash.path, 'audit-orders/SKILL.md'), 'utf8')).toBe(text('Second'))
})
it('preserves a permanently deleted copy backup still referenced by another installation', async () => {
  const fixture = await repositoryFixture()
  await fixture.update('Second')
  const state = await fixture.saved()
  const backup = state.installs[0].backup!.key
  state.installs.push({ ...state.installs[0], root: 'agents' })
  await writeFile(fixture.stateFile, JSON.stringify(state))
  const trash = await fixture.uninstall()
  await fixture.manager.permanentlyDeleteTrash(trash.id)
  expect((await fixture.saved()).installs).toMatchObject([{ root: 'agents', backup: { key: backup } }])
  expect((await fixture.saved()).installs).toHaveLength(1)
  expect(await readdir(fixture.backupRoot)).toEqual([backup])
  expect(await readFile(join(fixture.backupRoot, backup, 'SKILL.md'), 'utf8')).toBe(text('Original'))
})
it('reports failed backup cleanup without resurrecting a permanently deleted repository copy', async () => {
  const log = vi.fn<Log>(() => undefined)
  const fixture = await repositoryFixture(log)
  await fixture.update('Second')
  const backup = (await fixture.saved()).installs[0].backup!.key
  const backupPath = join(fixture.backupRoot, backup)
  const trash = await fixture.uninstall()
  const remove = fs.rm.bind(fs)
  vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
    if (path === backupPath) throw Object.assign(new Error('backup locked'), { code: 'EACCES' })
    return remove(path, options)
  })
  expect(await fixture.manager.permanentlyDeleteTrash(trash.id)).toEqual({ id: trash.id, name: 'audit-orders' })
  expect((await fixture.saved()).installs).toEqual([])
  await expect(fs.lstat(trash.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(fixture.backupRoot)).toEqual([backup])
  expect(log).toHaveBeenCalledWith('repository-backup-warning', expect.stringContaining(backupPath))
})
it('does not follow a replaced backup root during permanent deletion cleanup', async () => {
  const log = vi.fn<Log>(() => undefined)
  const fixture = await repositoryFixture(log)
  await fixture.update('Second')
  const backup = (await fixture.saved()).installs[0].backup!.key
  const trash = await fixture.uninstall()
  const outside = join(home, 'outside-backups')
  await mkdir(join(outside, backup), { recursive: true })
  await writeFile(join(outside, backup, 'keep.txt'), 'Keep local files')
  await fs.rename(fixture.backupRoot, fixture.backupRoot + '.kept')
  await fs.symlink(outside, fixture.backupRoot, process.platform === 'win32' ? 'junction' : 'dir')
  await fixture.manager.permanentlyDeleteTrash(trash.id)
  expect((await fixture.saved()).installs).toEqual([])
  expect(await readFile(join(outside, backup, 'keep.txt'), 'utf8')).toBe('Keep local files')
  expect(await readFile(join(fixture.backupRoot + '.kept', backup, 'SKILL.md'), 'utf8')).toBe(text('Original'))
  expect(log).toHaveBeenCalledWith('repository-backup-warning', expect.stringContaining(join(fixture.backupRoot, backup)))
})
it('rejects old policy documents and leaves their bytes intact', async () => {
  const current = await readManagerState()
  const old = { ...current.state, enabledSkills: undefined, categories: undefined }
  await mkdir(managerHomePath(), { recursive: true })
  const file = join(managerHomePath(), 'state.json'), raw = JSON.stringify(old)
  await writeFile(file, raw)
  expect(await readManagerState()).toMatchObject({ writable: false, warning: { code: 'warning.state.invalid' } })
  expect(await readFile(file, 'utf8')).toBe(raw)
})

it('does not automatically enable a source absent from a saved policy', async () => {
  const current = await readManagerState()
  delete current.state.sources.qoder
  delete current.state.disabledSkills.qoder
  await mkdir(managerHomePath(), { recursive: true })
  const file = join(managerHomePath(), 'state.json'), raw = JSON.stringify(current.state)
  await writeFile(file, raw)
  const result = await readManagerState()
  expect(result.writable).toBe(false)
  expect(result.state.sources.qoder).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(raw)
})

it('keeps unsupported names visible for diagnosis without exposing truncated provider names', async () => {
  const root = userRoots().find(root => root.key === 'codex')!
  for (const [directory, declared] of [['mixed', '订单-audit-orders'], ['unicode', '订单审核'], ['audit-orders', 'audit-orders'], ['中文目录', 'read-orders']]) {
    const dir = join(root.path, directory)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: ${declared}\ndescription: Review ERP orders\n---\n${directory} instructions`)
  }
  const entries = (await scanEntries(root)).entries
  expect(entries.filter(entry => !entry.loadable).map(entry => ({ name: entry.declaredName, diagnostics: entry.diagnostics.map(item => item.code) })).sort((a, b) => a.name.localeCompare(b.name))).toMatchInlineSnapshot(`
    [
      {
        "diagnostics": [
          "diagnostic.name.invalid",
        ],
        "name": "订单-audit-orders",
      },
      {
        "diagnostics": [
          "diagnostic.name.invalid",
        ],
        "name": "订单审核",
      },
    ]
  `)
  const { candidates } = await listProviderCandidates()
  expect(candidates.map(candidate => candidate.name).sort()).toEqual(['audit-orders', 'read-orders'])
  const candidate = candidates.find(candidate => candidate.name === 'audit-orders')!
  expect(await getProviderSkill(candidate)).toMatchObject({ content: 'audit-orders instructions' })
  await writeFile(join(root.path, 'audit-orders/SKILL.md'), text('Changed').replace('name: audit-orders', 'name: 订单-audit-orders'))
  expect(await getProviderSkill(candidate)).toBeUndefined()
  expect(toKebab('订单-audit-orders')).toBe('')
  expect(toKebab('Audit_Orders')).toBe('audit-orders')
})

it('rechecks native invocation policy and manager overrides after discovery', async () => {
  const root = userRoots().find(root => root.key === 'codex')!
  const file = join(root.path, 'audit-orders/SKILL.md')
  await mkdir(join(root.path, 'audit-orders'), { recursive: true })
  await writeFile(file, text('Original'))
  const candidate = (await listProviderCandidates()).candidates.find(item => item.name === 'audit-orders')!
  expect((await getProviderSkill(candidate))?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
  await writeFile(file, text('Changed').replace('description:', 'disable-model-invocation: true\nuser-invocable: false\ndescription:'))
  expect((await getProviderSkill(candidate))?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  await writeFile(file, text('Restored'))
  await setSkillEnabled(root, 'audit-orders', false)
  expect((await getProviderSkill(candidate))?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
})

it.each(['missing', 'frontmatter', 'name', 'description', 'yaml'])('revokes a registered skill after %s damage and remains disabled after restart', async damage => {
  const root = userRoots().find(root => root.key === 'codex')!
  const file = join(root.path, 'audit-orders/SKILL.md')
  await mkdir(join(root.path, 'audit-orders'), { recursive: true })
  await writeFile(file, text('Original'))
  expect(await setSkillEnabled(root, 'audit-orders', true)).toMatchObject({ enabled: true })
  const broken = damage === 'frontmatter' ? 'Broken document'
    : damage === 'name' ? text('Original').replace('audit-orders', '订单-audit-orders')
    : damage === 'description' ? text('Original').replace('description: Review ERP orders', 'description: ""')
    : '---\nname: [invalid\n---\nBroken document'
  if (damage === 'missing') await rm(file)
  else await writeFile(file, broken)
  expect(await setSkillEnabled(root, 'audit-orders', false)).toEqual({ root: 'codex', name: 'audit-orders', enabled: false })
  expect(await setSkillEnabled(root, 'audit-orders', false)).toEqual({ root: 'codex', name: 'audit-orders', enabled: false })
  expect((await readManagerState()).state).toMatchObject({ enabledSkills: { codex: [] }, disabledSkills: { codex: ['audit-orders'] } })
  if (damage === 'missing') await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  else expect(await readFile(file, 'utf8')).toBe(broken)
  expect(await setSkillEnabled(root, 'audit-orders', true)).toMatchObject({ ok: false })
  await writeFile(file, text('Repaired'))
  expect((await listProviderCandidates()).candidates.find(candidate => candidate.name === 'audit-orders')?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  expect(await setSkillEnabled(root, 'audit-orders', true)).toMatchObject({ enabled: true })
  expect((await listProviderCandidates()).candidates.find(candidate => candidate.name === 'audit-orders')?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
})

it('does not create policy records for an unknown missing skill', async () => {
  const root = userRoots().find(root => root.key === 'codex')!
  expect(await setSkillEnabled(root, 'missing', false)).toMatchObject({ ok: false, code: 'error.skill.notFound' })
  expect((await readManagerState()).state.disabledSkills.codex).toEqual([])
})
