import type { Context } from '@deepseek-ai/cordis'
import { parseTaskOutcome, taskOutcomeStatuses } from './task-outcome.js'

export const name = 'xiaoyin-task-outcome'
export const inject = ['tools']

export function apply(ctx: Context): void {
  const dispose = ctx.tools.register({
    name: 'task_report',
    description: '结束本轮前最后调用，报告用户目标的实际完成情况及检查依据，再向用户回复。completed 仅用于目标已达成；等待用户资料用 needs_input，等待新的授权用 needs_confirmation，部分完成用 partial，无法继续用 blocked，无法确认用 unverified。检查依据须来自实际结果；本工具只记录判断，不执行检查、不授予权限。普通问答可用空 checks；文件或业务操作应列出实际验收。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['status', 'summary', 'remaining', 'checks'],
      properties: {
        status: { type: 'string', enum: [...taskOutcomeStatuses] },
        summary: { type: 'string', minLength: 1, maxLength: 2000 },
        remaining: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 }, description: '未完成事项或需要用户补充、确认的具体内容；completed 必须为空，其他状态至少一项' },
        checks: { type: 'array', maxItems: 20, items: {
          type: 'object', additionalProperties: false, required: ['description', 'result', 'evidence'],
          properties: {
            description: { type: 'string', minLength: 1, maxLength: 500 },
            result: { type: 'string', enum: ['passed', 'failed', 'not_run'] },
            evidence: { type: 'string', minLength: 1, maxLength: 2000, description: '实际工具结果、文件位置或核对依据；未执行时说明原因' },
          },
        } },
      },
    },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (input) => {
      const outcome = parseTaskOutcome(input)
      if (!outcome) throw new Error('任务结果无效：已完成不能包含未完成事项或未通过的检查，其他状态必须说明下一步。')
      return { xiaoyinTaskOutcome: 1, outcome }
    },
    isConcurrencySafe: () => false,
  })
  ctx.effect(() => dispose, 'task outcome reporting')
}
