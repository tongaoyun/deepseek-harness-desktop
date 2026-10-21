/** Adapt the official storage domain to employee-scoped encrypted main-process persistence. */
import type { Context } from '@deepseek-ai/cordis'
import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { getProductData } from './data.ts'

const Snapshot = z.object({ tables: z.record(z.string(), z.record(z.string(), z.unknown())), global: z.null() }).strict()
export const name = 'product-mcp-storage'
export const inject = ['storage', 'productData']

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpConnectorStorage: DomainFacility
    mcpConnectorAccess: (signal?: AbortSignal) => Promise<void>
  }
}

/** Publish a private domain facility; the connector cannot fall back to plaintext storage.
 * @param ctx Loader scope with the official storage hub and product IPC.
 */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const bridge = getProductData(ctx)
  const units = new Set<KvUnit>()
  let employeeId: string | undefined
  const identity = async (signal: AbortSignal) => z.object({ authenticated: z.literal(true), employeeId: z.string().min(1) })
    .parse(await bridge.invoke('auth.getSession', undefined, signal)).employeeId
  ctx.provide('mcpConnectorAccess', async (signal?: AbortSignal) => {
    const requestSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    requestSignal.throwIfAborted()
    if (await identity(requestSignal) !== employeeId) throw new Error('MCP employee session changed; reload the connector plugin')
  })
  const backend: StorageBackend = {
    kv: { async open(descriptor: KvUnitDescriptor): Promise<KvUnit> {
      if (descriptor.name !== 'mcp_connector' || descriptor.version !== 1 || descriptor.hasGlobal) throw new Error('Unsupported MCP storage domain')
      const owner = await identity(lifetime.signal)
      employeeId = owner
      let closed = false
      const requests = new Set<Promise<unknown>>()
      const invoke = (input: object) => {
        if (closed || lifetime.signal.aborted) return Promise.reject(new Error('MCP storage is closed'))
        const pending = bridge.invoke('runtime.connectors.storage', { ...input, employeeId: owner }, lifetime.signal)
        requests.add(pending)
        void pending.finally(() => requests.delete(pending)).catch(() => undefined)
        return pending
      }
      const unit: KvUnit = {
        async loadAll() { return Snapshot.parse(await invoke({ operation: 'read' })) },
        async putRecord(table, key, value) { await invoke({ operation: 'put', table, key, value }) },
        async deleteRecord(table, key) { await invoke({ operation: 'delete', table, key }) },
        setGlobal() { return Promise.reject(new Error('MCP storage has no global slot')) },
        async close() { closed = true; await Promise.allSettled([...requests]); units.delete(unit) },
      }
      units.add(unit)
      return unit
    } },
    async close() { await Promise.allSettled([...units].map(unit => unit.close())) },
  }
  const domain = new DomainFacility(ctx, { backend: 'product_mcp_encrypted' })
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('product_mcp_encrypted', backend)
    return async () => {
      lifetime.abort(new Error('MCP storage plugin unloaded'))
      try { await domain.closeAll() }
      finally { unregister(); await backend.close() }
    }
  }, 'product-mcp: encrypted storage')
  ctx.provide('mcpConnectorStorage', domain)
}
