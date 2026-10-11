/** Bounded renderer requests; cancellation is routed to the same namespace and identity. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { isExtensionFailure, type ExtensionResponse } from './extension-errors.ts'

/** Carry structured replies through preload; callers decode failures in their own world.
 * @param invoke - Main-process namespace transport.
 * @param cancel - Cancellation routed to the same request identity.
 * @param namespace - Extension owning the operation.
 * @param method - Extension method name.
 * @param payload - Extension-defined request data.
 * @param requestId - Caller identity, or a generated UUID.
 * @param timeoutMs - Caller deadline in milliseconds, from 1 to 1800000; defaults to 60000.
 * @returns Validated success or public failure; timeout cancels and returns a retryable failure.
 */
export async function invokeExtension(
  invoke: (namespace: string, method: string, payload: unknown, requestId: string) => Promise<unknown>,
  cancel: (namespace: string, requestId: string) => void,
  namespace: string, method: string, payload?: unknown, requestId: string = randomUUID(), timeoutMs = 60_000,
): Promise<ExtensionResponse> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) throw new Error('Invalid extension request timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([invoke(namespace, method, payload, requestId), new Promise<ExtensionResponse>((resolve) => {
      timer = setTimeout(() => {
        cancel(namespace, requestId)
        resolve({ ok: false, failure: { code: 'EXTENSION_REQUEST_TIMEOUT', message: 'Desktop extension request timed out',
          retryable: true, resources: [] } })
      }, timeoutMs)
    })])
    if (typeof response !== 'object' || response === null || !('ok' in response)) throw new Error('Invalid extension response')
    if (response.ok === true && 'result' in response) return { ok: true, result: response.result }
    if (response.ok === false && 'failure' in response && isExtensionFailure(response.failure)) return { ok: false, failure: response.failure }
    throw new Error('Invalid extension response')
  } finally { clearTimeout(timer) }
}
