/** Creation tools exercised through cordis.yml, the real Loader, ToolRuntime and native question service. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
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
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import type { ExpertSummary } from './expert-contract.ts'
import { createDrafts } from './creation.ts'
import { createExpertLibrary, type AgencySettings } from './expert-library.ts'
import { registerCreationTools } from './creation-tools.ts'
import { z } from 'zod'

let ctx: Context | undefined
let directory: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (directory) await rm(directory, { recursive: true, force: true })
  ctx = undefined
  directory = undefined
})
const resultSchema = z.object({ proposalId: z.uuid(), ready: z.boolean(), markdown: z.string() })
const expert = { name: 'Reviewer', description: 'Review changes', division: 'engineering', prompt: 'Review the task and report findings with evidence.' }
async function boot() {
  directory = await mkdtemp(join(tmpdir(), 'harness-creation-'))
  const config = join(directory, 'cordis.yml')
  await writeFile(config, ['projections', 'agents', 'prompt', 'tools', 'executor', 'questions', 'creation'].map(name => `- name: 'cordis:${name}'`).join('\n') + '\n')
  const context = new Context()
  ctx = context
  await context.plugin(Loader)
  Object.assign(context.loader.builtins, {
    include: Include, projections: SessionProjections, agents: AgentRegistry, prompt: SystemPrompt,
    tools: ToolRuntime, questions: UserQuestions,
  })
  const drafts = createDrafts()
  const saved: AgencySettings = { enabled: [] }
  const members: ExpertSummary[] = [{ slug: 'engineering-reviewer', name: '代码审查员', nameEn: 'Code Reviewer', description: 'Review code', descriptionEn: '', division: 'engineering', divisionZh: '工程', emoji: '🧩', custom: false }, { slug: 'testing-reviewer', name: '测试审查员', nameEn: 'Test Reviewer', description: 'Review tests', descriptionEn: '', division: 'engineering', divisionZh: '工程', emoji: '🧩', custom: false }]
  const library = createExpertLibrary(() => Promise.resolve(members), {
    read: () => saved, revision: () => 0,
    mutate: () => Promise.reject(new Error('Creation tools must never persist content')),
  }, ['engineering'], () => 'en')
  context.loader.builtins.executor = NativeExecutor
  context.loader.builtins.creation = { name: 'creation-test', inject: ['tools', 'userQuestions'], apply: (scope: Context) => { registerCreationTools(scope, drafts, library, () => 'en') } }
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
  await context.agents.register(owner)
  let call = 0
  const run = async (name: string, args: object, signal = new AbortController().signal) => {
    const batch = await context.tools.execute({ calls: [{ type: 'tool-call', name, arguments: JSON.stringify(args), id: ToolCallId(`creation-${++call}`) }], agent: owner, signal })
    const outcome = batch.results[0]
    return outcome.result
  }
  return { context, drafts, owner, saved, run }
}
it('keeps previews unsaved, requires native approval, and confirms only the reviewed proposal', async () => {
  const { context, drafts, owner, saved, run } = await boot()
  const preview = await run('propose_custom_expert', expert)
  expect(preview.isError).toBe(false)
  if (preview.isError) throw new Error(JSON.stringify(preview.content))
  const proposed = resultSchema.parse(preview.value)
  expect(proposed.ready).toBe(false)
  expect(drafts.claim(owner.session.id, proposed.proposalId)).toBeUndefined()
  const unavailable = await run('open_custom_expert_editor', { proposalId: proposed.proposalId })
  expect(unavailable.isError).toBe(true)
  let approve = false
  const disposeAnswer = context.on('user-questions/request', request => Promise.resolve({
    answers: [{ id: request.questions[0].id, selected: [request.questions[0].options?.[approve ? 0 : 1]?.label ?? ''] }],
  }))
  const declined = await run('open_custom_expert_editor', { proposalId: proposed.proposalId })
  expect(declined.isError).toBe(false)
  if (!declined.isError) expect(resultSchema.parse(declined.value).ready).toBe(false)
  expect(drafts.claim(owner.session.id, proposed.proposalId)).toBeUndefined()
  approve = true
  const confirmed = await run('open_custom_expert_editor', { proposalId: proposed.proposalId })
  expect(confirmed.isError).toBe(false)
  if (!confirmed.isError) expect(confirmed.meta).toEqual({ ready: true, proposalId: proposed.proposalId })
  expect(drafts.claim(owner.session.id, proposed.proposalId)?.data.name).toBe(expert.name)
  expect(saved).toEqual({ enabled: [] })
  expect(proposed.markdown).toMatchSnapshot()
  disposeAnswer()
  const entry = [...context.loader.entries()].find(item => item.options.name === 'cordis:creation')
  await entry?.fiber?.dispose()
  expect(context.tools.schemas().some(tool => tool.name === 'propose_custom_expert')).toBe(false)
}, 30000)
it('does not confirm a replacement draft from an old native question, and honors cancellation', async () => {
  const { context, drafts, owner, run } = await boot()
  const preview = await run('propose_custom_expert', expert)
  if (preview.isError) throw new Error(JSON.stringify(preview.content))
  const proposalId = resultSchema.parse(preview.value).proposalId
  context.on('user-questions/request', (request) => {
    drafts.save(owner.session.id, { kind: 'expert', data: { ...expert, name: 'Replacement' } })
    return Promise.resolve({ answers: [{ id: request.questions[0].id, selected: [request.questions[0].options?.[0]?.label ?? ''] }] })
  })
  const stale = await run('open_custom_expert_editor', { proposalId })
  expect(stale.isError).toBe(true)
  expect(drafts.claim(owner.session.id, proposalId)).toBeUndefined()
  const abort = new AbortController(); abort.abort()
  expect((await run('propose_custom_expert', expert, abort.signal)).isError).toBe(true)
}, 30000)

it('creates a team from disabled members by Chinese and English names and rejects ambiguous or duplicate choices', async () => {
  const { drafts, owner, run } = await boot()
  const input = { name: 'Review team', description: 'Review code and tests', goal: 'Find actionable defects', constraints: 'Preserve existing work', deliveryRequirements: 'Findings with evidence', tags: ['review'], examples: ['Review this change'], coordinatorTemplateId: 'technical', members: [
    { expertSlug: '代码审查员', duty: 'Code', instructions: 'Check production code' },
    { expertSlug: 'Test Reviewer', duty: 'Tests', instructions: 'Check test coverage' },
  ] }
  const result = await run('propose_expert_team', input)
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error(JSON.stringify(result.content))
  const proposed = resultSchema.parse(result.value)
  const draft = drafts.get(owner.session.id, proposed.proposalId)
  expect(draft?.kind).toBe('team')
  if (draft?.kind !== 'team') throw new Error('Team draft missing')
  expect(draft.data.members.map(member => member.expertSlug)).toEqual(['engineering-reviewer', 'testing-reviewer'])
  expect(proposed.markdown).toMatchSnapshot()
  expect((await run('open_custom_expert_editor', { proposalId: proposed.proposalId })).isError).toBe(true)
  const ambiguous = await run('propose_expert_team', { ...input, members: [{ ...input.members[0], expertSlug: 'reviewer' }, input.members[1]] })
  expect(ambiguous.isError).toBe(true)
  expect(JSON.stringify(ambiguous.content)).toContain('engineering-reviewer')
  expect(JSON.stringify(ambiguous.content)).toContain('testing-reviewer')
  expect((await run('propose_expert_team', { ...input, members: [input.members[0], input.members[0]] })).isError).toBe(true)
}, 30000)
