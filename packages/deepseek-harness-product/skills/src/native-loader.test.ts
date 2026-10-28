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
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as ManagedSkills from './index.ts'

const user = vi.hoisted(() => ({ root: '' }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => user.root }))

it('keeps current native policies when loading cached external candidates and disposes the manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-skills-loader-'))
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
    sessions: Sessions, tools: Tools, prompt: SystemPrompt, server: WebServer, typert: TypertRegistry, manager: ManagedSkills })
  const config = join(root, 'cordis.yml')
  await writeFile(config, `
- name: 'cordis:skills'
- name: 'cordis:sessions'
- name: 'cordis:prompt'
- name: 'cordis:tools'
- name: 'cordis:server'
  config:
    port: 0
    host: 127.0.0.1
- name: 'cordis:filesystem'
  config:
    watch: false
- name: 'cordis:typert'
- name: 'cordis:manager'
`)
  const directory = join(root, '.codex', 'skills', 'audit-orders')
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'SKILL.md')
  await writeFile(file, '---\nname: audit-orders # native YAML comment\ndescription: Audit orders\n---\nAllowed body\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
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
