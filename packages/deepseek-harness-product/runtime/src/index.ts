import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { assertProductPayload, type ProductTaskCapabilityRequest } from '@deepseek-harness/product/protocol'
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
/** Product runtime configuration. */
export interface Config {
  /** Limits for connector discovery results and tools loaded by one Session. */
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
      const request = capabilityRequest(payload)
      if (message.method === 'tasks.capabilities.read') return control.readCapabilities(request)
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

function sessionId(payload: Record<string, unknown>): string | undefined {
  const value = payload.sessionId
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error('Invalid Session identity')
  return value
}

function capabilityRequest(payload: Record<string, unknown>): ProductTaskCapabilityRequest {
  const fields = new Set(['sessionId', 'basePresetId', 'recoverCapabilities', 'knowledgeBaseIds'])
  for (const key of Object.keys(payload)) {
    if (!fields.has(key)) throw new ProductError('CAPABILITY_REQUEST_INVALID', `Unknown capability field: ${key}`, false)
  }
  const request: {
    sessionId?: string
    basePresetId?: string
    recoverCapabilities?: boolean
    knowledgeBaseIds?: string[]
  } = {}
  if (payload.recoverCapabilities !== undefined) {
    if (typeof payload.recoverCapabilities !== 'boolean') throw new Error('Invalid recovery request')
    request.recoverCapabilities = payload.recoverCapabilities
  }
  const session = sessionId(payload)
  if (session !== undefined) request.sessionId = session
  if (payload.basePresetId !== undefined) {
    if (typeof payload.basePresetId !== 'string' || payload.basePresetId.length === 0 || payload.basePresetId.length > 256) throw new Error('Invalid execution mode')
    request.basePresetId = payload.basePresetId
  }
  for (const key of ['knowledgeBaseIds'] as const) {
    const values = payload[key]
    if (values === undefined) continue
    if (!Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string' || value.length === 0 || value.length > 256)) {
      throw new Error(`Invalid capability selection: ${key}`)
    }
    request[key] = values as string[]
  }
  return request
}
