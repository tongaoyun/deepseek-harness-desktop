import type { ProductRuntimeMethod } from '@deepseek-harness/product/protocol'

/** Catalog-only fixture for product profile startup without employee credentials. */
export function invokeSmokeProduct(method: ProductRuntimeMethod): Promise<unknown> {
  if (['skills.list', 'expertKits.list', 'connectors.list'].includes(method)) return Promise.resolve([])
  return Promise.reject(new Error(`desktop runtime: unexpected product operation ${method}`))
}
