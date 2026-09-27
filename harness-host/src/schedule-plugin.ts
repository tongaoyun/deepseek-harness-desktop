import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const name = 'xiaoyin-schedules'
export const inject = ['tools']
export interface Config { readOnly?: boolean }
export const Config = z.object({ readOnly: z.boolean().default(false) })

export class ScheduleClient {
  constructor(private readonly url: string, private readonly token: string) {}
  async request(action: string, input: unknown = {}): Promise<unknown> {
    const url = new URL(this.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('定时任务仅使用本机桌面调度')
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, input }) })
    if (!response.ok) throw new Error(`本机定时任务请求失败：${response.status}`)
    const result: unknown = await response.json()
    if (result && typeof result === 'object' && 'error' in result) throw new Error(String(result.error))
    return result
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const url = process.env.XIAOYIN_LOCAL_SCHEDULE_URL, token = process.env.XIAOYIN_LOCAL_SCHEDULE_TOKEN
  if (!url || !token) return
  const client = new ScheduleClient(url, token)
  const id = { id: { type: 'string', description: '已有定时任务 ID，先查询列表获得' } }
  const fields = {
    name: { type: 'string', maxLength: 100 },
    prompt: { type: 'string', maxLength: 10000, description: '每次独立执行的完整任务，写明上下文和交付要求，不引用“刚才”的消息' },
    cronExpression: { type: 'string', description: '五段 Cron，按电脑系统时区；与 runAt、intervalMinutes 三选一' },
    runAt: { type: 'string', description: '一次性执行时间，含时区偏移的 ISO 8601；必须在未来' },
    intervalMinutes: { type: 'integer', minimum: 1, maximum: 525600, description: '每隔固定分钟执行' },
  }
  const definitions: [string, string, Record<string, unknown>, string[]][] = [
    ['list', '查询这台电脑上的定时任务及执行记录。睡眠或关闭小胤时不执行，不自动补跑。', {}, []],
    ['create', '用户明确要求时创建本机定时任务。复用普通任务的技能、连接器和文件能力，继承当前任务工作目录及附件。不支持无人值守授权时请说明。', fields, ['name', 'prompt']],
    ['update', '编辑本机定时任务，保留启停状态、目录及附件。时间字段三选一；省略的字段保留。', { ...id, ...fields }, ['id']],
    ['pause', '暂停定时任务后续执行，不停止当前对话。', id, ['id']],
    ['resume', '恢复定时任务，从现在重新安排。', id, ['id']],
    ['delete', '删除定时任务和计划执行记录，保留已有任务对话。需要用户确认。', id, ['id']],
  ]
  const disposers = definitions.filter(([action]) => !config.readOnly || action === 'list').map(([action, description, properties, required]) => {
    const tool: ToolDefinition = {
      name: `schedule_${action}`, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (input) => client.request(action, input),
      isConcurrencySafe: () => action === 'list',
    }
    return ctx.tools.register(tool)
  })
  const stop = ctx.on('tools/pre-execute', (exec, next) => exec.name === 'schedule_delete'
    ? Promise.resolve({ kind: 'ask' as const, reason: '删除这个定时任务？已有任务对话会保留。' }) : next())
  ctx.effect(() => () => { stop(); for (const dispose of disposers.reverse()) dispose() }, 'desktop schedule tools')
}
