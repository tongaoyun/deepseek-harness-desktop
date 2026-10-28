import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, readFile, readdir, rm, stat, chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRepositoryManager } from './repositories.ts'
import { getProviderSkill, listProviderCandidates, managerHomePath, readManagerState, scanEntries, setSkillEnabled, toKebab, userRoots } from './core.ts'
import { selectInstallRecord } from './repository-updates.ts'

vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => process.env.DSH_HOME! }))
let home: string
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'harness-skills-state-')))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_CODEX_HOME', join(home, '.codex'))
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
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
  const candidates = await listProviderCandidates()
  expect(candidates.map(candidate => candidate.name).sort()).toEqual(['audit-orders', 'read-orders'])
  const candidate = candidates.find(candidate => candidate.name === 'audit-orders')!
  expect(await getProviderSkill(candidate)).toMatchObject({ content: 'audit-orders instructions' })
  await writeFile(join(root.path, 'audit-orders/SKILL.md'), text('Changed').replace('name: audit-orders', 'name: 订单-audit-orders'))
  expect(await getProviderSkill(candidate)).toBeUndefined()
  expect(toKebab('订单-audit-orders')).toBe('')
  expect(toKebab('Audit_Orders')).toBe('audit-orders')
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
  expect((await listProviderCandidates()).find(candidate => candidate.name === 'audit-orders')?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  expect(await setSkillEnabled(root, 'audit-orders', true)).toMatchObject({ enabled: true })
  expect((await listProviderCandidates()).find(candidate => candidate.name === 'audit-orders')?.invocation).toEqual({ modelInvocable: true, userInvocable: true })
})

it('does not create policy records for an unknown missing skill', async () => {
  const root = userRoots().find(root => root.key === 'codex')!
  expect(await setSkillEnabled(root, 'missing', false)).toMatchObject({ ok: false, code: 'error.skill.notFound' })
  expect((await readManagerState()).state.disabledSkills.codex).toEqual([])
})

it('rechecks native invocation restrictions when an external skill changes after discovery', async () => {
  const directory = join(home, '.codex', 'skills', 'audit-orders')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'SKILL.md')
  await writeFile(file, text('Original allowed body'))
  const candidate = (await listProviderCandidates()).find(value => value.name === 'audit-orders')
  if (!candidate) throw new Error('Missing external candidate')
  await writeFile(file, '---\nname: audit-orders\ndescription: Restricted skill\ndisable-model-invocation: true\nuser-invocable: false\n---\nRestricted body\n')
  expect(await getProviderSkill(candidate)).toMatchObject({
    description: 'Restricted skill', invocation: { modelInvocable: false, userInvocable: false },
  })
  await writeFile(file, '---\nname: audit-orders\ndescription: Legacy policy\nuserInvocable: false\n---\nBlocked body\n')
  const restricted = await getProviderSkill(candidate)
  expect(restricted?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  expect(restricted && { description: restricted.description, invocation: restricted.invocation }).toMatchSnapshot()
})

it('keeps manager state and repository archives private when replacing existing files', async () => {
  const root = userRoots().find(value => value.key === 'codex')!
  await mkdir(join(root.path, 'audit-orders'), { recursive: true })
  await writeFile(join(root.path, 'audit-orders', 'SKILL.md'), text('Private policy'))
  await setSkillEnabled(root, 'audit-orders', true)
  const policy = join(managerHomePath(), 'state.json')
  await chmod(policy, 0o644)
  await setSkillEnabled(root, 'audit-orders', false)
  const fetchImpl = vi.fn(async () => new Response(zipSync({ 'repo-main/skills/audit-orders/SKILL.md': strToU8(text('Private archive')) })))
  const manager = createRepositoryManager({ fetchImpl })
  const repo = await manager.add({ url: 'instudio/skills' })
  const stateFile = join(managerHomePath(), 'repositories.json')
  await chmod(stateFile, 0o644)
  await manager.refresh({ id: repo.id })
  const cache = join(managerHomePath(), 'repository-cache')
  const archives = (await readdir(cache)).filter(name => name.endsWith('.zip'))
  expect(archives).toHaveLength(1)
  if (process.platform !== 'win32') {
    for (const file of [policy, stateFile, ...archives.map(name => join(cache, name))]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
  }
  expect((await readdir(managerHomePath())).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect((await readdir(cache)).filter(name => name.endsWith('.tmp'))).toEqual([])
})
