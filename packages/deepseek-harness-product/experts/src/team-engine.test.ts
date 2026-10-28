import { TEST_TEAMS } from './fixtures/teams.ts'
import { describe, expect, it, vi } from 'vitest'
import { detectTeamEngine, resolveTeamEngine, dispatchNativeTeam, blocksNativeDelegation } from './team-engine.ts'

import { createNativeTeam as native, createTeamAgent, nativeTeamMember } from '../tests/native-team.ts'
import { createTestContext } from '../tests/context.ts'
import { TeamId } from '@deepseek-ai/dsh-experimental-agent-team'

describe('专家团运行引擎能力分流', () => {
  it('未安装能力时普通执行，不推荐不存在的能力', () => {
    expect(detectTeamEngine(undefined, false)).toMatchObject({ state: 'unsupported', mode: 'subagent', recommendation: '' })
  })
  it('安装能力不代表启用，未挂载时推荐开启但允许普通调用', () => {
    expect(detectTeamEngine(undefined, true)).toMatchObject({ state: 'disabled', mode: 'subagent', recommendation: expect.stringContaining('开启') })
  })
  it('当前原生服务和会话工具就绪才使用原生模式', () => {
    const { service } = native()
    expect(detectTeamEngine(service, false)).toMatchObject({ state: 'enabled', mode: 'native' })
    expect(detectTeamEngine(service, true, false).mode).toBe('subagent')
  })
  it('显式深度限制不能被原生模式静默忽略', () => {
    expect(detectTeamEngine(native().service, true, true, 2)).toMatchObject({ mode: 'subagent', reason: expect.stringContaining('深度') })
  })
  it('只拦截本插件队友的递归委派，不影响通信和主理人', () => {
    const { service } = native()
    const agent = createTeamAgent()
    expect(blocksNativeDelegation(service, agent, 'subagent')).toBe(false)
    service.tryMembership.mockReturnValue({ root: agent, id: TeamId(agent.id), role: 'teammate', name: `agency-reviewer-${'a'.repeat(10)}` })
    expect(blocksNativeDelegation(service, agent, 'summon_expert')).toBe(true)
    expect(blocksNativeDelegation(service, agent, 'subagent_fork')).toBe(true)
    expect(blocksNativeDelegation(service, agent, 'send_message')).toBe(false)
  })
  it('按当前智能体作用域检测工具，不能误读全局工具表', () => {
    const { service } = native()
    const get = vi.fn((_name: string, scope?: unknown) => scope === agent ? {} : undefined)
    const agent = createTeamAgent(createTestContext({ get: (key: string) => key === 'tools' ? { get } : undefined }))
    const ctx = createTestContext({ get: (key: string) => key === 'agentTeams' ? service : undefined })
    expect(resolveTeamEngine(ctx, agent).status.mode).toBe('native')
    expect(get).toHaveBeenCalledWith('spawn_teammate', agent)
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
    const { service } = native()
    const args = input()
    args.experts = args.experts.map(expert => ({ ...expert, name: '中文专家', nameEn: 'Expert' }))
    const report = await dispatchNativeTeam({ ...args, service, locale: 'en' })
    expect(service.spawnTeammate.mock.calls[0][1].description).toBe('Expert')
    expect(service.spawnTeammate.mock.calls[0][1].name).toMatch(/^agency-[a-z0-9-]+-[0-9a-f]{10}$/u)
    expect(report.dispatch.members[0].expert).toBe('Expert')
    expect(report.team).toEqual(args.team)
    expect(report.coordinator).not.toMatch(/[\u3400-\u9fff]/u)
    expect(service.createTask.mock.calls[0][1].subject).toContain(args.team.name)
  })
  it('创建队友与任务，报告启动状态而非虚构完成结果', async () => {
    const { service } = native()
    const result = await dispatchNativeTeam({ ...input(), service })
    expect(service.spawnTeammate).toHaveBeenCalledTimes(3)
    expect(service.createTask).toHaveBeenCalledTimes(3)
    expect(result.dispatch.started).toBe(3)
    expect(result).not.toHaveProperty('coverage')
    expect(result).not.toHaveProperty('results')
    expect(service.spawnTeammate.mock.calls[0][1].prompt).toContainEqual({ type: 'text', text: expect.stringContaining('专家职责正文') })
    expect(result.instruction).toContain('wait_agent')
  })
  it('创建失败只报告失败，不重复走普通路径', async () => {
    const { service } = native()
    service.spawnTeammate.mockRejectedValue(new Error('名额已满'))
    const result = await dispatchNativeTeam({ ...input(), service })
    expect(result.dispatch.started).toBe(0)
    expect(result.dispatch.members.every(m => m.error?.includes('名额已满'))).toBe(true)
    expect(service.updateTask).toHaveBeenCalledTimes(3)
    expect(result.dispatch.members.every(m => m.taskId === undefined)).toBe(true)
  })
  it('同一专家队友空闲时复用，运行中不重复派发', async () => {
    const { service, members } = native()
    const args = { ...input(), service }
    await dispatchNativeTeam(args)
    const busy = await dispatchNativeTeam(args)
    expect(busy.dispatch.started).toBe(0)
    members.splice(0, members.length, ...members.map(member => ({ ...member, status: 'inactive' as const })))
    const reused = await dispatchNativeTeam(args)
    expect(reused.dispatch.started).toBe(3)
    expect(service.spawnTeammate).toHaveBeenCalledTimes(3)
    expect(service.sendMessage).toHaveBeenCalledTimes(3)
  })
  it('清理失败时保留任务编号，方便用户定位任务板', async () => {
    const { service } = native()
    service.spawnTeammate.mockRejectedValue(new Error('创建失败'))
    service.updateTask.mockRejectedValue(new Error('清理失败'))
    const result = await dispatchNativeTeam({ ...input(), service })
    expect(result.dispatch.members.every(member => member.status === 'failed' && member.taskId === '1' && member.error?.includes('清理失败'))).toBe(true)
  })
  it('启动前取消不创建任何队友', async () => {
    const { service } = native()
    await expect(dispatchNativeTeam({ ...input(), service, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(service.spawnTeammate).not.toHaveBeenCalled()
  })
  it('启动中取消会等待在途调用收敛并中断已启动队友', async () => {
    const { service } = native()
    const controller = new AbortController()
    service.spawnTeammate.mockImplementation(async (_agent, request) => {
      await Promise.resolve()
      controller.abort()
      return { member: nativeTeamMember(request.name) }
    })
    await expect(dispatchNativeTeam({ ...input(), service, signal: controller.signal })).rejects.toThrow()
    expect(service.interrupt.mock.calls.length).toBe(service.spawnTeammate.mock.calls.length)
    expect(service.interrupt).toHaveBeenCalled()
  })
})
