import type { HarnessRuntime, RunInput } from './runtime.js'
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
        case 'host.health':
          this.emit(success(value.id, await this.runtime.health()))
          return
        case 'host.initialize':
          this.emit(success(value.id, await this.runtime.initialize()))
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
