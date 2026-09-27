import type { Context } from '@deepseek-ai/cordis'

/**
 * The official SDK JSON-RPC server owns the stdio protocol, while the
 * official Agent Registry owns session persistence. Its `session/prompt`
 * handler asks the registry to create an agent for every session id. A cold
 * persisted id is therefore the one case where the SDK server's create call
 * must be bridged to the registry's official resume operation.
 *
 * This is deliberately a runtime capability adapter: it adds no protocol
 * method, does not replay transcript text, and never mutates the upstream
 * package. The original method is restored with the plugin scope.
 */
export const name = 'xiaoyin-sdk-session-resume'
export const inject = ['agents']

export function apply(ctx: Context): void {
  const registry = ctx.agents
  const create = registry.create.bind(registry)
  const resume = registry.resume.bind(registry)

  registry.create = async (options) => {
    try {
      return await create(options)
    } catch (error) {
      if (!isAlreadyRegistered(error)) throw error
      return resume({
        resumeSessionId: options.sessionId,
        ...(options.agentOptions === undefined ? {} : { agentOptions: options.agentOptions }),
      })
    }
  }

  ctx.effect(() => () => {
    registry.create = create
  }, 'xiaoyin-sdk-session-resume')
}

function isAlreadyRegistered(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /session\s+"[^"\n]+"\s+already exists/u.test(message)
    || /agent\s+"[^"\n]+"\s+already exists/u.test(message)
}
