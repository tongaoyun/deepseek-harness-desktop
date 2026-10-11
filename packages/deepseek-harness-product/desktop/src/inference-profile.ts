/** Credential-free Loader overlays for the server's exact inference routes. */
import type { ProductRuntimeBootstrap } from '@deepseek-harness/product/bridge'

/** Compose server-advertised models over the official adapters.
 * @param bootstrap Main-process bootstrap; its API key is never serialized.
 * @param defaultPlugin Public product-runtime entry that repairs an unavailable default.
 * @returns Loader patch rows containing only model and endpoint metadata.
 */
export function inferenceProfile(bootstrap: ProductRuntimeBootstrap, defaultPlugin: string) {
  const deepseek = bootstrap.models.filter(id => id.startsWith('deepseek-'))
  const generic = bootstrap.models.filter(id => !id.startsWith('deepseek-'))
  const selections = bootstrap.models.map(model => ({ provider: deepseek.includes(model) ? 'deepseek-official' : 'product-gateway', model }))
  return [
    { id: 'llm-deepseek', disabled: deepseek.length === 0, config: { models: deepseek.map(id => ({ id, name: id })) } },
    // The product authenticates with DingTalk in the Electron main process. Keep the
    // account-backed model provider out of the final overlay, even when a previously
    // used Desktop profile still contains its row. This overlay is applied after the
    // persisted profile patch, so stale official-account selections cannot re-enable
    // the DeepSeek platform model route.
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'llm-pi-ai', config: { providers: generic.length === 0 ? {} : {
      'product-gateway': { displayName: 'Enterprise models', apiKeyEnv: 'DEEPSEEK_API_KEY',
        api: 'openai-completions', baseURL: bootstrap.endpoints.litellm,
        models: generic.map(id => ({ id, name: id })) },
    } } },
    // Hide the upstream account menu after all persisted rows have been composed. The
    // product owns authentication and exposes its DingTalk settings entry instead.
    { id: 'ui-settings-account', disabled: true },
    { insert: [{ id: 'product-inference-default', name: defaultPlugin, config: { selections } }] },
  ]
}
