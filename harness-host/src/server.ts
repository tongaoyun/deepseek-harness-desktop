import type { HarnessRuntime, RunInput } from './runtime.js'
import type { DingTalkImConfiguration, LocalImRuntime } from './im-runtime.js'
import {
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
        case 'host.health':
          this.emit(success(value.id, await this.runtime.health()))
          return
        case 'host.initialize':
          this.emit(success(value.id, await this.runtime.initialize()))
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
        case 'im.stop':
          await this.imRuntime?.stop()
          this.emit(success(value.id, { status: 'stopped' }))
          return
        case 'session.run': {
          const input = parseRunInput(value.params)
          const result = await this.runtime.run(input, (event) => {
            this.emit(notification('session.notification', {
              requestId: value.id,
              sessionId: input.sessionId,
              event,
            }))
          })
          this.emit(success(value.id, result))
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
      const message = error instanceof Error ? error.message : String(error)
      this.emit(failure(value.id, -32001, message))
    }
  }
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
  return {
    clientId: value.clientId,
    clientSecret: value.clientSecret,
    accessPolicy: value.accessPolicy,
    pairedConversations: value.pairedConversations as string[],
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
  }
}
