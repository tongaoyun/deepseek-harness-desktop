import type { Context } from '@deepseek-ai/cordis'
import { parseTaskOutcome, taskOutcomeStatuses, taskOutcomeValidationMessage } from './task-outcome.js'

export const name = 'xiaoyin-task-outcome'
export const inject = ['tools']

export function apply(ctx: Context): void {
  const dispose = ctx.tools.register({
    name: 'task_report',
    description: '结束本轮前最后调用，报告用户目标的实际完成情况及检查依据，再向用户回复。status 必填；completed 仅用于目标已达成且 remaining 为空、所有 checks 均为 passed。等待资料用 needs_input，等待授权用 needs_confirmation，部分完成用 partial，无法继续用 blocked，关键目标无法确认用 unverified。只将本轮目标必需的核验列入 checks；非必需且未核实的附加信息写在回复限制中，不添加 not_run 检查。本工具只记录判断，不执行检查、不授予权限。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['status', 'summary', 'remaining', 'checks'],
      properties: {
        status: { type: 'string', enum: [...taskOutcomeStatuses], description: '必填。目标已完成且必需检查均通过时填 completed；不能省略。' },
        summary: { type: 'string', minLength: 1, maxLength: 2000 },
        remaining: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 }, description: '未完成事项或需要用户补充、确认的具体内容；completed 必须为空，其他状态至少一项' },
        checks: { type: 'array', maxItems: 20, description: '仅列用户目标必需的实际检查。completed 中每项 result 必须是 passed；可选信息缺口在最终回复说明。', items: {
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
      if (!outcome) throw new Error(taskOutcomeValidationMessage(input))
      return { xiaoyinTaskOutcome: 1, outcome }
    },
    isConcurrencySafe: () => false,
  })
  ctx.effect(() => dispose, 'task outcome reporting')
}
