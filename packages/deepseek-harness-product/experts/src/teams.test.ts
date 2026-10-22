import { TEST_TEAMS } from './fixtures/teams.ts'
import { describe, it, expect, vi } from 'vitest'
import {
  teamInputSchema,
  effectiveCoordinator,
} from './team-contract.ts'
import { createTeamLibrary } from './team-library.ts'
import { executeTeam, TEAM_TASK_MAX_CHARS } from './team-runtime.ts'
import {
  validateAgencySettings,
  type AgencySettings,
} from './expert-library.ts'
import type { ExpertSummary } from './expert-contract.ts'

const experts: ExpertSummary[] = [
  ...new Set(TEST_TEAMS.flatMap((t) => t.members.map((m) => m.expertSlug))),
].map((slug) => ({
  slug,
  name: slug,
  nameEn: slug,
  description: '',
  descriptionEn: '',
  emoji: '🧩',
  division: 'engineering',
  divisionZh: '工程',
  custom: false,
}))
function setup(seedTeams = false) {
  let state: AgencySettings = { enabled: [], customExperts: [], customTeams: seedTeams ? structuredClone([...TEST_TEAMS]) : [] }
  let revision = 0
  const store = {
    read: () => structuredClone(state),
    revision: () => revision,
    mutate: async (
      ops: { path: readonly string[]; value?: unknown }[],
      expected: number,
    ) => {
      if (expected !== revision) throw new Error('配置已更新')
      for (const op of ops)
        (state as unknown as Record<string, unknown>)[op.path[0]] =
          structuredClone(op.value)
      revision++
    },
  }
  const library = createTeamLibrary(
    async () => ({ experts, enabled: state.enabled, revision }),
    store,
  )
  return { library, store }
}
const draft = () => {
  const { id: _id, ...value } = TEST_TEAMS[0]
  return { ...value, name: '我的评审团' }
}
describe('专家团配置与执行', () => {
  it('服务错误按当前语言返回，不依赖客户端二次翻译', async () => {
    const { store } = setup()
    let locale: 'zh' | 'en' = 'zh'
    const library = createTeamLibrary(async () => ({ experts, enabled: [], revision: store.revision() }), store, () => locale)
    await expect(library.get('missing')).rejects.toThrow('专家团不存在')
    locale = 'en'
    await expect(library.get('missing')).rejects.toThrow('Team not found')
    await library.save(draft(), false, 0)
    await expect(library.save(draft(), false, 1)).rejects.toThrow('already')
    const team = (await library.snapshot()).teams[0]
    await expect(library.setEnabled(team.id, true, 9)).rejects.toThrow('Settings changed')
  })
  it.each(['save', 'enable'] as const)('%s 保留名册暂不可用的原始启用记录', async (action) => {
    const { store } = setup(true)
    const retained = ['temporarily-conflicted', 'outside-current-divisions']
    await store.mutate([{ path: ['enabled'], value: retained }], 0)
    const library = createTeamLibrary(async () => ({ experts, enabled: [], revision: store.revision() }), store)
    if (action === 'save') await library.save(draft(), true, 1)
    else await library.setEnabled(TEST_TEAMS[0].id, true, 1)
    expect(store.read().enabled).toEqual([...retained, ...draft().members.map(member => member.expertSlug)])
  })
  it('默认无预置团队，不保留社区团队名称', async () => {
    const { library } = setup()
    expect((await library.snapshot()).teams).toEqual([])
    await expect(library.get('team-product')).rejects.toThrow('不存在')
    const saved = await library.save({ ...draft(), name: 'Product Review Team' }, false, 0)
    expect(saved.teams).toHaveLength(1)
  })
  it('不把旧名册与新团队配置拼成同一个快照', async () => {
    const { store } = setup()
    await store.mutate([{ path: ['enabledTeams'], value: [] }], 0)
    const library = createTeamLibrary(async () => ({ experts, enabled: [], revision: 0 }), store)
    await expect(library.snapshot()).rejects.toThrow('配置已更新')
  })
  it('持久化拒绝非法标识、重复标识和名称', () => {
    const team = {
      ...draft(),
      id: 'team-custom-12345678-1234-4234-8234-123456789012',

    }
    expect(() =>
      validateAgencySettings({ enabled: [], customTeams: [{ ...team, id: 'team-product' }] }),
    ).toThrow()
    expect(() =>
      validateAgencySettings({ enabled: [], customTeams: [team, team] }),
    ).toThrow()
    expect(() =>
      validateAgencySettings({
        enabled: [],
        customTeams: [team, { ...team, id: TEST_TEAMS[1].id }],
      }),
    ).toThrow()
  })
  it('包含五个三人团队，主理人模板各自完整且成员不重复', () => {
    expect(TEST_TEAMS).toHaveLength(5)
    for (const team of TEST_TEAMS) {
      expect(team.members).toHaveLength(3)
      expect(teamInputSchema.safeParse(team).success).toBe(true)
      expect(effectiveCoordinator(team)).toContain('处理分歧')
    }
  })
  it('拒绝重复成员、空自定义提示词和多于八人', () => {
    expect(
      teamInputSchema.safeParse({
        ...draft(),
        members: [draft().members[0], draft().members[0]],
      }).success,
    ).toBe(false)
    expect(
      teamInputSchema.safeParse({
        ...draft(),
        coordinatorMode: 'custom',
        coordinatorPrompt: ' ',
      }).success,
    ).toBe(false)
    expect(
      teamInputSchema.safeParse({
        ...draft(),
        members: Array.from({ length: 9 }, (_, i) => ({ ...draft().members[0], expertSlug: `expert-${i}` })),
      }).success,
    ).toBe(false)
  })
  it('模板和自定义只生效一份', () => {
    expect(
      effectiveCoordinator({
        ...TEST_TEAMS[0],
        coordinatorMode: 'custom',
        coordinatorPrompt: '仅输出决策依据',
      }),
    ).toBe('仅输出决策依据')
  })
  it('启用团队与成员原子写入；停用团队保留成员；拒绝过期写入', async () => {
    const { library } = setup(true)
    const enabled = await library.setEnabled(TEST_TEAMS[0].id, true, 0)
    expect(enabled.enabledTeams).toContain(TEST_TEAMS[0].id)
    expect(enabled.enabledExperts).toEqual(
      TEST_TEAMS[0].members.map((m) => m.expertSlug),
    )
    await expect(
      library.setEnabled(TEST_TEAMS[1].id, true, 0),
    ).rejects.toThrow()
    const disabled = await library.setEnabled(TEST_TEAMS[0].id, false, 1)
    expect(disabled.enabledTeams).toEqual([])
    expect(disabled.enabledExperts).toEqual(enabled.enabledExperts)
  })
  it('自定义持久化、名称唯一、未知标识拒绝及删除不删成员', async () => {
    const { library } = setup()
    const saved = await library.save(draft(), true, 0)
    const team = saved.teams[0]
    expect(team.id).toMatch(/^team-custom-/)
    await expect(library.save(draft(), false, 1)).rejects.toThrow('名称')
    await expect(
      library.save({ ...draft(), id: TEST_TEAMS[0].id }, false, 1),
    ).rejects.toThrow()
    const removed = await library.remove(team.id, 1)
    expect(removed.teams).toHaveLength(0)
    expect(removed.enabledExperts).toHaveLength(3)
  })
  it('冻结分工与提示词，保留部分失败，不自动重试', async () => {
    const team = structuredClone(TEST_TEAMS[0])
    const run = vi.fn(
      async (member: { name: string; prompt: string; persona: string }) => {
        if (member.name === team.members[1].expertSlug)
          throw new Error('成员失败')
        expect(member.prompt).toContain('评审这份需求')
        expect(member.persona).toBe('原始专家提示词')
        return '结论和依据'
      },
    )
    const pending = executeTeam({
      team,
      experts,
      enabled: team.members.map((m) => m.expertSlug),
      task: '评审这份需求',
      revision: 2,
      readPersona: async () => '原始专家提示词',
      run,
    })
    team.deliveryRequirements = '运行中被修改'
    const result = await pending
    expect(result.results.filter((r) => r.ok)).toHaveLength(2)
    expect(result.team.deliveryRequirements).not.toBe('运行中被修改')
    expect(result.coordinator).toContain('处理分歧')
    expect(run).toHaveBeenCalledTimes(3)
  })
  it('停用或失效成员不得悄悄运行，取消后不得新建任务', async () => {
    const run = vi.fn(async () => '结果')
    const args = {
      team: TEST_TEAMS[0],
      experts,
      enabled: [] as string[],
      task: '任务',
      revision: 0,
      readPersona: async () => '提示词',
      run,
    }
    await expect(executeTeam(args)).rejects.toThrow()
    const controller = new AbortController()
    controller.abort()
    await expect(
      executeTeam({
        ...args,
        enabled: experts.map((e) => e.slug),
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
  it('团队任务恰好达到上限仍进入成员校验，多一个字则要求压缩后重试', async () => {
    const args = {
      team: TEST_TEAMS[0],
      experts,
      enabled: [] as string[],
      revision: 0,
      readPersona: async () => '提示词',
      run: async () => '结果',
    }
    await expect(executeTeam({ ...args, task: '字'.repeat(TEAM_TASK_MAX_CHARS) })).rejects.toThrow('成员')
    await expect(executeTeam({ ...args, task: '字'.repeat(TEAM_TASK_MAX_CHARS + 1) })).rejects.toThrow(String(TEAM_TASK_MAX_CHARS))
    await expect(executeTeam({ ...args, task: '字'.repeat(TEAM_TASK_MAX_CHARS + 1) })).rejects.toThrow('压缩为摘要')
  })
  it('八人团队最多四人同时执行，取消后不启动排队成员', async () => {
    const team = {
      ...structuredClone(TEST_TEAMS[0]),
      members: experts
        .slice(0, 8)
        .map((e) => ({
          expertSlug: e.slug,
          duty: '分析',
          instructions: '给出依据',
        })),
    }
    const controller = new AbortController()
    const releases: (() => void)[] = []
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => releases.push(() => resolve('结果'))),
    )
    const pending = executeTeam({
      team,
      experts,
      enabled: experts.map((e) => e.slug),
      task: '任务',
      revision: 0,
      signal: controller.signal,
      readPersona: async () => '提示词',
      run,
    })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(4))
    controller.abort()
    releases.forEach((release) => release())
    await rejected
    expect(run).toHaveBeenCalledTimes(4)
  })
})
