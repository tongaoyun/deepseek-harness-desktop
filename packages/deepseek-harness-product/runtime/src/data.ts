import { Service, type Context } from '@deepseek-ai/cordis'
import type { ProductRuntimeMethod } from '@deepseek-harness/product/protocol'
import type { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'

/** Credential-free product access inherited by preset scopes. */
export class ProductData extends Service {
  private readonly bridge: Pick<DeepSeekHarnessProductIpc, 'invoke'>
  constructor(ctx: Context, bridge: Pick<DeepSeekHarnessProductIpc, 'invoke'>) {
    super(ctx, 'productData')
    this.bridge = bridge
  }
  invoke(method: ProductRuntimeMethod, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.bridge.invoke(method, payload, signal)
  }
}

/**
 * Scope product RPC calls to one Cordis plugin lifetime.
 * Every caller signal is joined with the plugin signal, and disposal waits for
 * all requests that were started by that plugin before its resources vanish.
 */
export function scopedProductInvoker(product: Pick<DeepSeekHarnessProductIpc, 'invoke'>, reason: string): {
  readonly signal: AbortSignal
  readonly invoke: (method: ProductRuntimeMethod, payload: unknown, signal: AbortSignal) => Promise<unknown>
  readonly dispose: () => Promise<void>
} {
  const lifecycle = new AbortController()
  const pending = new Set<Promise<unknown>>()
  let disposed: Promise<void> | undefined
  const invoke = (method: ProductRuntimeMethod, payload: unknown, signal: AbortSignal): Promise<unknown> => {
    const combined = AbortSignal.any([signal, lifecycle.signal])
    combined.throwIfAborted()
    const operation = product.invoke(method, payload, combined)
    pending.add(operation)
    void operation.finally(() => { pending.delete(operation) }).catch(() => undefined)
    return operation
  }
  const dispose = async (): Promise<void> => {
    disposed ??= (async () => {
      lifecycle.abort(new Error(reason))
      await Promise.allSettled([...pending])
    })()
    await disposed
  }
  return { signal: lifecycle.signal, invoke, dispose }
}

/** Access the private transport after Loader has satisfied the declared injection.
 * @param ctx Product plugin context.
 * @returns Credential-free main-process transport.
 */
export function getProductData(ctx: Context): ProductData { return ctx.get('productData') as ProductData }
