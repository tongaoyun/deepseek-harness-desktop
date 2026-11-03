/** Native and managed skill providers exercised through their real Loader composition. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Skills from '@deepseek-ai/dsh-skill'
import * as FileSkills from '@deepseek-ai/dsh-skill-filesystem'
import Sessions from '@deepseek-ai/dsh-session'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Projections from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import { promises as fs } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as ManagedSkills from './index.ts'

const user = vi.hoisted(() => ({ root: '' }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => user.root }))

async function boot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-skills-loader-')))
  user.root = root
  vi.stubEnv('DSH_HOME', join(root, '.dsh'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, '.agents'))
  vi.stubEnv('DSH_CODEX_HOME', join(root, '.codex'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, skills: Skills, filesystem: FileSkills,
    sessions: Sessions, tools: Tools, prompt: SystemPrompt, projections: Projections, directory: WorkingDirectory, fs: FileSystem,
    typert: TypertRegistry, manager: ManagedSkills })
  const config = join(root, 'cordis.yml')
  await writeFile(config, `
- name: 'cordis:skills'
- name: 'cordis:sessions'
- name: 'cordis:prompt'
- name: 'cordis:tools'
- name: 'cordis:projections'
- name: 'cordis:fs'
- name: 'cordis:directory'
- name: 'cordis:filesystem'
  config:
    watch: false
- name: 'cordis:typert'
- name: 'cordis:manager'
`)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return { ctx, root }
}

it('keeps current native policies when loading cached external candidates and disposes the manager', async () => {
  const { ctx, root } = await boot()
  const directory = join(root, '.codex', 'skills', 'audit-orders')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'SKILL.md')
  await writeFile(file, '---\nname: audit-orders # native YAML comment\ndescription: Audit orders\n---\nAllowed body\n')
  expect((await ctx.skills.get('audit-orders'))?.content).toBe('Allowed body')
  await writeFile(file, '---\nname: audit-orders\ndescription: Restricted body\ndisable-model-invocation: true\nuser-invocable: false\n---\nRestricted body\n')
  const restricted = await ctx.skills.get('audit-orders')
  expect(restricted?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  expect(restricted && { name: restricted.name, description: restricted.description,
    invocation: restricted.invocation, content: restricted.content }).toMatchSnapshot()
  const entry = [...ctx.loader.entries()].find(value => value.options.name === 'cordis:manager')
  if (!entry?.fiber) throw new Error('Manager did not load')
  await entry.fiber.dispose()
  expect(await ctx.skills.get('audit-orders')).toBeUndefined()
}, 30000)

it.each([
  { source: 'codex', operation: 'root' },
  { source: 'codex', operation: 'document' },
  { source: 'dsh', operation: 'root' },
  { source: 'dsh', operation: 'document' },
])('retries incomplete $source $operation discovery through the native registry without caching missing skills', async ({ source, operation }) => {
  const { ctx, root } = await boot()
  const directory = join(root, source === 'dsh' ? '.dsh' : '.codex', 'skills')
  const target = join(directory, 'audit-orders', 'SKILL.md')
  for (const name of ['audit-orders', 'healthy-orders']) {
    await mkdir(join(directory, name), { recursive: true })
    await writeFile(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Review orders\n---\n${name} instructions.`)
  }
  const failure = Object.assign(new Error('Transient skill I/O failure'), { code: 'EIO' })
  let failing = true
  const opendir = fs.opendir, readdir = fs.readdir, readFile = fs.readFile
  const directories = vi.spyOn(fs, 'opendir').mockImplementation(async (...args) => {
    if (failing && operation === 'root' && args[0] === directory) throw failure
    return opendir(...args)
  })
  const nativeDirectories = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
    if (failing && operation === 'root' && args[0] === directory) throw failure
    return readdir(...args)
  })
  const documents = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (failing && operation === 'document' && args[0] === target) throw failure
    return readFile(...args)
  })
  const restore = () => { directories.mockRestore(); nativeDirectories.mockRestore(); documents.mockRestore() }
  onTestFinished(restore)
  try {
    const first = await ctx.skills.snapshot()
    expect(first.complete).toBe(false)
    if (source === 'codex' && operation === 'root') expect(first.skills).toEqual([])
    else expect(first.skills.map(skill => skill.name)).toContain('healthy-orders')
    failing = false
    const recovered = await ctx.skills.snapshot()
    expect(recovered.complete).toBe(true)
    expect(recovered.skills.map(skill => skill.name)).toEqual(['audit-orders', 'healthy-orders'])
    expect((await ctx.skills.get('audit-orders'))?.content).toBe('audit-orders instructions.')
    failing = true
    const calls = [directories.mock.calls.length, nativeDirectories.mock.calls.length, documents.mock.calls.length]
    expect(await ctx.skills.snapshot()).toEqual(recovered)
    expect([directories.mock.calls.length, nativeDirectories.mock.calls.length, documents.mock.calls.length]).toEqual(calls)
  } finally { restore() }
}, 30000)

it('keeps absent optional sources and invalid skill metadata out of a complete native catalog', async () => {
  const { ctx, root } = await boot()
  const directory = join(root, '.codex', 'skills')
  await mkdir(join(directory, 'healthy-orders'), { recursive: true })
  await mkdir(join(directory, 'invalid-orders'), { recursive: true })
  await writeFile(join(directory, 'healthy-orders', 'SKILL.md'), '---\nname: healthy-orders\ndescription: Review orders\n---\nOrders instructions.')
  await writeFile(join(directory, 'invalid-orders', 'SKILL.md'), '---\nname: [invalid\n---\nInvalid metadata.')
  const claude = join(root, '.claude')
  await mkdir(claude)
  await writeFile(join(claude, 'skills'), 'Optional source is not a directory')
  const snapshot = await ctx.skills.snapshot()
  expect(snapshot.complete).toBe(true)
  expect(snapshot.skills.map(skill => skill.name)).toEqual(['healthy-orders'])
}, 30000)
