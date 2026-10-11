/** Product protocol adapter over the desktop's namespace-only transport. */
import { isProductFailure, ProductError } from '@deepseek-harness/product/errors'

/** Credential-free product transport available to renderer consumers. */
export interface ProductApi {
  invoke(method: string, payload?: unknown, requestId?: string, timeoutMs?: number): Promise<unknown>
  cancel(requestId: string): void
  getSession(): Promise<{ readonly authenticated?: boolean }>
  subscribe(listener: (event: { readonly type: string }) => void): () => void
}
interface Transport {
  invoke(namespace: string, method: string, payload?: unknown, requestId?: string, timeoutMs?: number): Promise<unknown>
  cancel(namespace: string, requestId: string): void
  subscribe(namespace: string, listener: (event: unknown) => void): () => void
}
/** Bind product methods to the desktop namespace transport.
 * @returns Product adapter, or undefined outside an extended desktop.
 */
export function productApi(): ProductApi | undefined {
  const transport = (globalThis as { dshDesktop?: { extensions?: Transport } }).dshDesktop?.extensions
  if (transport === undefined) return undefined
  const invoke: ProductApi['invoke'] = async (method, payload, requestId, timeoutMs) => {
    const response = await transport.invoke('product', method, payload, requestId, ...timeoutMs === undefined ? [] : [timeoutMs])
    if (typeof response !== 'object' || response === null || !('ok' in response)) throw new Error('Invalid product transport response')
    if (response.ok === true && 'result' in response) return response.result
    if (response.ok === false && 'failure' in response && isProductFailure(response.failure)) {
      const failure = response.failure
      throw new ProductError(failure.code, failure.message, failure.retryable, failure.resources,
        failure.dependencyChecks === undefined ? undefined : { dependencyChecks: failure.dependencyChecks })
    }
    throw new Error('Invalid product transport response')
  }
  return {
    invoke,
    cancel: (requestId) => { transport.cancel('product', requestId) },
    async getSession() {
      const result = await invoke('auth.getSession')
      if (typeof result !== 'object' || result === null || !('authenticated' in result) || typeof result.authenticated !== 'boolean') throw new Error('Invalid employee session response')
      return { authenticated: result.authenticated }
    },
    subscribe: listener => transport.subscribe('product', (event) => {
      if (typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string') listener({ type: event.type })
    }),
  }
}
