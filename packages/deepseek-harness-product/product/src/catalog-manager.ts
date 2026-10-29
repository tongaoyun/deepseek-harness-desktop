/** Employee-scoped product catalogs. */

import type { DeepSeekHarnessApiClient } from './http-client.ts'
import type {
  ProductEvent,
  ProductMethod,
  ProductSession,
} from './protocol.ts'

const CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1_000
const CATALOG_ROUTES = {
  'connectors.list': '/api/v1/connectors',
  'knowledge.bases.list': '/api/v1/knowledge-bases',
} as const satisfies Partial<Record<ProductMethod, string>>
type CatalogMethod = keyof typeof CATALOG_ROUTES

/** Employee identity and transport owned by Electron main. */
export interface ProductCatalogManagerOptions {
  readonly api?: DeepSeekHarnessApiClient | undefined
  readonly getSession: () => ProductSession
  readonly ensureFreshSession: () => Promise<void>
  readonly getIdentitySignal: () => AbortSignal
  readonly emit: (event: ProductEvent) => void
}

/** Owns employee-scoped catalog results independently; knowledge reads always query the server. */
export class ProductCatalogManager {
  private refreshOperation: Promise<void> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private generation = new AbortController()
  private signature: string | undefined
  private readonly snapshot = new Map<CatalogMethod, unknown>()
  private readonly failures = new Map<CatalogMethod, unknown>()
  private readonly revisions = new Map<CatalogMethod, number>()
  private readonly lifecycle = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  constructor(private readonly options: ProductCatalogManagerOptions) {}

  /** Refresh catalogs independently, preserving each last successful display result on failure.
   * @param signal - Optional caller cancellation; absent callers share a background refresh.
   * @returns Completion after all remote requests settle.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    this.lifecycle.signal.throwIfAborted()
    if (signal === undefined && this.refreshOperation !== undefined) return this.refreshOperation
    const refresh = this.track(signal, control => this.loadSnapshot(control)).finally(() => {
      if (this.refreshOperation === refresh) this.refreshOperation = undefined
      this.schedule()
    })
    if (signal === undefined) this.refreshOperation = refresh
    return refresh
  }

  /** Read a catalog; knowledge always queries the server.
   * @param method - Catalog operation.
   * @param signal - Optional cancellation for a fresh remote read.
   * @returns Complete employee-visible catalog; reset, identity change, or disposal rejects pending reads.
   */
  async read(method: ProductMethod, signal?: AbortSignal): Promise<unknown> {
    if (!isCatalogMethod(method)) throw new Error(`deepseek-harness product: method ${method} is not available`)
    return this.track(signal, async (control) => {
      if (signal !== undefined || method === 'knowledge.bases.list') {
        const revision = this.nextRevision(method)
        try {
          const value = await this.options.api?.listAll(CATALOG_ROUTES[method], 100, control)
          control.throwIfAborted()
          if (value === undefined) throw new Error('Product server is unavailable')
          if (revision === this.revisions.get(method)) {
            this.snapshot.set(method, value)
            this.failures.delete(method)
          }
          return value
        } catch (error) {
          control.throwIfAborted()
          if (revision === this.revisions.get(method)) this.failures.set(method, error)
          throw error
        }
      }
      if (!this.snapshot.has(method)) {
        try { await this.refresh() }
        catch (error) {
          control.throwIfAborted()
          if (!this.snapshot.has(method)) throw this.failures.get(method) ?? error
        }
      }
      return this.snapshot.get(method) ?? []
    })
  }

  private async track<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const control = AbortSignal.any([this.lifecycle.signal, this.generation.signal, this.options.getIdentitySignal(),
      ...signal === undefined ? [] : [signal]])
    control.throwIfAborted()
    const pending = Promise.resolve().then(async () => {
      control.throwIfAborted()
      const value = await operation(control)
      control.throwIfAborted()
      return value
    })
    this.operations.add(pending)
    try { return await pending }
    finally { this.operations.delete(pending) }
  }

  /** Cancel pending reads and drop cached catalogs after identity or catalog changes. */
  reset(): void {
    this.generation.abort(new Error('Product catalog was reset'))
    this.generation = new AbortController()
    this.snapshot.clear()
    this.failures.clear()
    this.revisions.clear()
    this.signature = undefined
    this.refreshOperation = undefined
  }

  /** Schedule the next refresh only while an employee is authenticated. */
  schedule(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    if (this.lifecycle.signal.aborted || !this.options.getSession().authenticated || this.options.api === undefined) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refresh().catch(() => undefined)
    }, CATALOG_REFRESH_INTERVAL_MS)
    this.refreshTimer.unref()
  }

  /** Cancel catalog reads and refreshes, stop the timer, and await transport settlement. */
  async dispose(): Promise<void> {
    this.lifecycle.abort(new Error('Product catalog has been disposed'))
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    await Promise.allSettled([...this.operations])
  }

  private async loadSnapshot(signal: AbortSignal): Promise<void> {
    const api = this.options.api
    if (api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    await this.options.ensureFreshSession()
    signal.throwIfAborted()
    const employeeId = this.options.getSession().employeeId
    const routes = Object.entries(CATALOG_ROUTES) as [CatalogMethod, string][]
    const requests = await Promise.all(routes.map(async ([method, route]) => {
      const revision = this.nextRevision(method)
      try { return { method, revision, result: { status: 'fulfilled', value: await api.listAll(route, 100, signal) } as const } }
      catch (reason) { return { method, revision, result: { status: 'rejected', reason } as const } }
    }))
    signal.throwIfAborted()
    const current = this.options.getSession()
    if (!current.authenticated || employeeId !== current.employeeId) return
    for (const { method, revision, result } of requests) {
      if (revision !== this.revisions.get(method)) continue
      if (result.status === 'fulfilled') {
        this.snapshot.set(method, result.value)
        this.failures.delete(method)
      } else this.failures.set(method, result.reason)
    }
    // Compare payloads as well as routes. A same-route update must invalidate
    // renderer caches even when the catalog shape and keys stay unchanged.
    const nextSignature = JSON.stringify({
      snapshot: [...this.snapshot.entries()],
      failures: [...this.failures.keys()],
    })
    const changed = nextSignature !== this.signature
    this.signature = nextSignature
    if (changed && requests.some(entry => entry.result.status === 'fulfilled')) this.emitChanged()
    const failure = requests.find(entry => entry.result.status === 'rejected')?.result
    if (failure?.status === 'rejected') throw failure.reason
  }

  private nextRevision(method: CatalogMethod): number {
    const revision = (this.revisions.get(method) ?? 0) + 1
    this.revisions.set(method, revision)
    return revision
  }

  private emitChanged(): void {
    this.options.emit({
      type: 'catalog.changed',
      payload: { employeeId: this.options.getSession().employeeId, refreshedAt: Date.now() },
    })
  }
}

function isCatalogMethod(method: ProductMethod): method is CatalogMethod {
  return Object.hasOwn(CATALOG_ROUTES, method)
}
