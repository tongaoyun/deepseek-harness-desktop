import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { HarnessError, data as errorData } from './errors.js'

export const name = 'xiaoyin-desktop-user-question'
export const inject = ['userQuestions']

export function apply(ctx: Context): void {
  ctx.on('user-questions/request', async (request, next): Promise<AskUserQuestionAnswer> => {
    const url = process.env.XIAOYIN_QUESTION_BRIDGE_URL
    const token = process.env.XIAOYIN_QUESTION_BRIDGE_TOKEN
    if (!url || !token) return next()
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ questions: request.questions }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (!response.ok) throw new Error(`桌面问答通道返回 ${response.status}`)
      const value = await response.json() as AskUserQuestionAnswer
      return value
    } catch (error) {
      if (request.signal?.aborted) throw new HarnessError(errorData('XY-CANCELED', 'unknown', '任务已停止', '本轮已停止，问题回答未交付', false, false))
      throw error
    }
  })
}
