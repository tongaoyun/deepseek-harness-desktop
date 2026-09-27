import type { HarnessRuntime, ImageRunInput, RunInput } from './runtime.js'
import type { BindableTask, DingTalkImConfiguration, LocalImRuntime, ScheduleRoute, TaskBinding } from './im-runtime.js'
import { diagnoseConfiguredConnectors } from './managed-mcp-plugin.js'
import { runLocalCapabilitySelfTest } from './self-test.js'
import type { QuestionAnswer } from './question-bridge.js'
import {
  errorData,
  failure,
  isJsonRpcRequest,
  notification,
  success,
  type JsonRpcOutput,
} from './protocol.js'

export class HostServer {
  private shuttingDown = false

  constructor(
    private readonly runtime: HarnessRuntime,
    private readonly emit: (output: JsonRpcOutput) => void,
    private readonly respondToApproval?: (approvalId: string, decision: 'allow' | 'reject') => boolean,
    private readonly imRuntime?: LocalImRuntime,
    private readonly respondToQuestion?: (questionId: string, answer: QuestionAnswer) => boolean,
  ) {}

  async handle(value: unknown): Promise<void> {
    if (!isJsonRpcRequest(value)) {
      this.emit(failure(null, -32600, 'Invalid Request'))
      return
    }

    try {
      if (this.shuttingDown && value.method !== 'host.shutdown') {
        this.emit(failure(value.id, -32000, 'Host is shutting down'))
        return
      }

      switch (value.method) {
        case 'approval.respond': {
          const response = parseApprovalResponse(value.params)
          if (this.respondToApproval === undefined || !this.respondToApproval(response.approvalId, response.decision)) {
            this.emit(failure(value.id, -32004, 'Approval request is no longer pending'))
          } else {
            this.emit(success(value.id, { status: 'accepted' }))
          }
          return
        }
        case 'question.respond': {
          const response = parseQuestionResponse(value.params)
          if (this.respondToQuestion === undefined || !this.respondToQuestion(response.questionId, response.answer)) {
            this.emit(failure(value.id, -32004, 'Question request is no longer pending'))
          } else {
            this.emit(success(value.id, { status: 'accepted' }))
          }
          return
        }
        case 'host.health':
          this.emit(success(value.id, await this.runtime.health()))
          return
        case 'host.initialize':
          this.emit(success(value.id, await this.runtime.initialize()))
          return
        case 'host.self-test':
          this.emit(success(value.id, await runLocalCapabilitySelfTest()))
          return
        case 'host.inventory-check':
          this.emit(success(value.id, await runLocalCapabilitySelfTest(false)))
          return
        case 'session.inspect': {
          const sessionId = parseSessionId(value.params)
          if (!this.runtime.inspectSession) throw new Error('Session inspection is unavailable')
          this.emit(success(value.id, await this.runtime.inspectSession(sessionId)))
          return
        }
        case 'session.search': {
          const input = parseSessionSearch(value.params)
          if (!this.runtime.searchSessions) throw new Error('Session search is unavailable')
          this.emit(success(value.id, await this.runtime.searchSessions(input.sessionIds, input.query, input.limit, input.cursor)))
          return
        }
        case 'provider.check': {
          if (!this.runtime.checkProvider) throw new Error('模型服务检查不可用')
          this.emit(success(value.id, await this.runtime.checkProvider()))
          return
        }
        case 'connectors.diagnose':
          this.emit(success(value.id, await diagnoseConfiguredConnectors()))
          return
        case 'im.configure':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, await this.imRuntime.configure(parseImConfiguration(value.params))))
          return
        case 'im.status':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, this.imRuntime.status()))
          return
        case 'im.allow-pairing':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, this.imRuntime.allowPairing(parseConversationKey(value.params))))
          return
        case 'im.revoke-pairing':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, this.imRuntime.revokePairing(parseConversationKey(value.params))))
          return
        case 'im.bind-task':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, await this.imRuntime.bindTask(parseTaskBinding(value.params))))
          return
        case 'im.unbind-task':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, await this.imRuntime.unbindTask(parseConversationKey(value.params))))
          return
        case 'im.retry-delivery':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, await this.imRuntime.retryDelivery(parseConversationKey(value.params))))
          return
        case 'im.sync-tasks':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, this.imRuntime.syncTasks(parseBindableTasks(value.params))))
          return
        case 'im.route-schedule':
          if (this.imRuntime === undefined) throw new Error('Local IM runtime is unavailable')
          this.emit(success(value.id, await this.imRuntime.routeSchedule(parseScheduleRoute(value.params))))
          return
        case 'im.stop':
          await this.imRuntime?.stop()
          this.emit(success(value.id, { status: 'stopped' }))
          return
        case 'session.run': {
          const input = parseRunInput(value.params)
          const result = await this.runtime.run(input, (event, rootSessionId) => {
            this.emit(notification('session.notification', {
              requestId: value.id,
              rootSessionId,
              event,
            }))
          })
          this.emit(success(value.id, result))
          return
        }
        case 'session.steer': {
          const input = parseSteerInput(value.params)
          if (!this.runtime.steer) throw new Error('Session steering is unavailable')
          this.emit(success(value.id, await this.runtime.steer(input.sessionId, input.text)))
          return
        }
        case 'session.fork': {
          const sessionId = parseSessionId(value.params)
          const atSeq = parseOptionalSequence(value.params)
          if (!this.runtime.fork) throw new Error('Session forking is unavailable')
          this.emit(success(value.id, await this.runtime.fork(sessionId, atSeq)))
          return
        }
        case 'session.interrupt': {
          const sessionId = parseSessionId(value.params)
          if (!this.runtime.interrupt) throw new Error('Session interruption is unavailable')
          this.emit(success(value.id, await this.runtime.interrupt(sessionId)))
          return
        }
        case 'host.shutdown':
          this.shuttingDown = true
          await this.imRuntime?.stop()
          await this.runtime.close()
          this.emit(success(value.id, { status: 'closed' }))
          return
        default:
          this.emit(failure(value.id, -32601, `Method not found: ${value.method}`))
      }
    } catch (error) {
      const structured = errorData(error)
      this.emit(failure(value.id, -32001, structured.detail, structured))
    }
  }
}

function parseSessionId(params: unknown): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new Error('session.inspect params must be an object')
  const sessionId = (params as Record<string, unknown>).sessionId
  if (typeof sessionId !== 'string' || !/^[-a-zA-Z0-9_:.]{1,256}$/u.test(sessionId)) throw new Error('session.inspect sessionId is invalid')
  return sessionId
}

function parseOptionalSequence(params: unknown): number | undefined {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined
  const value = (params as Record<string, unknown>).atSeq
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('session.fork atSeq is invalid')
  return value as number
}

function parseSessionSearch(params: unknown): { sessionIds: string[]; query: string; limit: number; cursor?: string } {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new Error('session.search params must be an object')
  const value = params as Record<string, unknown>
  if (!Array.isArray(value.sessionIds) || value.sessionIds.length > 2_000 || value.sessionIds.some((id) => typeof id !== 'string' || !/^[-a-zA-Z0-9_:.]{1,256}$/u.test(id))) throw new Error('session.search sessionIds are invalid')
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 500) throw new Error('session.search query is invalid')
  const limit = value.limit === undefined ? 100 : value.limit
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error('session.search limit is invalid')
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length === 0 || value.cursor.length > 8_192)) throw new Error('session.search cursor is invalid')
  return { sessionIds: value.sessionIds, query: value.query, limit: Number(limit), ...(value.cursor === undefined ? {} : { cursor: value.cursor }) }
}

function parseImConfiguration(params: unknown): DingTalkImConfiguration {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('im.configure params must be an object')
  }
  const value = params as Record<string, unknown>
  if (typeof value.clientId !== 'string' || typeof value.clientSecret !== 'string') {
    throw new Error('im.configure requires DingTalk credentials')
  }
  if (value.accessPolicy !== 'open' && value.accessPolicy !== 'pairing') {
    throw new Error('im.configure accessPolicy must be open or pairing')
  }
  if (!Array.isArray(value.pairedConversations) || value.pairedConversations.some((item) => typeof item !== 'string')) {
    throw new Error('im.configure pairedConversations must be a string array')
  }
  if (typeof value.notifyTaskResults !== 'boolean') {
    throw new Error('im.configure notifyTaskResults must be a boolean')
  }
  return {
    clientId: value.clientId,
    clientSecret: value.clientSecret,
    accessPolicy: value.accessPolicy,
    pairedConversations: value.pairedConversations as string[],
    notifyTaskResults: value.notifyTaskResults,
  }
}

function parseConversationKey(params: unknown): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('im.allow-pairing params must be an object')
  }
  const value = (params as Record<string, unknown>).conversationKey
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw new Error('im.allow-pairing conversationKey is invalid')
  }
  return value
}

function parseTaskBinding(params: unknown): TaskBinding {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('im.bind-task params must be an object')
  }
  const value = params as Record<string, unknown>
  for (const field of ['conversationKey', 'taskId', 'taskName', 'sessionId'] as const) {
    if (typeof value[field] !== 'string') throw new Error(`im.bind-task params.${field} must be a string`)
  }
  return value as unknown as TaskBinding
}

function parseBindableTasks(params: unknown): BindableTask[] {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('im.sync-tasks params must be an object')
  }
  const tasks = (params as Record<string, unknown>).tasks
  if (!Array.isArray(tasks) || tasks.length > 200) throw new Error('im.sync-tasks params.tasks must be an array')
  return tasks.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('im.sync-tasks task is invalid')
    const task = item as Record<string, unknown>
    for (const field of ['id', 'name', 'sessionId'] as const) {
      if (typeof task[field] !== 'string') throw new Error(`im.sync-tasks task.${field} must be a string`)
    }
    return task as unknown as BindableTask
  })
}

function parseScheduleRoute(params: unknown): ScheduleRoute {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('im.route-schedule params must be an object')
  }
  const value = params as Record<string, unknown>
  if (typeof value.scheduleId !== 'string' || typeof value.conversationKey !== 'string') {
    throw new Error('im.route-schedule requires scheduleId and conversationKey')
  }
  return value as unknown as ScheduleRoute
}

function parseApprovalResponse(params: unknown): { approvalId: string; decision: 'allow' | 'reject' } {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('approval.respond params must be an object')
  }
  const record = params as Record<string, unknown>
  if (typeof record.approvalId !== 'string' || record.approvalId.length === 0 || record.approvalId.length > 200) {
    throw new Error('approval.respond params.approvalId must be a string')
  }
  if (record.decision !== 'allow' && record.decision !== 'reject') {
    throw new Error('approval.respond params.decision must be allow or reject')
  }
  return { approvalId: record.approvalId, decision: record.decision }
}

function parseQuestionResponse(params: unknown): { questionId: string; answer: QuestionAnswer } {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('question.respond params must be an object')
  }
  const record = params as Record<string, unknown>
  if (typeof record.questionId !== 'string' || !record.questionId || record.questionId.length > 200) {
    throw new Error('question.respond params.questionId must be a string')
  }
  if (!Array.isArray(record.answers) || record.answers.length === 0 || record.answers.length > 3) {
    throw new Error('question.respond params.answers must be an array')
  }
  const answers = record.answers.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('question answer is invalid')
    const answer = item as Record<string, unknown>
    if (typeof answer.id !== 'string' || !answer.id || answer.id.length > 200) throw new Error('question answer id is invalid')
    if (!Array.isArray(answer.selected) || answer.selected.some((entry) => typeof entry !== 'string')) {
      throw new Error('question answer selected is invalid')
    }
    if (answer.selected.length > 12 || answer.custom !== undefined && typeof answer.custom !== 'string') {
      throw new Error('question answer is too large')
    }
    return {
      id: answer.id,
      selected: (answer.selected as string[]).map((entry) => entry.slice(0, 200)),
      ...(typeof answer.custom === 'string' ? { custom: answer.custom.slice(0, 16 * 1024) } : {}),
    }
  })
  return { questionId: record.questionId, answer: { answers } }
}

function parseSteerInput(params: unknown): { sessionId: string; text: string } {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('session.steer params must be an object')
  }
  const record = params as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || !record.sessionId) throw new Error('session.steer params.sessionId must be a non-empty string')
  if (typeof record.text !== 'string' || record.text.trim().length === 0) throw new Error('session.steer params.text must be a non-blank string')
  return { sessionId: record.sessionId, text: record.text }
}

function parseRunInput(params: unknown): RunInput {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error('session.run params must be an object')
  }
  const record = params as Record<string, unknown>
  if (typeof record.prompt !== 'string' || record.prompt.trim().length === 0) {
    throw new Error('session.run params.prompt must be a non-blank string')
  }
  if (record.sessionId !== undefined && typeof record.sessionId !== 'string') {
    throw new Error('session.run params.sessionId must be a string')
  }
  return {
    prompt: record.prompt,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId as string }),
    images: parseRunImages(record.images),
  }
}

function parseRunImages(value: unknown): ImageRunInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 4) throw new Error('session.run params.images is invalid')
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('session.run image is invalid')
    }
    const image = item as Record<string, unknown>
    if (image.mediaType !== 'image/png' && image.mediaType !== 'image/jpeg') {
      throw new Error('session.run image mediaType is invalid')
    }
    if (typeof image.dataBase64 !== 'string' || image.dataBase64.length === 0 || image.dataBase64.length > 14 * 1024 * 1024) {
      throw new Error('session.run image data is invalid')
    }
    if (typeof image.name !== 'string' || image.name.length === 0 || image.name.length > 255) {
      throw new Error('session.run image name is invalid')
    }
    const data = Buffer.from(image.dataBase64, 'base64')
    if (data.length === 0) throw new Error('session.run image data is invalid')
    return { data, mediaType: image.mediaType, name: image.name }
  })
}
