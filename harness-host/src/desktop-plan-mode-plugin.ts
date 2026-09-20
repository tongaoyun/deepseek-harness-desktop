import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-plan-mode'

export const name = 'xiaoyin-desktop-plan-mode'
export const inject = ['planMode', 'tools']

const PLAN_SAFE_TOOLS = new Set([
  'tool_discover', 'ask_user_question', 'exit_plan_mode', 'get_goal', 'task_report',
  'read', 'read_image', 'glob', 'grep', 'skill', 'lsp',
  'web_search', 'web_fetch',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read', 'schedule_list',
  'job_list', 'job_output', 'list_agents',
  'local_files_roots', 'local_files_list', 'local_files_search', 'local_files_read_text',
  'office_document_read', 'office_document_check', 'office_pdf_page', 'office_engine_status',
  'knowledge_list', 'knowledge_search',
  'browser_open', 'browser_snapshot', 'browser_screenshot', 'browser_downloads',
  'computer_use_observe', 'schedules_list', 'skills_search', 'skills_inspect_github',
])

export function isPlanSafeTool(name: string): boolean { return PLAN_SAFE_TOOLS.has(name) }

/** Keep the desktop's explicit mode in the official durable plan projection. */
export function apply(ctx: Context): void {
  const active = process.env.XIAOYIN_EXECUTION_MODE === 'plan'
  ctx.on('agent/created', ({ agent }) => {
    ctx.planMode.set(agent, active)
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.agent === undefined || !ctx.planMode.get(exec.agent).active || isPlanSafeTool(exec.name)) return next()
    return Promise.resolve({
      kind: 'deny' as const,
      reason: `Plan mode blocks mutating or unclassified tool "${exec.name}". Finish the plan and use exit_plan_mode before executing it.`,
    })
  })
}
