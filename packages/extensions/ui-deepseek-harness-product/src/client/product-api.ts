/** Product protocol adapter over the desktop's namespace-only transport. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { isProductFailure, ProductError } from '@deepseek-harness/product/errors'

/** Credential-free product transport available to renderer consumers. */
export interface ProductApi {
  invoke(method: string, payload?: unknown, requestId?: string, timeoutMs?: number): Promise<unknown>
  cancel(requestId: string): void
  getSession(): Promise<{ readonly authenticated?: boolean; readonly employeeId?: string }>
  subscribe(listener: (event: { readonly type: string; readonly payload?: unknown }) => void): () => void
}
interface Transport {
  invoke(namespace: string, method: string, payload?: unknown, requestId?: string, timeoutMs?: number): Promise<unknown>
  cancel(namespace: string, requestId: string): void
  subscribe(namespace: string, listener: (event: unknown) => void): () => void
}

/** Invoke one product operation with one cancellation path shared by all views.
 * @param api - Product transport adapter.
 * @param method - Product operation name.
 * @param payload - Operation payload.
 * @param signal - Caller cancellation signal.
 * @param timeoutMs - Optional transport timeout.
 * @returns Operation result from the product bridge.
 */
export async function invokeProduct(api: ProductApi, method: string, payload: unknown, signal: AbortSignal,
  timeoutMs?: number): Promise<unknown> {
  signal.throwIfAborted()
  const requestId = randomUUID()
  const cancelled = Promise.withResolvers<never>()
  const cancel = (): void => {
    cancelled.reject(signal.reason instanceof Error ? signal.reason : new Error('Product request cancelled', { cause: signal.reason }))
    try { api.cancel(requestId) } catch { /* The request is already being torn down. */ }
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const value = await Promise.race([api.invoke(method, payload, requestId, timeoutMs), cancelled.promise])
    signal.throwIfAborted()
    return value
  } finally { signal.removeEventListener('abort', cancel) }
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
      if ('employeeId' in result && result.employeeId !== undefined && typeof result.employeeId !== 'string') throw new Error('Invalid employee identity')
      return { authenticated: result.authenticated,
        ...'employeeId' in result && typeof result.employeeId === 'string' ? { employeeId: result.employeeId } : {} }
    },
    subscribe: listener => transport.subscribe('product', (event) => {
      if (typeof event === 'object' && event !== null && 'type' in event && typeof event.type === 'string') listener({ type: event.type,
        ...'payload' in event ? { payload: event.payload } : {} })
    }),
  }
}
