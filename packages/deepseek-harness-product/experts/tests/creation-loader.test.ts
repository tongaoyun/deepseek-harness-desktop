/** Creation tools exercised through cordis.yml, the real Loader, ToolRuntime and native approval service. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { addAbortListener } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import type { ExpertSummary } from '../src/expert-contract.ts'
import { createTeamLibrary } from '../src/team-library.ts'
import { ExpertPackageStore } from '../src/expert-packages.ts'
import { MemorySettings } from '../src/settings-memory.ts'
import { agencySettingsSchema } from '../src/expert-library.ts'
import { createExpertLibrary, type AgencySettings } from '../src/expert-library.ts'
import { registerCreationTools } from '../src/creation-tools.ts'
import { agentSpecManifest } from '@deepseek-harness/product/company-content'
import { z } from 'zod'

let ctx: Context | undefined
let directory: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
  ctx = undefined
  directory = undefined
})
const resultSchema = z.object({ id: z.string(), name: z.string(), markdown: z.string() })
const expert = { name: 'Reviewer', description: 'Review changes', division: 'engineering', prompt: 'Review the task and report findings with evidence.' }
const team = { name: 'Review team', description: 'Review code and tests', goal: 'Find actionable defects', constraints: 'Preserve existing work', deliveryRequirements: 'Findings with evidence', tags: ['review'], examples: ['Review this change'], coordinatorTemplateId: 'technical' as const, members: [
  { expertSlug: '代码审查员', duty: 'Code', instructions: 'Check production code' },
  { expertSlug: 'Test Reviewer', duty: 'Tests', instructions: 'Check test coverage' },
] }
async function boot(loadCatalog?: (signal?: AbortSignal) => Promise<readonly ExpertSummary[]>) {
  const root = await mkdtemp(join(tmpdir(), 'harness-creation-'))
  directory = root
  const config = join(root, 'cordis.yml')
  await writeFile(config, ['projections', 'agents', 'prompt', 'tools', 'executor', 'approval', 'creation'].map(name => `- name: 'cordis:${name}'`).join('\n') + '\n')
  const context = new Context()
  ctx = context
  await context.plugin(Loader)
  Object.assign(context.loader.builtins, {
    include: Include, projections: SessionProjections, agents: AgentRegistry, prompt: SystemPrompt,
    tools: ToolRuntime, approval: UserApproval,
  })
  const settings = new MemorySettings()
  settings.register('personal', agencySettingsSchema)
  const store = { read: () => settings.get('personal') as AgencySettings, revision: () => {
    const section = settings.describe().find(item => item.ns === 'personal')
    if (!section) throw new Error('Personal settings are missing')
    return section.revision
  },
  mutate: (ops, revision) => settings.mutate('personal', ops, revision),
  } satisfies Parameters<typeof createExpertLibrary>[1]
  const members: ExpertSummary[] = [{ slug: 'engineering-reviewer', name: '代码审查员', nameEn: 'Code Reviewer', description: 'Review code', descriptionEn: '', division: 'engineering', divisionZh: '工程', emoji: '🧩', custom: false, packageVersion: '1.0.0', packageSha256: 'a'.repeat(64) }, { slug: 'testing-reviewer', name: '测试审查员', nameEn: 'Test Reviewer', description: 'Review tests', descriptionEn: '', division: 'engineering', divisionZh: '工程', emoji: '🧩', custom: false, packageVersion: '1.0.0', packageSha256: 'b'.repeat(64) }]
  const library = createExpertLibrary(loadCatalog ?? (() => Promise.resolve(members)), store, ['engineering'], () => 'en', new ExpertPackageStore(async () => join(root, 'packages')))
  const teams = createTeamLibrary(async (_sessionId, signal) => ({ all: await library.catalog(signal), shared: [] }), store, () => 'en')
  context.loader.builtins.executor = NativeExecutor
  context.loader.builtins.creation = { name: 'creation-test', inject: ['tools', 'approval'], apply: (scope: Context) => { registerCreationTools(scope, library, teams, () => 'en') } }
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await context.loader.await()
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  const scope = context.plugin(() => {})
  const id = SessionId('creation-session')
  const owner: Agent = { id, options: {}, model: { current: () => undefined, select() {} }, session: Session.create(id), ctx: scope.ctx, status: 'idle',
    inbox: {
      nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
      replace: () => false, remove: () => false, splice: () => [],
    },
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  owner.session.append('turn/start', { turn: 1 })
  await context.agents.register(owner)
  let call = 0
  const run = async (name: string, args: object, signal = new AbortController().signal) => {
    const batch = await context.tools.execute({ calls: [{ type: 'tool-call', name, arguments: JSON.stringify(args), id: ToolCallId(`creation-${++call}`) }], agent: owner, signal })
    const outcome = batch.results[0]
    return outcome.result
  }
  return { context, owner, library, teams, store, run }
}
it('saves a complete AgentSpec after native approval, rejects without approval, and unloads its tools', async () => {
  const { context, library, owner, run } = await boot()
  expect((await run('create_custom_expert', expert)).isError).toBe(true)
  expect((await library.catalog()).experts.filter(item => item.custom)).toEqual([])
  let approve = false
  const answer = context.on('approval/request', () => Promise.resolve(approve ? 'allowed-once' : 'rejected'))
  expect((await run('create_custom_expert', expert)).isError).toBe(true)
  expect((await library.catalog()).experts.filter(item => item.custom)).toEqual([])
  approve = true
  const result = await run('create_custom_expert', { ...expert, agents: 'Use {{literal}} literally.', files: [{ path: 'references/中文资料.md', content: 'Read {{literal}} unchanged.' }] })
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(JSON.stringify(result.content))
  const saved = resultSchema.parse(result.value)
  const value = await library.getCustom(saved.id)
  expect(value).toMatchObject({ name: expert.name, prompt: expert.prompt, agents: 'Use {{literal}} literally.' })
  if (!value.resources || !value.manifest) throw new Error('Saved AgentSpec package is incomplete')
  expect(Buffer.from(value.resources['references/中文资料.md'], 'base64').toString()).toBe('Read {{literal}} unchanged.')
  expect(agentSpecManifest(value.manifest).worker.suggested_name).toBe(saved.id)
  expect((await library.catalog()).enabled).toContain(saved.id)
  expect(result.content).toMatchSnapshot()
  expect(owner.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data.outcome)).toEqual(['unavailable', 'rejected', 'allowed-once'])
  expect((await run('create_custom_expert', expert)).isError).toBe(true)
  expect((await library.catalog()).experts.filter(item => item.custom)).toHaveLength(1)
  answer()
  const entry = [...context.loader.entries()].find(item => item.options.name === 'cordis:creation')
  await entry?.fiber?.dispose()
  expect(context.tools.schemas().some(tool => tool.name === 'create_custom_expert')).toBe(false)
}, 30000)
it('creates a team without an editor, freezes disabled member versions and rejects ambiguous or missing members', async () => {
  const { context, teams, run } = await boot()
  context.on('approval/request', () => Promise.resolve('allowed-once'))
  const result = await run('create_expert_team', team)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(JSON.stringify(result.content))
  const saved = resultSchema.parse(result.value)
  const snapshot = await teams.snapshot()
  expect(snapshot.enabledTeams).toContain(saved.id)
  expect(snapshot.enabledExperts).toEqual(['engineering-reviewer', 'testing-reviewer'])
  expect(snapshot.teams[0].members.map(member => [member.expertSlug, member.expertVersion, member.expertSha256])).toEqual([
    ['engineering-reviewer', '1.0.0', 'a'.repeat(64)], ['testing-reviewer', '1.0.0', 'b'.repeat(64)],
  ])
  expect(result.content).toMatchSnapshot()
  expect((await run('create_expert_team', { ...team, name: 'Ambiguous', members: [{ ...team.members[0], expertSlug: 'reviewer' }, team.members[1]] })).isError).toBe(true)
  expect((await run('create_expert_team', { ...team, name: 'Missing', members: [{ ...team.members[0], expertSlug: 'unknown' }, team.members[1]] })).isError).toBe(true)
  expect((await run('create_expert_team', { ...team, name: 'Repeated', members: [team.members[0], team.members[0]] })).isError).toBe(true)
  expect((await teams.snapshot()).teams).toHaveLength(1)
}, 30000)
it('rejects unsafe or repeated resource paths before committing a personal expert', async () => {
  const { context, library, run } = await boot()
  context.on('approval/request', () => Promise.resolve('allowed-once'))
  for (const files of [[{ path: 'references/../../outside', content: 'bad' }], [{ path: 'config/SOUL.md', content: 'bad' }], [{ path: 'references/a', content: 'one' }, { path: 'references/a', content: 'two' }]]) {
    expect((await run('create_custom_expert', { ...expert, files })).isError).toBe(true)
  }
  expect((await library.catalog()).experts.filter(item => item.custom)).toEqual([])
}, 30000)
it.each(['create_custom_expert', 'list_creation_experts', 'create_expert_team'])(
  'cancels a pending %s catalog read without committing content', async (name) => {
    const response = Promise.withResolvers<readonly ExpertSummary[]>()
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const { context, store, run } = await boot(async (signal) => {
      using _listener = signal === undefined ? undefined : addAbortListener(signal, () => { response.reject(signal.reason) })
      entered.resolve(signal)
      return await response.promise
    })
    context.on('approval/request', () => Promise.resolve('allowed-once'))
    const mutate = vi.spyOn(store, 'mutate')
    const controller = new AbortController()
    const pending = run(name, name === 'list_creation_experts' ? {} : name === 'create_expert_team' ? team : expert, controller.signal)
    try {
      const signal = await entered.promise
      controller.abort(new Error('Creation was cancelled'))
      expect(signal?.aborted).toBe(true)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('Creation was cancelled')
      expect(mutate).not.toHaveBeenCalled()
    } finally { controller.abort(); response.resolve([]); await pending }
  }, 30000,
)
it('reports a concurrent Settings change without committing a second content write', async () => {
  const { context, store, library, run } = await boot()
  context.on('approval/request', () => Promise.resolve('allowed-once'))
  const mutate = vi.spyOn(store, 'mutate').mockRejectedValueOnce(Object.assign(new Error('Concurrent edit'), { code: 'SETTINGS_CONFLICT' }))
  const result = await run('create_custom_expert', expert)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('changed in another window')
  expect((await library.catalog()).experts.filter(item => item.custom)).toEqual([])
  expect(mutate).toHaveBeenCalledOnce()
}, 30000)
