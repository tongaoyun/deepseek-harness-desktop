/** Pin the selected capability identities in official model-visible Session history. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ProductTaskCapabilities } from '@deepseek-harness/product/protocol'
import { ProductError, type ProductFailure } from '@deepseek-harness/product/errors'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'product-capability-prompt'
export const inject = ['systemPrompt']

/** Immutable, credential-free task selection rendered by the official prompt assembler. */
export type Config = { readonly capabilities: ProductTaskCapabilities } | { readonly failure: ProductFailure }

/** Register task selections as a scoped section that the official loop logs with its system message.
 * @param ctx Preset-scoped context.
 * @param config Content identities, or a restoration failure retained by the blocked generation.
 */
export function apply(ctx: Context, config: Config): void {
  if ('failure' in config) {
    ctx.on('agent/pre-step', () => {
      const failure = config.failure
      throw new ProductError(failure.code, failure.message, failure.retryable, failure.resources)
    })
    return
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'product-task-capabilities', order: 450,
    text: `Task capability snapshot:\n${JSON.stringify(config.capabilities)}`,
  }), 'product-task-capabilities.prompt')
}
