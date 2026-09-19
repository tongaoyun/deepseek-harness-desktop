import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from './desktop-user-question-plugin.js'

type Handler = (request: { questions: Array<{ id: string; question: string }>; signal?: AbortSignal }, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>
const originalUrl = process.env.XIAOYIN_QUESTION_BRIDGE_URL
const originalToken = process.env.XIAOYIN_QUESTION_BRIDGE_TOKEN
afterEach(() => {
  if (originalUrl === undefined) delete process.env.XIAOYIN_QUESTION_BRIDGE_URL
  else process.env.XIAOYIN_QUESTION_BRIDGE_URL = originalUrl
  if (originalToken === undefined) delete process.env.XIAOYIN_QUESTION_BRIDGE_TOKEN
  else process.env.XIAOYIN_QUESTION_BRIDGE_TOKEN = originalToken
  vi.unstubAllGlobals()
})

it('returns the desktop answer and exposes bridge failures instead of pretending no answerer exists', async () => {
  process.env.XIAOYIN_QUESTION_BRIDGE_URL = 'http://127.0.0.1:10000/question'
  process.env.XIAOYIN_QUESTION_BRIDGE_TOKEN = 'local-test'
  let handler: Handler | undefined
  apply({ on: (_name: string, callback: Handler) => { handler = callback } } as unknown as Context)
  const request = { questions: [{ id: 'shop', question: '哪家店铺？' }] }
  const next = vi.fn(async () => ({ answers: [] }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: [{ id: 'shop', selected: [], custom: '店铺 A' }] }), { status: 200 })))
  await expect(handler!(request, next)).resolves.toEqual({ answers: [{ id: 'shop', selected: [], custom: '店铺 A' }] })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
  await expect(handler!(request, next)).rejects.toThrow('桌面问答通道返回 503')
  expect(next).not.toHaveBeenCalled()
})
