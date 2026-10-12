import type { Context } from '@deepseek-ai/cordis'
import { assertProductPayload, type ProductTaskCapabilityRequest } from '@deepseek-harness/product/protocol'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { ProductData } from './data.ts'
import { DeepSeekHarnessProductIpc } from './deepseek-harness-product-ipc.ts'
import { apply as mountRuntime, inject, type DeepSeekHarnessRuntimeControl } from './runtime.ts'
import * as CapabilityPrompt from './capability-prompt.ts'
import { renderKnowledgeOffice } from './knowledge-preview.ts'

export { inject }
export const name = 'product-runtime'

/** Loader entry owns process listeners, bridge requests, and all runtime registrations. */
export async function apply(ctx: Context): Promise<void> {
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
    if (!closed && process.connected) process.send?.(message)
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
      if (message.method === 'skills.install' || message.method === 'skills.uninstall') {
        if (typeof payload.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(payload.id)) throw new Error('Invalid Skill identity')
        return message.method === 'skills.install' ? control.installSkill(payload.id, controller.signal)
          : control.uninstallSkill(payload.id, controller.signal)
      }
      if (message.method === 'skills.installed.read') return control.readInstalledSkills(sessionId(payload), controller.signal)
      if (message.method === 'expertKits.install' || message.method === 'expertKits.uninstall') {
        if (typeof payload.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(payload.id)) throw new Error('Invalid Expert Kit identity')
        return message.method === 'expertKits.install' ? control.installExpertKit(payload.id, controller.signal)
          : control.uninstallExpertKit(payload.id, controller.signal)
      }
      if (message.method === 'expertKits.installed.read') return control.readInstalledExpertKits(controller.signal)
      const request = capabilityRequest(payload)
      if (message.method === 'tasks.capabilities.read') return control.readCapabilities(request)
      if (message.method === 'tasks.capabilities.prepare') return control.prepareCapabilities(request, controller.signal)
      throw new Error('Unsupported product runtime operation')
    })().then((result) =>{  send({ type: 'extension-control', requestId, result }) },
      (error: unknown) => { const failure = productFailure(error); send({ type: 'extension-control', requestId, error: failure.message, failure }) })
      .finally(() => { operations.delete(requestId as number) })
    operations.set(requestId as number, { controller, settled })
  }
  process.on('message', onMessage)
  ctx.effect(() => async () => {
    closed = true
    for (const operation of operations.values()) operation.controller.abort(new Error('Product plugin unloaded'))
    await Promise.allSettled([...operations.values()].map(operation => operation.settled))
    process.off('message', onMessage)
    product.close()
  }, 'product-runtime.ipc')
  await mountRuntime(ctx, { product, publishControl: (value) => { control = value } })
}

function sessionId(payload: Record<string, unknown>): string | undefined {
  const value = payload.sessionId
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new Error('Invalid Session identity')
  return value
}

function capabilityRequest(payload: Record<string, unknown>): ProductTaskCapabilityRequest {
  const request: {
    sessionId?: string
    basePresetId?: string
    expertKitId?: string | null
    expertKitTaskId?: string
    connectorIds?: string[]
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
  if (payload.expertKitId !== undefined) {
    if (payload.expertKitId !== null && (typeof payload.expertKitId !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(payload.expertKitId))) throw new Error('Invalid Expert Kit identity')
    request.expertKitId = payload.expertKitId
  }
  if (payload.expertKitTaskId !== undefined) {
    if (typeof payload.expertKitTaskId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(payload.expertKitTaskId)) {
      throw new Error('Invalid Expert Kit shortcut identity')
    }
    request.expertKitTaskId = payload.expertKitTaskId
  }
  if ('addSkillIds' in payload) throw new Error('Install skills with skills.install')
  for (const key of ['connectorIds', 'knowledgeBaseIds'] as const) {
    const values = payload[key]
    if (values === undefined) continue
    if (!Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string' || value.length === 0 || value.length > 256)) {
      throw new Error(`Invalid capability selection: ${key}`)
    }
    request[key] = values as string[]
  }
  return request
}
