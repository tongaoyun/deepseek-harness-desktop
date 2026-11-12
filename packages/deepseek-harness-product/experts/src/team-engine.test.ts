import { TEST_TEAMS } from './fixtures/teams.ts'
import { describe, expect, it, vi } from 'vitest'
import { detectTeamEngine, resolveTeamEngine, dispatchNativeTeam, blocksNativeDelegation, nativeTeamMemberName } from './team-engine.ts'

import { createNativeTeam as native, createTeamAgent, nativeTeamMember } from '../tests/native-team.ts'
import { createTestContext } from '../tests/context.ts'

describe('专家团运行引擎能力分流', () => {
  it('未安装能力时普通执行，不推荐不存在的能力', () => {
    expect(detectTeamEngine(undefined, false)).toMatchObject({ state: 'unsupported', mode: 'subagent', recommendation: '' })
  })
  it('安装能力不代表启用，未就绪时提示重启且允许普通调用', () => {
    expect(detectTeamEngine(undefined, true)).toMatchObject({ state: 'disabled', mode: 'subagent', recommendation: expect.stringContaining('重启') })
  })
  it('当前原生服务和会话工具就绪才使用原生模式', () => {
    const { service } = native()
    expect(detectTeamEngine(service, false)).toMatchObject({ state: 'enabled', mode: 'native' })
    expect(detectTeamEngine(service, true, false).mode).toBe('subagent')
  })
  it('只拦截本插件队友的递归委派，不影响通信和主理人', () => {
    const { subagents } = native()
    const agent = createTeamAgent()
    expect(blocksNativeDelegation(subagents, agent, 'subagent')).toBe(false)
    subagents.namesOf.mockReturnValue({ self: `agency-${'a'.repeat(20)}`, parent: 'lead' })
    for (const tool of ['summon_expert', 'subagent', 'subagent_fork', 'workflow']) {
      expect(blocksNativeDelegation(subagents, agent, tool)).toBe(true)
    }
    expect(blocksNativeDelegation(subagents, agent, 'send_message')).toBe(false)
  })
  it('按当前智能体作用域检测工具，不能误读全局工具表', () => {
    const { service } = native()
    const get = vi.fn((_name: string, scope?: unknown) => scope === agent ? {} : undefined)
    const agent = createTeamAgent(createTestContext({ get: (key: string) => key === 'tools' ? { get } : undefined }))
    const ctx = createTestContext({ get: (key: string) => key === 'agentTeams' ? service : undefined })
    expect(resolveTeamEngine(ctx, agent).status.mode).toBe('native')
    expect(get).toHaveBeenCalledWith('subagent', agent)
  })
  it('原生服务已挂载但当前 Agent 未装配工具时明确使用普通子代理', () => {
    const { service } = native()
    const ctx = createTestContext({ get: (key: string) => key === 'agentTeams' ? service : undefined })
    const status = resolveTeamEngine(ctx, createTeamAgent()).status
    expect({ state: status.state, mode: status.mode, reason: status.reason }).toMatchInlineSnapshot(`
      {
        "mode": "subagent",
        "reason": "Agent Team services or conversation tools are not ready.",
        "state": "disabled",
      }
    `)
  })
})

describe('原生专家团启动语义', () => {
  const team = TEST_TEAMS[0]
  const input = () => ({
    team, revision: 1, task: '评审现有方案', enabled: team.members.map(m => m.expertSlug),
    experts: team.members.map(m => ({ slug: m.expertSlug, name: m.expertSlug, nameEn: m.expertSlug, division: 'engineering', divisionZh: '工程', description: '', descriptionEn: '', emoji: '', custom: false })),
    readPersona: async () => '专家职责正文', agent: createTeamAgent(), provider: 'spawn', signal: new AbortController().signal,
  })
  it('英文环境使用英文显示名，同时保留稳定队友标识', async () => {
    const { service, subagents } = native()
    const args = input()
    args.experts = args.experts.map(expert => ({ ...expert, name: '中文专家', nameEn: 'Expert' }))
    const report = await dispatchNativeTeam({ ...args, service, subagents, locale: 'en' })
    expect(subagents.startActivation.mock.calls[0][0].label).toBe('Expert')
    expect(subagents.startActivation.mock.calls[0][0].name).toMatch(/^agency-[0-9a-f]{20}$/u)
    expect(report.dispatch.members[0].expert).toBe('Expert')
    expect(report.team).toEqual(args.team)
    expect(report.coordinator).not.toMatch(/[\u3400-\u9fff]/u)
    expect(service.createTask.mock.calls[0][1].subject).toContain(args.team.name)
  })
  it('创建队友与任务，报告启动状态而非虚构完成结果', async () => {
    const { service, subagents } = native()
    const result = await dispatchNativeTeam({ ...input(), service, subagents, maxDepth: 2 })
    expect(subagents.startActivation).toHaveBeenCalledTimes(3)
    expect(subagents.startActivation.mock.calls.every(([request]) => request.maxDepth === 2)).toBe(true)
    expect(service.createTask).toHaveBeenCalledTimes(3)
    expect(result.dispatch.started).toBe(3)
    expect(result).not.toHaveProperty('coverage')
    expect(result).not.toHaveProperty('results')
    expect(subagents.startActivation.mock.calls[0][0].prompt).toContainEqual({ type: 'text', text: expect.stringContaining('专家职责正文') })
    expect(result.instruction).toContain('wait_agent')
  })
  it('读取专家期间团队被编辑时，任务和队友仍使用本次冻结的团队', async () => {
    const { service, subagents } = native()
    const args = { ...input(), team: structuredClone(team) }
    const captured = structuredClone(args.team)
    const persona = Promise.withResolvers<string>()
    const pending = dispatchNativeTeam({ ...args, service, subagents, readPersona: () => persona.promise })
    args.team.id = 'team-custom-replacement'
    args.team.name = '另一个专家团'
    persona.resolve('专家职责正文')
    const result = await pending
    expect(result.team).toEqual(captured)
    expect(service.createTask.mock.calls.map(call => call[1].subject)).toEqual(
      captured.members.map(member => `${captured.name}：${member.expertSlug}`),
    )
    expect(subagents.startActivation.mock.calls.map(call => call[0].name)).toEqual(
      captured.members.map(member => nativeTeamMemberName(captured.id, member.expertSlug)),
    )
    expect({ team: result.team.id, tasks: service.createTask.mock.calls.map(call => call[1].subject),
      members: result.dispatch.members.map(member => member.name) }).toMatchSnapshot()
  })
  it('创建失败只报告失败，不重复走普通路径', async () => {
    const { service, subagents } = native()
    subagents.startActivation.mockRejectedValue(new Error('名额已满'))
    const result = await dispatchNativeTeam({ ...input(), service, subagents })
    expect(result.dispatch.started).toBe(0)
    expect(result.dispatch.members.every(m => m.error?.includes('名额已满'))).toBe(true)
    expect(service.updateTask).toHaveBeenCalledTimes(3)
    expect(result.dispatch.members.every(m => m.taskId === undefined)).toBe(true)
  })
  it('同一专家队友空闲时复用，运行中不重复派发', async () => {
    const { service, subagents, members } = native()
    const args = { ...input(), service, subagents }
    await dispatchNativeTeam(args)
    const busy = await dispatchNativeTeam(args)
    expect(busy.dispatch.started).toBe(0)
    members.splice(0, members.length, ...members.map(member => ({ ...member, activity: 'inactive' as const })))
    const reused = await dispatchNativeTeam(args)
    expect(reused.dispatch.started).toBe(3)
    expect(subagents.startActivation).toHaveBeenCalledTimes(3)
    expect(subagents.sendMessage).toHaveBeenCalledTimes(3)
  })
  it('清理失败时保留任务编号，方便用户定位任务板', async () => {
    const { service, subagents } = native()
    subagents.startActivation.mockRejectedValue(new Error('创建失败'))
    service.updateTask.mockRejectedValue(new Error('清理失败'))
    const result = await dispatchNativeTeam({ ...input(), service, subagents })
    expect(result.dispatch.members.every(member => member.status === 'failed' && member.taskId === '1' && member.error?.includes('清理失败'))).toBe(true)
  })
  it('启动前取消不创建任何队友', async () => {
    const { service, subagents } = native()
    await expect(dispatchNativeTeam({ ...input(), service, subagents, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(subagents.startActivation).not.toHaveBeenCalled()
  })
  it('启动中取消会等待在途调用收敛并中断已启动队友', async () => {
    const { service, subagents } = native()
    const controller = new AbortController()
    subagents.startActivation.mockImplementation(async (request) => {
      await Promise.resolve()
      controller.abort()
      const member = nativeTeamMember(request.name!, request.parent.id)
      return { childId: member.id, name: request.name!, messageId: undefined, result: Promise.resolve({ stopReason: 'completed' as const, output: [] }), dispose: async () => {} }
    })
    await expect(dispatchNativeTeam({ ...input(), service, subagents, signal: controller.signal })).rejects.toThrow()
    expect(subagents.interrupt.mock.calls.length).toBe(subagents.startActivation.mock.calls.length)
    expect(subagents.interrupt).toHaveBeenCalled()
  })
})
