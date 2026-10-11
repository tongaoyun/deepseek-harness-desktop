/** Pin the selected capability identities in official model-visible Session history. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ProductTaskCapabilities } from '@deepseek-harness/product/protocol'

export const name = 'product-capability-prompt'
export const inject = ['systemPrompt']

/** Immutable, credential-free task selection rendered by the official prompt assembler. */
export interface Config { readonly capabilities: ProductTaskCapabilities }

/** Register task selections as a scoped section that the official loop logs with its system message.
 * @param ctx Preset-scoped context.
 * @param config Content identities and selected capability IDs.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'product-task-capabilities', order: 450,
    text: `Task capability snapshot:\n${JSON.stringify(config.capabilities)}`,
  }), 'product-task-capabilities.prompt')
}
