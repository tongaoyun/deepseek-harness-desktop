import { createTestContext } from '../tests/context.ts'
import { createActivationProbe } from '../tests/activation-probe.ts'
import { publishedTeamDocument } from '@deepseek-harness/product/company-team'
import { TEST_TEAMS } from './fixtures/teams.ts'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { createNativeTeam, createTeamAgent } from '../tests/native-team.ts'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply } from './index.ts'
import AgencyAgentsRemote from './remote.ts'
import { MemorySettings } from './settings-memory.ts'
class TestSettings extends MemorySettings {
  protected async persist(
    _ns: SettingsNamespace,
    _section: Record<string, unknown>,
  ): Promise<void> {}
}

function volatileConfig(settings: TestSettings) {
  settings.register('agency-agents', (value) => value)
  const read = () => (settings.get('agency-agents') ?? {}) as {
    enabled?: string[]
    customExperts?: unknown[]
    customTeams?: unknown[]
    enabledTeams?: string[]
  }
  return {
    enabled: { get: () => read().enabled ?? [] },
    customExperts: { get: () => read().customExperts ?? [] },
    customTeams: { get: () => read().customTeams ?? [] },
    enabledTeams: { get: () => read().enabledTeams ?? [] },
  }
}
describe('专家团宿主与远端集成', () => {
  it('个人团队创建、启用、主理人规则、三人委派、子会话隔离与停用', async () => {
    const settings = new TestSettings(new Context())
    settings.restore({ 'agency-agents': { enabled: [] }, locale: { preference: 'zh' } })
    settings.register('locale', value => value)
    const services = new Map<string, unknown>()
    const tools = new Map<
      string,
      { execute(args: unknown, exec?: unknown): Promise<unknown> }
    >()
    const starts: Record<string, unknown>[] = []
    const probe = createActivationProbe()
    const ctx = createTestContext({
      settings,
      effect: () => () => {},
      inject: (_deps: unknown, callback: (ctx: unknown) => void) =>
        callback(ctx),
      reflect: {
        provide: (key: string, value: unknown) => services.set(key, value),
      },
      get: (key: string) => services.get(key),
      typert: { register: () => {} },
      tools: {
        register: (tool: {
          name: string
          execute(args: unknown, exec?: unknown): Promise<unknown>
        }) => tools.set(tool.name, tool),
      },
      systemPrompt: { section: () => {} },
      on: probe.on,
      subagents: {
        getProvider: () => ({
          capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true },
        }),
        startActivation: async (spec: { childId: string; request: Record<string, unknown>; label: string }) => {
          probe.create(spec)
          starts.push({ ...spec.request, label: spec.label })
          return {
            result: Promise.resolve({
              output: [{ type: 'text', text: '租赁建议' }],
              stopReason: 'completed',
            }),
            dispose: async () => {},
          }
        },
      },
    })
    apply(ctx, { root: fileURLToPath(new URL('../../../../vendor/product-expert-fixtures/agency-agents', import.meta.url)), provider: 'spawn', divisions: ['product', 'design', 'engineering'], ...volatileConfig(settings) } as never)
    const remote = new AgencyAgentsRemote(ctx)
    expect((await remote.getTeams(new AbortController().signal)).teams).toEqual([])
    const { id: _fixtureId, ...firstDraft } = TEST_TEAMS[0]
    const initial = await remote.saveTeam(firstDraft, false, 0)
    expect(initial.teams).toHaveLength(1)
    expect(initial.nativeMembers ?? {}).toEqual({})
    const catalog = await remote.getCatalog(false, new AbortController().signal)
    for (const group of initial.teams) {
      for (const member of group.members) {
        expect(catalog.experts.some(expert => expert.slug === member.expertSlug && !expert.conflict)).toBe(true)
      }
    }
    const team = initial.teams[0]
    const exported = await remote.exportTeam(team.id, initial.revision)
    expect(exported.resourceKey).toMatch(/^teams\//)
    const document = publishedTeamDocument(Buffer.from(Object.values(exported.files)[0], 'base64').toString('utf8'))
    expect(document.experts).toHaveLength(team.members.length)
    expect(document.team.members.map(member => member.expertSlug)).toEqual(document.experts.map(expert => expert.key))
    expect(JSON.stringify(document)).not.toContain(team.members[0].expertSlug)
    await expect(remote.exportTeam(team.id, initial.revision + 1)).rejects.toThrow('已更新')
    let companyRevision = 0
    services.set('companyContent', { read: async () => ({ sha256: String(companyRevision++) }) })
    await expect(remote.exportTeam(team.id, initial.revision)).rejects.toThrow('已更新')
    services.delete('companyContent')
    const enabled = await remote.setTeamEnabled(team.id, true, initial.revision)
    expect(enabled.enabledExperts).toEqual(
      expect.arrayContaining(team.members.map((m) => m.expertSlug)),
    )
    const invoke = async (
      name: string,
      args: unknown,
      exec: unknown = { agent: createTeamAgent() },
    ) => {
      const result = (await tools.get(name)!.execute(args, exec)) as {
        report: string
      }
      return JSON.parse(result.report)
    }
    expect(await invoke('list_expert_teams', {})).toHaveLength(1)
    expect(await invoke('get_expert_team', { team: team.id })).toMatchObject({
      id: team.id,
      coordinator: expect.stringContaining('处理分歧'),
      collaboration: { preparation: expect.any(Array), reviewChecklist: expect.any(Array) },
    })
    const report = await invoke('summon_expert_team', {
      team: team.id,
      task: '评审当前需求的价值与实现边界',
    })
    expect(report.results).toHaveLength(3)
    expect(report.coverage).toMatchObject({ status: 'complete', completed: 3, total: 3 })
    expect(report.results.every((result: { ok: boolean }) => result.ok)).toBe(
      true,
    )
    expect(starts).toHaveLength(3)
    expect(starts.map(start => start.label)).toEqual(team.members.map(member => catalog.experts.find(expert => expert.slug === member.expertSlug)!.name))
    expect(probe.sections).toHaveLength(3)
    expect(probe.restrictions).toHaveLength(3)
    expect(probe.listening).toBe(0)
    for (const [index, start] of starts.entries()) {
      expect(probe.sections[index]?.text).toEqual(expect.any(String))
      expect(start.prompt).toEqual([{ type: 'text', text: expect.stringContaining('交接给主理人') }])
      expect(probe.restrictions[index]).toMatchObject({
        deny: expect.arrayContaining([
          'summon_expert_team',
          'summon_expert',
          'summon_experts',
        ]),
      })
    }
    await expect(
      invoke(
        'summon_expert_team',
        { team: team.id, task: '递归' },
        { agent: { session: { header: { parentSession: 'parent' } } } },
      ),
    ).rejects.toThrow('专家成员')
    await expect(
      remote.setTeamEnabled(team.id, false, initial.revision),
    ).rejects.toThrow()
    await remote.setTeamEnabled(team.id, false, enabled.revision)
    await expect(
      invoke('summon_expert_team', { team: team.id, task: '再次运行' }),
    ).rejects.toThrow('未启用')
    expect(starts).toHaveLength(3)
    const { id: _id, ...draft } = team
    const before = await remote.getTeams(new AbortController().signal)
    const custom = await remote.saveTeam({ ...draft, name: '自定义验收团', coordinatorMode: 'custom', coordinatorPrompt: '优先输出反证和待确认事项。' }, true, before.revision)
    const saved = custom.teams.find(group => group.name === '自定义验收团')!
    const customReport = await invoke('summon_expert_team', { team: saved.id, task: '评审配置变更' })
    expect(customReport.coordinator).toBe('优先输出反证和待确认事项。')
    expect(customReport.results).toHaveLength(3)
    const deleted = await remote.deleteTeam(saved.id, custom.revision)
    expect(deleted.enabledExperts).toEqual(custom.enabledExperts)
    await expect(invoke('get_expert_team', { team: saved.id })).rejects.toThrow('未启用')
    const latest = await remote.getTeams(new AbortController().signal)
    await remote.setTeamEnabled(team.id, true, latest.revision)
    const { service: native } = createNativeTeam()
    services.set('agentTeams', native)
    expect((await remote.getTeams(new AbortController().signal)).engine).toMatchObject({ state: 'enabled', mode: 'native' })
    const notReady = await invoke('get_expert_team', { team: team.id })
    expect(notReady.engine).toMatchObject({ state: 'disabled', mode: 'subagent', recommendation: expect.stringContaining('开启') })
    const priorStarts = starts.length
    const nativeReport = await invoke('summon_expert_team', { team: team.id, task: '评审整体方案' }, {
      agent: createTeamAgent(createTestContext({ get: (key: string) => key === 'tools' ? { get: () => ({}) } : undefined })), signal: new AbortController().signal,
    })
    expect(nativeReport.engine).toMatchObject({ state: 'enabled', mode: 'native' })
    expect(nativeReport.dispatch.started).toBe(3)
    expect(nativeReport).not.toHaveProperty('coverage')
    expect(starts).toHaveLength(priorStarts)
    expect(native.spawnTeammate).toHaveBeenCalledTimes(3)
  })
})
