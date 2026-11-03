/** Credential-free, additive company model composition. */
import type { ProductRuntimeBootstrap } from '@deepseek-harness/product/bridge'

/** Add company routes without replacing native providers or user configuration.
 * @param bootstrap Main-process bootstrap; its API key is never serialized.
 * @param defaultPlugin Public product-runtime entry that repairs an unavailable default.
 * @returns Loader patch rows containing only model and endpoint metadata.
 */
export function inferenceProfile(bootstrap: ProductRuntimeBootstrap, defaultPlugin: string) {
  return [
    { id: 'llm-deepseek-account', disabled: true },
    { id: 'ui-settings-account', disabled: true },
    { insert: [{ id: 'product-inference-default', name: defaultPlugin,
      config: { baseURL: bootstrap.endpoints.litellm, models: bootstrap.models } }] },
  ]
}
