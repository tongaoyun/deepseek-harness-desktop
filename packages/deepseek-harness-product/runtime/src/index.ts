import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { assertProductPayload, parseTaskCapabilityRequest } from '@deepseek-harness/product/protocol'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import type { DiscoveryOptions } from './connector-discovery.ts'
import { ProductData } from './data.ts'
import { CompanyContent } from './company-content.ts'
import { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import { apply as mountRuntime, inject, type DeepSeekHarnessRuntimeControl } from './runtime.ts'
import * as CapabilityPrompt from './capability-prompt.ts'
import { renderKnowledgeOffice } from './knowledge-preview.ts'

export { inject }
export const name = 'product-runtime'
/** Runtime bounds for discovering and admitting connector tools. */
export interface Config {
  /** Result count, loaded-tool count, and complete response byte limits. */
  readonly connectorDiscovery?: DiscoveryOptions
}
export const Config = z.object({ connectorDiscovery: z.object({
  maxResults: z.number().step(1).min(1).max(50).default(8),
  maxLoadedTools: z.number().step(1).min(1).max(500).default(64),
  maxResultBytes: z.number().step(1).min(1024).max(1_048_576).default(32_768),
}) })

/** Loader entry owns process listeners, bridge requests, and all runtime registrations. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  ctx.effect(() => {
    if (ctx.loader.builtins['product-task-capabilities'] !== undefined) throw new Error('Product task prompt is already registered')
    ctx.loader.builtins['product-task-capabilities'] = CapabilityPrompt
    return () => { delete ctx.loader.builtins['product-task-capabilities'] }
  }, 'product-runtime.prompt-plugin')
  const product = new DeepSeekHarnessProductIpc()
  new ProductData(ctx, product)
  let control: DeepSeekHarnessRuntimeControl | undefined
  let closed = false
  const operations = new Map<number, { controller: AbortController; settled: Promise<unknown> }>()
  const send = (message: object) => {
    if (closed || !process.connected) return
    const failed = () => {
      ctx.logger.error('Product control response could not reach Electron. The operation may have completed; reopen the page to inspect its state before retrying.')
    }
    if (process.send === undefined) { failed(); return }
    try {
      process.send(message, (error) => { if (error != null) failed() })
    } catch (_error) {
      // Sending a response cannot undo completed work or replay its operation.
      failed()
    }
  }
  const onMessage = (message: unknown): void => {
    if (product.handle(message)) return
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'extension-control-cancel'
      && 'namespace' in message && message.namespace === 'product' && 'requestId' in message && typeof message.requestId === 'number') {
      operations.get(message.requestId)?.controller.abort(new ProductError('PRODUCT_REQUEST_CANCELLED', 'Product request cancelled', true))
      return
    }
    if (typeof message !== 'object' || message === null || !('type' in message)
      || message.type !== 'extension-control' || !('namespace' in message) || message.namespace !== 'product'
      || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('method' in message) || typeof message.method !== 'string') return
    const requestId = message.requestId
    if (closed || operations.has(requestId as number)) return
    const controller = new AbortController()
    const settled = (async () => {
      if (control === undefined) throw new Error('Product runtime is unavailable')
      const payload = assertProductPayload('payload' in message ? message.payload : undefined)
      if (message.method === 'knowledge.documents.renderOffice') return renderKnowledgeOffice(ctx, product, payload, controller.signal)
      if (message.method === 'connectors.refresh') {
        if (Object.keys(payload).length !== 0) throw new Error('Connector refresh does not accept parameters')
        return control.refreshConnectors(controller.signal)
      }
      const request = parseTaskCapabilityRequest(payload)
      if (message.method === 'tasks.capabilities.read') return control.readCapabilities(request, controller.signal)
      if (message.method === 'tasks.capabilities.prepare') return control.prepareCapabilities(request, controller.signal)
      throw new Error('Unsupported product runtime operation')
    })().then((result) => { send({ type: 'extension-control', requestId, result }) },
      (error: unknown) => { const failure = productFailure(error); send({ type: 'extension-control', requestId, error: failure.message, failure }) })
      .finally(() => { operations.delete(requestId as number) })
    operations.set(requestId as number, { controller, settled })
  }
  process.on('message', onMessage)
  new CompanyContent(ctx, product)
  ctx.effect(() => async () => {
    closed = true
    process.off('message', onMessage)
    product.close('Product plugin unloaded')
    for (const operation of operations.values()) operation.controller.abort(new Error('Product plugin unloaded'))
    await Promise.allSettled([...operations.values()].map(operation => operation.settled))
  }, 'product-runtime.ipc')
  await mountRuntime(ctx, { product, connectorDiscovery: config.connectorDiscovery ?? {}, publishControl: (value) => { control = value } })
}
