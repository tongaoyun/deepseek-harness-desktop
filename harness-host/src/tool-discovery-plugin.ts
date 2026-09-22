import type { Context } from '@deepseek-ai/cordis'
import { discoveryGuidance } from './task-instructions.js'
import { HarnessError, data as errorData } from './errors.js'

export const name = 'xiaoyin-tool-discovery'
export const inject = ['tools']

const groups = ['files', 'office', 'knowledge', 'connectors', 'skills', 'web', 'code', 'desktop', 'workflow', 'other'] as const
type Group = typeof groups[number]

interface AgentState {
  allowed: Set<string>
  release: () => void
  turn?: number
}

export function toolGroup(name: string): Group {
  if (/^(local_files_|read$|write$|edit$|read_image$|glob$|grep$|present$|list_dir|search_file)/u.test(name)) return 'files'
  if (name.startsWith('office_')) return 'office'
  if (name.startsWith('knowledge_')) return 'knowledge'
  if (/^(mcp_|connector_|erp_)/u.test(name) || name.includes('__')) return 'connectors'
  if (/^(skill|skills_)/u.test(name)) return 'skills'
  if (/^(web_|fetch|search_web|browser_)/u.test(name)) return 'web'
  if (/^(bash|pwsh|terminal|lsp_|subagent|run_code)/u.test(name)) return 'code'
  if (/^(computer_use_|local_computer_|desktop_)/u.test(name)) return 'desktop'
  if (/^(schedule|todo|ask_user|exit_plan|task_report|session_|send_message|interrupt_agent|list_agents)/u.test(name)) return 'workflow'
  return 'other'
}

function initialAllowedTools(ctx: Context): Set<string> {
  const allowed = new Set(['tool_discover'])
  for (const name of ['ask_user_question', 'exit_plan_mode']) if (ctx.tools.get(name)) allowed.add(name)
  return allowed
}

export function apply(ctx: Context): void {
  const active = new WeakMap<object, AgentState>()
  const states = new Set<AgentState>()

  // Cordis disposes an Agent context before a stale async callback can be
  // observed by the next lifecycle event. Releasing a restriction is normally
  // idempotent, but the context itself may already be inactive at that point.
  // Cleanup must never turn agent disposal into an unhandled task failure.
  const release = (state: AgentState): void => {
    const dispose = state.release
    state.release = () => undefined
    try {
      dispose()
    } catch (error) {
      if (!isInactiveContextError(error)) throw error
    }
  }

  const restrict = (agent: object, allowed: Set<string>, available: string[]): (() => void) => {
    try {
      return (agent as { ctx: { tools: { restrict: (filter: { allow: string[] }) => () => void } } }).ctx.tools.restrict({
        allow: [...allowed].filter((tool) => available.includes(tool)),
      })
    } catch (error) {
      if (isInactiveContextError(error)) {
        throw new HarnessError(errorData(
          'XY-AGENT-CONTEXT',
          'local-agent',
          '任务执行上下文已失效',
          '当前任务执行上下文已失效，请重新发送任务',
          true,
          true,
        ))
      }
      throw error
    }
  }

  const dispose = ctx.tools.register({
    name: 'tool_discover',
    description: '需要读取事实或执行操作时，选择所需工具类别；普通直接问答无需调用。解锁后下一步即可使用相应工具。可一次选多个类别。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['groups'],
      properties: { groups: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...groups] } } },
    },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (input, exec) => {
      const selected = (input as { groups?: unknown }).groups
      if (!exec.agent || !Array.isArray(selected) || !selected.length || selected.some((group) => !groups.includes(group as Group))) throw new Error('无效的工具类别')
      const state = active.get(exec.agent)
      if (!state) throw new Error('当前 Agent 尚未准备好工具发现')
      const available = ctx.tools.schemas().map((tool) => tool.name)
      for (const group of selected as Group[]) for (const tool of available) if (toolGroup(tool) === group) state.allowed.add(tool)
      if (available.includes('task_report')) state.allowed.add('task_report')
      // Restrictions intersect. Lift the previous mask before installing its
      // replacement; the agent's other permission filters remain in force.
      release(state)
      state.release = restrict(exec.agent, state.allowed, available)
      const publishingTool = available.includes('local_files_publish') ? 'local_files_publish' : 'present'
      return {
        groups: selected,
        toolCount: [...state.allowed].filter((tool) => available.includes(tool) && tool !== 'tool_discover' && tool !== 'ask_user_question').length,
        guidance: discoveryGuidance(selected as Group[], publishingTool),
      }
    },
    isConcurrencySafe: () => false,
  })
  ctx.on('agent/created', ({ agent }) => {
    const allowed = initialAllowedTools(ctx)
    const state: AgentState = { allowed, release: () => undefined }
    state.release = restrict(agent, allowed, ctx.tools.schemas().map((tool) => tool.name))
    active.set(agent, state)
    states.add(state)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = active.get(agent)
    if (!state) return
    active.delete(agent)
    states.delete(state)
    release(state)
  })
  ctx.on('agent/pre-step', ({ agent, turn }, next) => {
    const state = active.get(agent)
    if (state && typeof turn === 'number' && state.turn !== turn) {
      state.turn = turn
      state.allowed = initialAllowedTools(ctx)
      release(state)
      state.release = restrict(agent, state.allowed, ctx.tools.schemas().map((tool) => tool.name))
    }
    return next()
  })
  ctx.effect(() => () => {
    for (const state of states) release(state)
    states.clear()
    dispose()
  }, 'tool discovery')
}

function isInactiveContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('cannot create effect on inactive context')
}
