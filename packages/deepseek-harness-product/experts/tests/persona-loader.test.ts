/** Literal personas through the real Loader, expert tools and native prompt assembly. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt, { PERSONA_PREFIX_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import * as Experts from '../src/index.ts'
import { writeExpertFixture as writePersonaFixture } from './packages.ts'
import { TEST_TEAMS } from '../src/fixtures/teams.ts'
import { createTeamAgent } from './native-team.ts'

async function runPersonaScenario(mode: 'expert' | 'team', cancel = false): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'expert-persona-loader-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const persona = 'Keep {{project}} and {{unknown}} literally.\nTemplate: {{{value}}}; incomplete: {{.\n中文与 emoji 🧩。'
  const expertsRoot = join(root, 'experts')
  await mkdir(join(expertsRoot, 'engineering'), { recursive: true })
  await writePersonaFixture(join(expertsRoot, 'engineering', 'reviewer.md'), `---\nname: Reviewer\ndescription: Review code\n---\n${persona}\n`)
  await writePersonaFixture(join(expertsRoot, 'engineering', 'tester.md'), `---\nname: Tester\ndescription: Review tests\n---\n${persona}\n`)
  const team = { ...TEST_TEAMS[0], members: ['reviewer', 'tester'].map(expertSlug => ({ expertSlug, expertVersion: '0.0.0-' + 'a'.repeat(56), expertSha256: 'a'.repeat(64), duty: 'Review', instructions: 'Report evidence' })) }
  const received: string[] = []
  const waiting = Promise.withResolvers<undefined>()
  const lateResult = Promise.withResolvers<{ output: { type: 'text'; text: string }[]; stopReason: 'completed' }>()
  const cleanup = Promise.withResolvers<undefined>()
  let disposeCalls = 0
  let activationContext = ctx
  ctx.inject(['systemPrompt', 'tools'], (scope) => { activationContext = scope })
  // Replace only child model execution; expert dispatch and prompt registrations stay real.
  ctx.provide('subagents', {
    getProvider: () => ({ capabilities: { depthLimit: true } }),
    async startActivation(spec: SubagentActivationSpec) {
      const id = spec.childId ?? SessionId('unexpected-child')
      const child = { ...createTeamAgent(ctx), id, session: Session.create(id) }
      const scope = createScope(activationContext, child)
      child.ctx = scope.ctx
      await ctx.serial('agent/created', { agent: child, source: 'startup' })
      const assembly = await ctx.systemPrompt.assemble({ scope: child, agent: child })
      const section = assembly.sections.find(value => value.name === PERSONA_PREFIX_SECTION)
      expect(section?.text).toContain(persona)
      expect(renderPrompt(assembly)).toContain(persona)
      received.push(persona)
      expect(child.ctx.tools.get('summon_expert', child)).toBeUndefined()
      if (cancel) return {
        childId: id,
        get result() { waiting.resolve(undefined); return lateResult.promise },
        async dispose() { disposeCalls += 1; await cleanup.promise; await scope.dispose() },
      }
      return { childId: id, result: Promise.resolve({ output: [{ type: 'text' as const, text: 'Reviewed' }], stopReason: 'completed' as const }),
        dispose: () => scope.dispose() }
    },
  })
  ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'agency-agents', revision: 0 }] })
  ctx.provide('webServer', {})
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, prompt: SystemPrompt, tools: Tools, executor: NativeExecutor, experts: Experts })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'cordis:prompt' }, { name: 'cordis:tools' }, { name: 'cordis:executor' },
    { name: 'cordis:experts', config: { root: expertsRoot, divisions: ['engineering'], enabled: ['reviewer', 'tester'],
      personalContentClaimed: true, personalLibraries: { local: { enabled: ['reviewer', 'tester'], customTeams: [team], enabledTeams: [team.id] } }, maxDepth: 1 } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  ctx.systemPrompt.variable('project', () => 'Resolved host variable')
  const parent = createTeamAgent(ctx)
  const name = mode === 'expert' ? 'summon_expert' : 'summon_expert_team'
  const args = mode === 'expert' ? { expert: 'Reviewer', task: 'Review' } : { team: team.id, task: 'Review' }
  const controller = new AbortController()
  if (cancel) controller.signal.addEventListener('abort', (event) => { event.stopImmediatePropagation() }, { once: true })
  const execution = ctx.tools.execute({ agent: parent, signal: controller.signal,
    calls: [{ id: ToolCallId('persona-review'), type: 'tool-call', name, arguments: JSON.stringify(args) }] })
  if (cancel) {
    try {
      await waiting.promise
      controller.abort(new Error('Parent cancelled'))
      expect(disposeCalls).toBe(1)
      lateResult.resolve({ output: [{ type: 'text', text: 'Late expert answer' }], stopReason: 'completed' })
      cleanup.resolve(undefined)
      const batch = await execution
      expect(batch.results[0].result.isError).toBe(true)
      expect(JSON.stringify(batch.results[0].result)).not.toContain('Late expert answer')
      expect(disposeCalls).toBe(1)
    } finally {
      lateResult.resolve({ output: [], stopReason: 'completed' })
      cleanup.resolve(undefined)
      await execution
    }
    return
  }
  const batch = await execution
  if (batch.results[0].result.isError) throw new Error(JSON.stringify(batch.results[0].result))
  expect(received).toEqual(mode === 'expert' ? [persona] : [persona, persona])
  expect(received).toMatchSnapshot()
  const parentAssembly = await ctx.systemPrompt.assemble({ scope: parent, agent: parent })
  expect(renderPrompt(parentAssembly)).not.toContain(persona)
  ctx.systemPrompt.section({ name: 'strict-parent-template', order: 1, text: '{{unregistered}}' })
  const strictParent = await ctx.systemPrompt.assemble({ scope: parent, agent: parent })
  expect(() => renderPrompt(strictParent)).toThrow()
  const entry = [...ctx.loader.entries()].find(value => value.options.name === 'cordis:experts')
  if (!entry?.fiber) throw new Error('Experts did not load')
  await entry.fiber.dispose()
  expect(ctx.tools.get('summon_expert')).toBeUndefined()
}

it.each(['expert', 'team'] as const)('preserves literal persona bytes for a summoned %s', async (mode) => {
  await runPersonaScenario(mode)
}, 30000)

it('cancels a loaded expert despite an earlier listener stopping propagation', async () => {
  await runPersonaScenario('expert', true)
}, 30000)
