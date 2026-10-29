/** Keep a valid saved model selection when product routes change. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-cmdline'
import z from '@deepseek-ai/schemastery'

interface Selection { provider: string; model: string }
interface Options { selections: [Selection, ...Selection[]] }
export const name = 'product-inference-default'
export const inject = ['agentDefaultModel']
export const Config = z.object({
  selections: z.array(z.object({ provider: z.string().required(), model: z.string().required() })).min(1).required(),
})

/** Replace an unavailable deployment default before task creation.
 * @param ctx Loader context carrying the official persisted default model service.
 * @param config Server-advertised provider/model pairs, ordered by preference.
 */
export function apply(ctx: Context, config: Options): void {
  const permitted = (selection: { provider?: string; model?: string }) => config.selections.some(row =>
    row.provider === selection.provider && row.model === selection.model)
  const previous = ctx.agentDefaultModel.currentSelection()
  let pending: Promise<void> | undefined
  const repair = () => pending ??= (async () => {
    if (!permitted(ctx.agentDefaultModel.currentSelection())) await ctx.agentDefaultModel.saveSelection(config.selections[0])
  })().finally(() => { pending = undefined })
  ctx.effect(() => ctx.get('appReady')?.onReady(() => {
    void repair().catch((error: unknown) => { ctx.logger.error('Product default model selection failed', error) })
  }) ?? (() => {}), 'product-inference.ready')
  ctx.effect(() => async () => { await pending?.catch(() => undefined) }, 'product-inference.selection')
  ctx.on('agent/created', async ({ agent, source }) => {
    await repair()
    if (source === 'startup' && !permitted(agent.options)
      && agent.options.provider === previous.provider && agent.options.model === previous.model) {
      const selected = ctx.agentDefaultModel.currentSelection()
      agent.options.provider = selected.provider
      agent.options.model = selected.model
      if (selected.reasoningEffort === undefined) delete agent.options.reasoningEffort
      else agent.options.reasoningEffort = selected.reasoningEffort
    }
  })
}
