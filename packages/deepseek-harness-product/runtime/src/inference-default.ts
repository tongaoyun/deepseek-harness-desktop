/** Add company model routes and repair defaults rejected by the native LLM registry. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-settings'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { catalogModelInfo, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'

interface Options { baseURL: string; models: [string, ...string[]] }
export const name = 'product-inference-default'
export const inject = ['agentDefaultModel', 'llm', 'settings']
export const Config = z.object({
  baseURL: z.string().required(),
  models: z.array(z.string().required()).min(1).required(),
})
const COMPANY_KEY = 'DSH_PRODUCT_MODEL_API_KEY'

/** Keep native adapters and valid user selections while adding company models.
 * @param ctx Native LLM, Settings and persisted default model services.
 * @param config Company endpoint and exact model IDs; credentials remain in the launch environment.
 */
export function apply(ctx: Context, config: Options): void {
  const deepseek = config.models.filter(model => model.startsWith('deepseek-'))
  const generic = config.models.filter(model => !model.startsWith('deepseek-'))
  if (deepseek.length > 0) {
    const options = resolveAdapterOptions({ baseURL: config.baseURL, models: deepseek.map(id => ({ id, name: id })) })
    registerDeepSeekProvider(ctx, 'product-deepseek', {
      providerName: 'Enterprise DeepSeek', options: () => options,
      resolveAuth: () => {
        const key = launchEnvironmentOf(ctx).getFrom(COMPANY_KEY, ['process'])?.value
        if (key === undefined) throw new LlmError('Company model credentials are unavailable; restart and sign in with DingTalk.', 'MISSING_CREDENTIAL')
        return Promise.resolve({ headers: { 'x-api-key': assertUsableApiKey(key, name, COMPANY_KEY) } })
      },
      discoverModels: provider => Promise.resolve(options.models.map(model => catalogModelInfo(provider, model))),
    })
  }
  const first = config.models[0]
  const fallback = { provider: first.startsWith('deepseek-') ? 'product-deepseek' : 'product-gateway', model: first }
  const companyGateway = generic.length === 0 ? undefined : {
    displayName: 'Enterprise models', apiKeyEnv: COMPANY_KEY, api: 'openai-completions', baseURL: config.baseURL,
    models: generic.map(id => ({ id, name: id })),
  }
  let gateway: Promise<void> | undefined
  const prepareGateway = () => gateway ??= (async () => {
    const value = ctx.settings.describe().find(row => row.ns === 'llm-pi-ai')?.user
    const providers = value !== null && typeof value === 'object' && 'providers' in value ? value.providers : undefined
    const route = providers !== null && typeof providers === 'object' && 'product-gateway' in providers ? providers['product-gateway'] : undefined
    if (isDeepStrictEqual(route, companyGateway)) return
    await ctx.settings.mutate('llm-pi-ai', companyGateway === undefined
      ? [{ op: 'unset', path: ['providers', 'product-gateway'] }]
      : [{ op: 'set', path: ['providers', 'product-gateway'], value: companyGateway }])
  })().catch((error: unknown) => { gateway = undefined; throw error })
  const available = async (selection: { provider: string; model: string }): Promise<boolean> => {
    if (!ctx.llm.listProviders().some(provider => provider.id === selection.provider)) return false
    const defaults = ctx.settings.describe().find(row => row.ns === 'agent-default-model')
    const saved = defaults?.user
    const nativePlaceholder = selection.provider === 'deepseek-official' && saved !== undefined
      && typeof saved === 'object' && saved !== null && !('provider' in saved) && !('model' in saved)
    // Native discovery hides the API-key route's catalog until its credential exists.
    if (nativePlaceholder && (await ctx.llm.listModels(selection.provider)).length === 0) return false
    try { await ctx.llm.resolveModelInfo(selection.provider, selection.model); return true }
    catch (error) {
      if (error instanceof LlmError && ['NO_ADAPTER', 'UNKNOWN_MODEL'].includes(error.code)) return false
      if (nativePlaceholder && error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return false
      throw error
    }
  }
  let pending: Promise<void> | undefined
  const repair = () => pending ??= (async () => {
    await prepareGateway()
    const previous = ctx.agentDefaultModel.currentSelection()
    if (await available(previous)) return
    const current = ctx.agentDefaultModel.currentSelection()
    if (current.provider !== previous.provider || current.model !== previous.model
      || current.reasoningEffort !== previous.reasoningEffort) return
    await ctx.agentDefaultModel.saveSelection(fallback)
  })().finally(() => { pending = undefined })
  ctx.effect(() => ctx.get('appReady')?.onReady(() => {
    void repair().catch((error: unknown) => { ctx.logger.error('Company model preparation failed', error) })
  }) ?? (() => {}), 'product-inference.ready')
  ctx.effect(() => async () => { await pending?.catch(() => undefined); await gateway?.catch(() => undefined) }, 'product-inference.selection')
  ctx.on('agent/created', async ({ agent, source }) => {
    const previous = ctx.agentDefaultModel.currentSelection()
    await repair()
    const selected = ctx.agentDefaultModel.currentSelection()
    if (source === 'startup' && (selected.provider !== previous.provider || selected.model !== previous.model)
      && agent.options.provider === previous.provider && agent.options.model === previous.model) {
      agent.options.provider = selected.provider
      agent.options.model = selected.model
      if (selected.reasoningEffort === undefined) delete agent.options.reasoningEffort
      else agent.options.reasoningEffort = selected.reasoningEffort
    }
  })
}
