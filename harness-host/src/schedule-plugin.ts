import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const name = 'xiaoyin-schedules'
export const inject = ['tools']

export interface Config {
  endpoint?: string
  employeeIdEnv?: string
  employeeTokenEnv?: string
}

export const Config = z.object({
  endpoint: z.string().default(''),
  employeeIdEnv: z.string().default('XIAOYIN_EMPLOYEE_ID'),
  employeeTokenEnv: z.string().default('XIAOYIN_EMPLOYEE_BEARER_TOKEN'),
})

export function apply(ctx: Context, config: Config = {}): void {
  const endpoint = config.endpoint?.trim()
  if (!endpoint) return
  const url = new URL(endpoint)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Schedule endpoint must use HTTP(S)')
  const client = new ScheduleClient(
    url.toString().replace(/\/$/, ''),
    process.env[config.employeeIdEnv ?? 'XIAOYIN_EMPLOYEE_ID']?.trim() || 'local-development',
    process.env[config.employeeTokenEnv ?? 'XIAOYIN_EMPLOYEE_BEARER_TOKEN']?.trim() || '',
  )
  const unregister = [
    ctx.tools.register(listTool(client)),
    ctx.tools.register(createTool(client)),
    ctx.tools.register(actionTool(client, 'pause', 'schedules_pause', '暂停一个定时任务')),
    ctx.tools.register(actionTool(client, 'resume', 'schedules_resume', '恢复一个定时任务')),
    ctx.tools.register(actionTool(client, 'run', 'schedules_run_now', '立即执行一个定时任务')),
    ctx.tools.register(deleteTool(client)),
  ]
  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => exec.name === 'schedules_delete'
    ? Promise.resolve({ kind: 'ask' as const, reason: `删除定时任务：${safeId(exec.arguments)}` })
    : next())
  ctx.effect(() => () => {
    stopApprovalPolicy()
    for (const dispose of unregister.reverse()) dispose()
  }, 'xiaoyin schedule tools')
}

export class ScheduleClient {
  constructor(
    private readonly endpoint: string,
    private readonly employeeId: string,
    private readonly token: string,
  ) {}

  list(): Promise<unknown> {
    return this.request('')
  }

  create(input: { name: string; prompt: string; cronExpression: string; timeZone: string }): Promise<unknown> {
    return this.request('', {
      method: 'POST',
      body: JSON.stringify({
        name: requiredString(input.name, 'name', 100),
        expertKitId: 'xiaoyin-agent',
        workflowId: 'agent-prompt',
        cronExpression: requiredString(input.cronExpression, 'cronExpression', 120),
        timeZone: requiredString(input.timeZone, 'timeZone', 80),
        inputs: { prompt: requiredString(input.prompt, 'prompt', 10_000) },
      }),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  action(id: string, action: 'pause' | 'resume' | 'run'): Promise<unknown> {
    return this.request(`/${encodeURIComponent(requiredString(id, 'id', 200))}/${action}`, { method: 'POST' })
  }

  delete(id: string): Promise<unknown> {
    return this.request(`/${encodeURIComponent(requiredString(id, 'id', 200))}`, { method: 'DELETE' })
  }

  private async request(suffix: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${suffix}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        'X-Xiaoyin-Employee-Id': this.employeeId,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) throw new Error(`Schedule service returned HTTP ${response.status}`)
    if (response.status === 204) return { deleted: true }
    const text = await response.text()
    return text ? JSON.parse(text) : { success: true }
  }
}

function listTool(client: ScheduleClient): ToolDefinition {
  return tool('schedules_list', '查看我的定时任务。', {}, [], () => client.list())
}

function createTool(client: ScheduleClient): ToolDefinition {
  return tool('schedules_create', '创建一个在公司服务器持续运行的自然语言定时任务。请先从用户描述中确定执行时间。', {
    name: { type: 'string', minLength: 1, maxLength: 100, description: '简短任务名称' },
    prompt: { type: 'string', minLength: 1, maxLength: 10_000, description: '每次执行时让小胤完成的完整任务' },
    cronExpression: { type: 'string', minLength: 5, maxLength: 120, description: '五段 Cron，例如工作日 18:30 为 30 18 * * 1-5' },
    timeZone: { type: 'string', minLength: 1, maxLength: 80, default: 'Asia/Shanghai', description: 'IANA 时区' },
  }, ['name', 'prompt', 'cronExpression', 'timeZone'], (args) => {
    const input = asRecord(args)
    return client.create({
      name: requiredString(input.name, 'name', 100),
      prompt: requiredString(input.prompt, 'prompt', 10_000),
      cronExpression: requiredString(input.cronExpression, 'cronExpression', 120),
      timeZone: requiredString(input.timeZone, 'timeZone', 80),
    })
  })
}

function actionTool(
  client: ScheduleClient,
  action: 'pause' | 'resume' | 'run',
  name: string,
  description: string,
): ToolDefinition {
  return tool(name, description, idProperties(), ['id'], (args) => client.action(
    requiredString(asRecord(args).id, 'id', 200), action,
  ))
}

function deleteTool(client: ScheduleClient): ToolDefinition {
  return tool('schedules_delete', '删除一个定时任务。此操作需要用户确认。', idProperties(), ['id'], (args) => client.delete(
    requiredString(asRecord(args).id, 'id', 200),
  ))
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  execute: (args: unknown) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute,
    isConcurrencySafe: () => name === 'schedules_list',
  }
}

function idProperties(): Record<string, unknown> {
  return { id: { type: 'string', minLength: 1, maxLength: 200, description: '定时任务 ID，可先调用 schedules_list 获取' } }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('arguments must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || [...value].some((character) => character === '\0')) {
    throw new Error(`${name} is invalid`)
  }
  return value.trim()
}

function safeId(value: unknown): string {
  try { return requiredString(asRecord(value).id, 'id', 200) } catch { return '未知任务' }
}
