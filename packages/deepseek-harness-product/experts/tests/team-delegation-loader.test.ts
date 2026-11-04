/** Expert-team delegation limits through the Loader, native loop and executor. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Include from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import WorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import * as WorkflowTool from '@deepseek-ai/dsh-tool-workflow'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as Experts from '../src/index.ts'
import { writeExpertFixture as writePersonaFixture } from './packages.ts'
import { TEST_TEAMS } from '../src/fixtures/teams.ts'

class DelegatingAdapter extends LlmAdapter {
  readonly advertised: boolean[] = []
  private readonly attempted = new Map<string, number>()

  constructor(private readonly ctx: Context, private readonly tool: string, private readonly attempts: number) { super() }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const session = options.sessionId === undefined ? undefined : this.ctx.agents.get(options.sessionId)?.session
    const attempted = session === undefined ? 0 : this.attempted.get(session.id) ?? 0
    if (session?.header.delegationDepth === 1 && attempted < this.attempts) {
      this.attempted.set(session.id, attempted + 1)
      this.advertised.push(options.tools?.some(tool => tool.name === this.tool) ?? false)
      const id = ToolCallId('nested-review')
      const args = JSON.stringify(this.tool === 'workflow'
        ? { script: 'return await agent("Review independently")', meta: { name: 'nested-review', description: 'Nested review' } }
        : { prompt: 'Review independently', description: 'Nested review' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: this.tool, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: this.tool, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Reviewed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Reviewed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Deterministic external program provider; native workflow child dispatch remains real. */
class WorkflowProgram extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  runs = 0

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 30000 }
  }

  async run(request: PtcRunSpec): Promise<PtcRunResult> {
    this.runs += 1
    const host = request.bindings[0].functions
    const init = await host.begin({})
    expect(init).toMatchObject({ body: 'return await agent("Review independently")' })
    const child = await host.startChild({ prompt: 'Review independently' })
    await host.childResult(child)
    await host.disposeChild(child)
    return { logs: [], value: { value: 'Reviewed', stopReason: 'completed', agentsStarted: 1 } }
  }
}

describe.each(['global', 'preset', 'shadow'] as const)('%s native tool registration', (registration) => {
  const cases = [
    ['team', 'subagent'], ['team', 'subagent_fork'],
    ['expert', 'subagent'], ['expert', 'subagent_fork'],
  ] as const
  it.each(registration === 'preset'
    ? [...cases, ['team', 'workflow'] as const, ['expert', 'workflow'] as const] : cases)('%s enforces its delegation policy for native %s at depth 2', async (mode, tool) => {
    const root = await mkdtemp(join(tmpdir(), 'expert-delegation-loader-'))
    const ctx = new Context()
    onTestFinished(async () => {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    })
    const expertsRoot = join(root, 'experts')
    await mkdir(join(expertsRoot, 'engineering'), { recursive: true })
    for (const name of ['reviewer', 'tester']) {
      await writePersonaFixture(join(expertsRoot, 'engineering', `${name}.md`), `---\nname: ${name}\ndescription: Review code\n---\nReview the assigned task.\n`)
    }
    const team = { ...TEST_TEAMS[0], members: ['reviewer', 'tester'].map(expertSlug => ({ expertSlug, expertVersion: '0.0.0-' + 'a'.repeat(56), expertSha256: 'a'.repeat(64), duty: 'Review', instructions: 'Report evidence' })) }
    ctx.provide('settings', { configure: () => () => {}, describe: () => [{ ns: 'agency-agents', revision: 0 }] })
    ctx.provide('webServer', {})
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include, presets: AgentPresets, preset: AgentPreset, llm: LlmRuntime, sessions: SessionStore, persistence: JsonlPersistence,
      projections: SessionProjections, fs: FsLocal, workingDirectory: WorkingDirectory,
      prompt: SystemPrompt, tools: Tools, executor: NativeExecutor,
      agents: AgentRegistry, loop: AgentLoop, subagents: Subagents,
      spawn: Spawn, fork: Fork, subagentTool: SubagentTool, experts: Experts,
      sandboxPolicy: SandboxPolicy, workflowRuntime: WorkflowProgram, workflowEngine: WorkflowEngine, workflowTool: WorkflowTool,
    })
    const delegationPlugins = [
      { name: 'cordis:subagentTool', config: { provider: 'spawn', toolName: 'subagent' } },
      { name: 'cordis:subagentTool', config: { provider: 'fork', toolName: 'subagent_fork' } },
      ...(tool === 'workflow' ? [{ name: 'cordis:workflowTool' }] : []),
    ]
    const config = join(root, 'cordis.yml')
    await writeFile(config, JSON.stringify([
      { name: 'cordis:llm' }, { name: 'cordis:sessions' },
      { name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: 'cordis:projections' }, { name: 'cordis:prompt' },
      { name: 'cordis:fs', config: { cwd: root } },
      { name: 'cordis:workingDirectory', config: { defaultDirectory: root } },
      { name: 'cordis:tools' }, { name: 'cordis:executor' },
      { name: 'cordis:agents' }, { name: 'cordis:loop', config: { agents: [] } },
      { name: 'cordis:subagents', config: { maxDepth: 2 } },
      { name: 'cordis:spawn' }, { name: 'cordis:fork' },
      ...(tool === 'workflow' ? [
        { name: 'cordis:sandboxPolicy', config: { mode: 'danger-full-access', workspaceRoot: root } },
        { name: 'cordis:workflowRuntime' }, { name: 'cordis:workflowEngine' },
      ] : []),
      ...(registration === 'global' ? delegationPlugins : [
        { name: 'cordis:presets', config: { default: 'standard' } },
        { name: 'cordis:preset', config: { id: 'standard', plugins: delegationPlugins } },
      ]),
      { name: 'cordis:experts', config: { root: expertsRoot, divisions: ['engineering'],
        enabled: ['reviewer', 'tester'], personalContentClaimed: true, personalLibraries: { local: { enabled: ['reviewer', 'tester'], customTeams: [team], enabledTeams: [team.id] } }, maxDepth: 2 } },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const attempts = registration === 'shadow' ? 2 : 1
    const adapter = new DelegatingAdapter(ctx, tool, attempts)
    ctx.llm.registerAdapter(['probe'], adapter)
    const members: string[] = []
    const grandchildren: string[] = []
    const outcomes: { isError: boolean; message?: string }[] = []
    const shadowed = new Set<string>()
    ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.delegationDepth === 1) members.push(agent.id)
      if (agent.session.header.delegationDepth === 2) grandchildren.push(agent.id)
    })
    ctx.on('tools/result', (exec, result) => {
      if (exec.name === tool && exec.agent?.session.header.delegationDepth === 1) {
        outcomes.push({ isError: result.isError, ...(result.isError ? { message: result.error.message } : {}) })
        if (registration === 'shadow' && !shadowed.has(exec.agent.id)) {
          const definition = exec.agent.ctx.tools.get(tool, exec.agent)
          if (definition === undefined) throw new Error('Scoped native tool is missing')
          exec.agent.ctx.tools.register(definition)
          shadowed.add(exec.agent.id)
        }
      }
    })
    const { agent: parent } = await ctx.agents.create({ sessionId: SessionId('delegation-parent'),
      agentOptions: { provider: 'probe', model: 'probe' }, meta: { cwd: root },
      ...(registration === 'global' ? {} : { setup: async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx) } }),
    })
    expect(ctx.tools.get(tool) !== undefined).toBe(registration === 'global')
    expect(parent.ctx.tools.get(tool, parent)).toBeDefined()
    ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    const name = mode === 'team' ? 'summon_expert_team' : 'summon_expert'
    const args = mode === 'team' ? { team: team.id, task: 'Review' } : { expert: 'reviewer', task: 'Review' }
    const batch = await ctx.tools.execute({ agent: parent, signal: new AbortController().signal,
      calls: [{ id: ToolCallId('review'), type: 'tool-call', name, arguments: JSON.stringify(args) }] })
    expect(batch.results[0].result.isError, JSON.stringify(batch.results[0].result)).toBe(false)
    const count = mode === 'team' ? 2 : 1
    expect(members).toHaveLength(count)
    expect.soft(outcomes, JSON.stringify(batch.results[0].result)).toEqual(Array.from({ length: count * attempts }, () => mode === 'team'
      ? { isError: true, message: 'Team members cannot create subagents or expand the team. Report gaps to the coordinator.' } : { isError: false }))
    expect.soft(grandchildren).toHaveLength(mode === 'team' ? 0 : attempts)
    expect.soft(adapter.advertised).toEqual(Array.from({ length: count * attempts }, () => true))
    expect.soft(shadowed.size).toBe(registration === 'shadow' ? count : 0)
    if (tool === 'workflow') expect.soft(ctx.ptcRuntime).toMatchObject({ runs: mode === 'team' ? 0 : 1 })
  }, 30000)
})
