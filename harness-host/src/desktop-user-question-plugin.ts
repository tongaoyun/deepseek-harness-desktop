import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'

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
      if (!response.ok) return next()
      const value = await response.json() as AskUserQuestionAnswer
      return value
    } catch {
      return next()
    }
  })
}
