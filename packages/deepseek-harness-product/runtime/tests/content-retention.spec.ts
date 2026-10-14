import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { prepareProductContentStorage } from '../src/content-retention.ts'
import { createTaskCapabilities } from '../src/tasks.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const content = (id: string, digit: string) => ({ id, version: '1', sha256: digit.repeat(64) })
const asContext = (value: object): Context => value as Context

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'product-retention-'))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }))
  const report = vi.fn()
  return { root, report, collect: (required: readonly string[] = []) => prepareProductContentStorage(root, report,
    async () => ({ retainedFiles: new Set(required), requiredFiles: new Set(required) })) }
}

async function generation(root: string, kind: 'skills' | 'expert-kits', identity: ReturnType<typeof content>) {
  const path = kind === 'skills' ? join(root, kind, identity.sha256, identity.id) : join(root, kind, identity.id, identity.sha256)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, '.deepseek-harness-sha256'), identity.sha256)
  await writeFile(join(path, 'instructions.md'), identity.id)
  return path
}

async function record(root: string, directory: string, name: string, value: unknown) {
  await mkdir(join(root, directory), { recursive: true })
  await writeFile(join(root, directory, name), JSON.stringify(value))
}

it('retains every employee installation and pinned skill catalog while collecting unused generations', async () => {
  const f = await fixture()
  const installed = content('installed-skill', '1')
  const historical = content('historical-skill', '2')
  const kit = content('installed-kit', '3')
  const retained = await Promise.all([generation(f.root, 'skills', installed), generation(f.root, 'skills', historical), generation(f.root, 'expert-kits', kit)])
  const unused = await Promise.all([generation(f.root, 'skills', content('unused-skill', '4')), generation(f.root, 'expert-kits', content('unused-kit', '5'))])
  await record(f.root, 'installed-skills-v1', `installed-${hash('other-employee')}.json`, [installed])
  await record(f.root, 'installed-expert-kits-v1', `installed-${hash('different-employee')}.json`, [kit])
  const snapshot = { employee: hash('employee'), skills: [historical], connectors: [] }
  const pinnedFile = `session-${hash('historical-session')}.json`
  await record(f.root, 'installed-skills-v1', pinnedFile, { ...snapshot, digest: hash(JSON.stringify(snapshot)) })
  const original = await readFile(join(f.root, 'installed-skills-v1', pinnedFile), 'utf8')
  await f.collect([join(f.root, 'installed-skills-v1', pinnedFile)])
  for (const path of retained) expect(await readFile(join(path, 'instructions.md'), 'utf8')).toBeTruthy()
  for (const path of unused) await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.root, 'installed-skills-v1', pinnedFile), 'utf8')).toBe(original)
  expect(f.report).not.toHaveBeenCalled()
})

async function taskSnapshot(root: string, kit: ReturnType<typeof content>) {
  const ctx = asContext({
    logger: { warn: vi.fn() }, sessionQuery: { listSessions: async () => [] },
    agentPresets: { defaultId: 'minimal', resolve: async () => ({ id: 'minimal', plugins: [] }),
      derive: (_base: string, definition: object) => ({ ...definition, resolutionBase: 'file:///profile/' }) },
  })
  const tasks = await createTaskCapabilities(ctx, {
    root: join(root, 'tasks-v1'), content: async () => ({ identity: kit, connectorRefs: [], knowledgeBaseRefs: [], plugins: [] }),
    connectors: async () => [], validateKnowledge: async ids => ids, connectorPlugin: () => ({ name: 'unused' }),
    knowledgePlugins: () => [], register: async () => async () => {}, validateTools: async () => {},
  })
  const prepared = await tasks.prepare({ expertKitId: kit.id })
  return join(root, 'tasks-v1', `${prepared.presetId}.json`)
}

it('retains an uninstalled kit pinned by a real task generation without changing the snapshot', async () => {
  const f = await fixture()
  const kit = content('task-kit', '6')
  const path = await generation(f.root, 'expert-kits', kit)
  const snapshotPath = await taskSnapshot(f.root, kit)
  const snapshot = await readFile(snapshotPath, 'utf8')
  const unused = await generation(f.root, 'expert-kits', content(kit.id, '7'))
  await f.collect([snapshotPath])
  expect(await readFile(join(path, 'instructions.md'), 'utf8')).toBe(kit.id)
  expect(await readFile(snapshotPath, 'utf8')).toBe(snapshot)
  await expect(readdir(unused)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.report).not.toHaveBeenCalled()
})

it.each([false, true])('collects valid orphan snapshots but preserves task diagnostics: diagnostic=%s', async (diagnostic) => {
  const f = await fixture()
  const kit = content('orphan-kit', '6')
  const kitPath = await generation(f.root, 'expert-kits', kit)
  const taskPath = await taskSnapshot(f.root, kit)
  if (diagnostic) await writeFile(`${taskPath}.diagnostic.json`, 'original diagnostic')
  const skill = content('orphan-skill', '7')
  const skillPath = await generation(f.root, 'skills', skill)
  const pinned = { employee: hash('employee'), skills: [skill], connectors: [] }
  const skillFile = `session-${hash('deleted-session')}.json`
  await record(f.root, 'installed-skills-v1', skillFile, { ...pinned, digest: hash(JSON.stringify(pinned)) })
  await f.collect()
  await expect(readFile(join(f.root, 'installed-skills-v1', skillFile))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
  if (diagnostic) {
    expect(await readFile(`${taskPath}.diagnostic.json`, 'utf8')).toBe('original diagnostic')
    expect(await readFile(taskPath, 'utf8')).toContain(kit.id)
    expect(await readFile(join(kitPath, 'instructions.md'), 'utf8')).toBe(kit.id)
  } else {
    await expect(readFile(taskPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(kitPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(f.report).not.toHaveBeenCalled()
})

it.each(['invalid-json', 'invalid-digest', 'invalid-task', 'missing-task', 'unavailable-history', 'oversized-record'])
('preserves all content and diagnostics when references are uncertain: %s', async (kind) => {
  const f = await fixture()
  const path = await generation(f.root, 'skills', content('unused-skill', '8'))
  const directory = join(f.root, 'tasks-v1')
  await mkdir(directory)
  const snapshotPath = join(directory, `product-task-${'a'.repeat(64)}.json`)
  const diagnosticPath = `${snapshotPath}.diagnostic.json`
  await writeFile(diagnosticPath, 'original diagnostic')
  let requiredFiles: Parameters<typeof prepareProductContentStorage>[2] = async () => ({
    retainedFiles: new Set(), requiredFiles: new Set(),
  })
  if (kind === 'invalid-json' || kind === 'oversized-record') {
    const recordPath = join(f.root, 'installed-skills-v1')
    await mkdir(recordPath)
    await writeFile(join(recordPath, `installed-${hash('employee')}.json`), kind === 'invalid-json' ? '{broken' : 'x'.repeat(8 * 1024 * 1024 + 1))
  } else if (kind === 'invalid-digest') {
    await record(f.root, 'installed-skills-v1', `session-${hash('session')}.json`, {
      employee: 'employee', skills: [], connectors: [], digest: 'a'.repeat(64),
    })
  } else if (kind === 'invalid-task') await writeFile(snapshotPath, '{"version":2}')
  else if (kind === 'missing-task') requiredFiles = async () => ({ retainedFiles: new Set([snapshotPath]), requiredFiles: new Set([snapshotPath]) })
  else requiredFiles = async () => { throw new Error('Session history unavailable') }
  await prepareProductContentStorage(f.root, f.report, requiredFiles)
  expect(await readFile(join(path, 'instructions.md'), 'utf8')).toBe('unused-skill')
  expect(await readFile(diagnosticPath, 'utf8')).toBe('original diagnostic')
  expect(f.report).toHaveBeenCalledWith(expect.stringContaining('collection stopped'))
})

it('preserves unmanaged directories and damaged markers while removing abandoned managed stages', async () => {
  const f = await fixture()
  const damaged = await generation(f.root, 'skills', content('damaged-skill', '9'))
  await writeFile(join(damaged, '.deepseek-harness-sha256'), 'a'.repeat(64))
  const unknown = join(f.root, 'skills', 'my-files')
  await mkdir(unknown)
  await writeFile(join(unknown, 'keep.txt'), 'keep')
  const unmanagedStage = join(unknown, 'custom.installing-123-abc')
  await mkdir(unmanagedStage)
  await writeFile(join(unmanagedStage, 'keep.txt'), 'unmanaged')
  const stage = `${damaged}.installing-123-abc`
  await mkdir(stage)
  await writeFile(join(stage, 'partial.txt'), 'partial')
  const missing = await generation(f.root, 'expert-kits', content('missing-marker', 'a'))
  await rm(join(missing, '.deepseek-harness-sha256'))
  await f.collect()
  expect(await readFile(join(damaged, 'instructions.md'), 'utf8')).toBe('damaged-skill')
  expect(await readFile(join(unknown, 'keep.txt'), 'utf8')).toBe('keep')
  expect(await readFile(join(unmanagedStage, 'keep.txt'), 'utf8')).toBe('unmanaged')
  expect(await readFile(join(missing, 'instructions.md'), 'utf8')).toBe('missing-marker')
  await expect(readdir(stage)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves linked generations and never removes their targets', async () => {
  const f = await fixture()
  const external = join(f.root, 'external')
  await mkdir(external)
  await writeFile(join(external, 'keep.txt'), 'external')
  const linked = await generation(f.root, 'skills', content('linked-skill', 'b'))
  await symlink(external, join(linked, 'resources'), process.platform === 'win32' ? 'junction' : 'dir')
  await mkdir(join(f.root, 'expert-kits', 'linked-kit'), { recursive: true })
  await symlink(external, join(f.root, 'expert-kits', 'linked-kit', 'c'.repeat(64)), process.platform === 'win32' ? 'junction' : 'dir')
  await f.collect()
  expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('external')
  expect(await readFile(join(linked, 'instructions.md'), 'utf8')).toBe('linked-skill')
})

it.each(['malformed-record', 'linked-directory'])('blocks initialization when process ownership is uncertain: %s', async (kind) => {
  const f = await fixture()
  const path = await generation(f.root, 'skills', content('unused-skill', 'e'))
  const owners = join(f.root, 'content-owners')
  if (kind === 'malformed-record') {
    await mkdir(owners)
    await writeFile(join(owners, 'unknown.owner'), '')
  } else {
    const external = join(f.root, 'external')
    await mkdir(external)
    await writeFile(join(external, 'keep.txt'), 'external')
    await symlink(external, owners, process.platform === 'win32' ? 'junction' : 'dir')
  }
  await expect(f.collect()).rejects.toThrow(kind === 'malformed-record' ? 'ownership record' : 'regular directory')
  expect(await readFile(join(path, 'instructions.md'), 'utf8')).toBe('unused-skill')
})

async function childOwner(root: string, hold: boolean) {
  const fixture = fileURLToPath(new URL('./fixtures/content-owner.ts', import.meta.url))
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx/esm', fixture, root, hold ? 'hold' : 'once'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let diagnostic = ''
  child.stderr?.on('data', (chunk) => { diagnostic += String(chunk) })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => { resolve() })
  })
  onTestFinished(async () => { child.kill('SIGKILL'); await exited })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => { resolve() })
      child.once('error', reject)
      child.once('close', (code) => { reject(new Error(`Content owner exited before readiness (${code}): ${diagnostic}`)) })
      timer = setTimeout(() => { reject(new Error(`Content owner readiness timeout: ${diagnostic}`)) }, 10_000)
    })
  } finally { clearTimeout(timer) }
  return { child, exited }
}

it('defers collection across concurrent Host processes and reclaims after forced owner exit', async () => {
  const f = await fixture()
  const first = await childOwner(f.root, true)
  const contentPath = await generation(f.root, 'skills', content('in-flight-skill', 'd'))
  const second = await childOwner(f.root, false)
  await second.exited
  expect(await readFile(join(contentPath, 'instructions.md'), 'utf8')).toBe('in-flight-skill')
  first.child.kill('SIGKILL')
  await first.exited
  const restarted = await childOwner(f.root, false)
  await restarted.exited
  await expect(readdir(contentPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(join(f.root, 'content-owners'))).toEqual([`${restarted.child.pid}.owner`])
}, 40_000)
