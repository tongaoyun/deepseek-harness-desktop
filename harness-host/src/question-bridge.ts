import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { notification, type JsonRpcOutput } from './protocol.js'

const MAX_BODY_BYTES = 128 * 1024
const QUESTION_TIMEOUT_MS = 30 * 60 * 1000

export interface QuestionOption { label: string; description?: string }
export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOption[]
  multiSelect?: boolean
  intent?: { kind: 'plan-review'; approve: string }
}
export interface QuestionAnswerItem { id: string; selected: string[]; custom?: string }
export interface QuestionAnswer { answers: QuestionAnswerItem[] }

interface PendingQuestion {
  resolve: (answer: QuestionAnswer | 'unavailable') => void
  timer: NodeJS.Timeout
}

export class QuestionBridge {
  private server: Server | undefined
  private readonly token = randomBytes(32).toString('hex')
  private readonly pending = new Map<string, PendingQuestion>()
  private url: string | undefined

  constructor(private readonly emit: (output: JsonRpcOutput) => void) {}

  async start(): Promise<{ url: string; token: string }> {
    if (this.url !== undefined) return { url: this.url, token: this.token }
    this.server = createServer((request, response) => void this.handleHttp(request, response))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('Question bridge failed to bind')
    this.url = `http://127.0.0.1:${address.port}/question`
    return { url: this.url, token: this.token }
  }

  respond(questionId: string, answer: QuestionAnswer): boolean {
    const pending = this.pending.get(questionId)
    if (pending === undefined) return false
    this.pending.delete(questionId)
    clearTimeout(pending.timer)
    pending.resolve(answer)
    return true
  }

  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve('unavailable')
    }
    this.pending.clear()
    const server = this.server
    this.server = undefined
    this.url = undefined
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handleHttp(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST' || request.url !== '/question' || !this.authorized(request.headers.authorization)) {
        response.writeHead(404).end()
        return
      }
      const questions = parseQuestions(JSON.parse(await readBody(request)))
      const questionId = randomUUID()
      const answer = await new Promise<QuestionAnswer | 'unavailable'>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(questionId)
          resolve('unavailable')
        }, QUESTION_TIMEOUT_MS)
        timer.unref()
        this.pending.set(questionId, { resolve, timer })
        this.emit(notification('question.request', { questionId, questions }))
      })
      response.writeHead(answer === 'unavailable' ? 503 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer === 'unavailable' ? { error: 'Question UI unavailable' } : answer))
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  }

  private authorized(value: string | undefined): boolean {
    const supplied = value?.startsWith('Bearer ') ? value.slice(7) : ''
    const left = Buffer.from(supplied)
    const right = Buffer.from(this.token)
    return left.length === right.length && timingSafeEqual(left, right)
  }
}

function parseQuestions(value: unknown): QuestionItem[] {
  const raw = record(value).questions
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) throw new Error('Invalid questions')
  return raw.map((item) => {
    const question = record(item)
    const id = bounded(question.id, 200)
    const prompt = bounded(question.question, 4_000)
    if (!id || !prompt) throw new Error('Invalid question item')
    const options = question.options === undefined ? undefined : parseOptions(question.options)
    const intent = record(question.intent)
    const detail = optional(question.detail, 64 * 1024)
    const header = optional(question.header, 200)
    const result: QuestionItem = {
      id,
      question: prompt,
      ...(detail === undefined ? {} : { detail }),
      ...(header === undefined ? {} : { header }),
      ...(options === undefined ? {} : { options }),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
      ...(intent.kind === 'plan-review' && typeof intent.approve === 'string'
        ? { intent: { kind: 'plan-review' as const, approve: intent.approve.slice(0, 200) } }
        : {}),
    }
    return result
  })
}

function parseOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error('Invalid question options')
  return value.map((item) => {
    const option = record(item)
    const label = bounded(option.label, 200)
    if (!label) throw new Error('Invalid question option')
    const description = optional(option.description, 2_000)
    return { label, ...(description ? { description } : {}) }
  })
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function bounded(value: unknown, max: number): string { return typeof value === 'string' ? value.slice(0, max).trim() : '' }
function optional(value: unknown, max: number): string | undefined { const result = bounded(value, max); return result || undefined }

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('Question request is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}
