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

/** Access the private transport after Loader has satisfied the declared injection.
 * @param ctx Product plugin context.
 * @returns Credential-free main-process transport.
 */
export function getProductData(ctx: Context): ProductData { return ctx.get('productData') as ProductData }
