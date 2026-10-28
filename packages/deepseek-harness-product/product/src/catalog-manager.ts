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
  private epoch = 0
  private signature: string | undefined
  private readonly snapshot = new Map<CatalogMethod, unknown>()
  private readonly failures = new Map<CatalogMethod, unknown>()
  private readonly revisions = new Map<CatalogMethod, number>()
  private readonly lifecycle = new AbortController()
  private readonly operations = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly options: ProductCatalogManagerOptions) {}

  /** Refresh catalogs independently, preserving each last successful display result on failure.
   * @param signal - Optional caller cancellation; absent callers share a background refresh.
   * @returns Completion after all remote requests settle.
   */
  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('Product catalog has been disposed')
    if (signal === undefined && this.refreshOperation !== undefined) return this.refreshOperation
    const requestSignal = signal === undefined ? this.lifecycle.signal : AbortSignal.any([signal, this.lifecycle.signal])
    requestSignal.throwIfAborted()
    const refresh = this.loadSnapshot(requestSignal).finally(() => {
      this.operations.delete(refresh)
      if (this.refreshOperation === refresh) this.refreshOperation = undefined
      this.schedule()
    })
    this.operations.add(refresh)
    if (signal === undefined) this.refreshOperation = refresh
    return refresh
  }

  /** Read a catalog; knowledge always queries the server.
   * @param method - Catalog operation.
   * @param signal - Optional cancellation for a fresh remote read.
   * @returns Complete employee-visible catalog.
   */
  async read(method: ProductMethod, signal?: AbortSignal): Promise<unknown> {
    if (!isCatalogMethod(method)) throw new Error(`deepseek-harness product: method ${method} is not available`)
    if (signal !== undefined || method === 'knowledge.bases.list') {
      signal?.throwIfAborted()
      const epoch = this.epoch
      const revision = this.nextRevision(method)
      try {
        const value = await this.options.api?.listAll(CATALOG_ROUTES[method], 100, signal)
        if (value === undefined) throw new Error('Product server is unavailable')
        signal?.throwIfAborted()
        if (epoch === this.epoch && !this.closed && revision === this.revisions.get(method)) {
          this.snapshot.set(method, value)
          this.failures.delete(method)
        }
        return value
      } catch (error) {
        if (epoch === this.epoch && !this.closed && !signal?.aborted && revision === this.revisions.get(method)) {
          this.failures.set(method, error)
        }
        throw error
      }
    }
    if (!this.snapshot.has(method)) {
      try { await this.refresh() }
      catch (error) { if (!this.snapshot.has(method)) throw this.failures.get(method) ?? error }
    }
    const value = this.snapshot.get(method) ?? []
    return value
  }

  /** Drop employee-scoped state when authentication identity changes. */
  reset(): void {
    this.epoch += 1
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
    if (this.closed || !this.options.getSession().authenticated || this.options.api === undefined) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refresh().catch(() => undefined)
    }, CATALOG_REFRESH_INTERVAL_MS)
    this.refreshTimer.unref()
  }

  /** Stop the manager's background timer. */
  async dispose(): Promise<void> {
    this.closed = true
    this.lifecycle.abort(new Error('Product catalog has been disposed'))
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    await Promise.allSettled([...this.operations])
  }

  private async loadSnapshot(signal: AbortSignal): Promise<void> {
    signal = AbortSignal.any([signal, this.options.getIdentitySignal()])
    const api = this.options.api
    if (api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    await this.options.ensureFreshSession()
    signal.throwIfAborted()
    const epoch = this.epoch
    const employeeId = this.options.getSession().employeeId
    const routes = Object.entries(CATALOG_ROUTES) as [CatalogMethod, string][]
    const requests = await Promise.all(routes.map(async ([method, route]) => {
      const revision = this.nextRevision(method)
      try { return { method, revision, result: { status: 'fulfilled', value: await api.listAll(route, 100, signal) } as const } }
      catch (reason) { return { method, revision, result: { status: 'rejected', reason } as const } }
    }))
    signal.throwIfAborted()
    const current = this.options.getSession()
    if (this.closed || epoch !== this.epoch || !current.authenticated || employeeId !== current.employeeId) return
    for (const { method, revision, result } of requests) {
      if (revision !== this.revisions.get(method)) continue
      if (result.status === 'fulfilled') {
        this.snapshot.set(method, result.value)
        this.failures.delete(method)
      } else this.failures.set(method, result.reason)
    }
    const nextSignature = JSON.stringify([[...this.snapshot], [...this.failures.keys()]])
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
