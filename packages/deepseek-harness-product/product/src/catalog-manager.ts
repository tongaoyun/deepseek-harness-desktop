/** Employee-scoped product catalogs and display-only availability estimates. */

import type { DeepSeekHarnessApiClient } from './http-client.ts'
import { compare, valid } from 'semver'
import type {
  ProductEvent,
  ProductMethod,
  ProductSession,
} from './protocol.ts'

const CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1_000
const CATALOG_ROUTES = {
  'expertKits.list': '/api/v1/expert-kits',
  'skills.list': '/api/v1/skills',
  'connectors.list': '/api/v1/connectors',
  'knowledge.bases.list': '/api/v1/knowledge-bases',
} as const satisfies Partial<Record<ProductMethod, string>>
type CatalogMethod = keyof typeof CATALOG_ROUTES

/** Employee identity, transport, and display version owned by Electron main. */
export interface ProductCatalogManagerOptions {
  readonly api?: DeepSeekHarnessApiClient | undefined
  readonly desktopVersion: string
  readonly getSession: () => ProductSession
  readonly ensureFreshSession: () => Promise<void>
  readonly getIdentitySignal: () => AbortSignal
  readonly emit: (event: ProductEvent) => void
}

/** Owns one employee's complete catalog snapshot; knowledge reads always query the server. */
export class ProductCatalogManager {
  private refreshOperation: Promise<void> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private signature: string | undefined
  private readonly snapshot = new Map<CatalogMethod, unknown>()
  private readonly lifecycle = new AbortController()
  private readonly operations = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly options: ProductCatalogManagerOptions) {}

  /** Refresh catalogs atomically, preserving the last display snapshot on failure.
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

  /** Read a catalog with display availability estimates; knowledge always queries the server.
   * @param method - Catalog operation.
   * @param signal - Optional cancellation for a fresh remote read.
   * @returns Complete employee-visible catalog.
   */
  async read(method: ProductMethod, signal?: AbortSignal): Promise<unknown> {
    if (!isCatalogMethod(method)) throw new Error(`deepseek-harness product: method ${method} is not available`)
    if (signal !== undefined || method === 'knowledge.bases.list') {
      signal?.throwIfAborted()
      const value = await this.options.api?.listAll(CATALOG_ROUTES[method], 100, signal)
      if (value === undefined) throw new Error('Product server is unavailable')
      return value.map(entry => catalogEntry(method, entry, this.snapshot, this.options.desktopVersion))
    }
    if (!this.snapshot.has(method)) await this.refresh()
    const value = this.snapshot.get(method) ?? []
    if (!Array.isArray(value)) return value
    return value.map(entry => catalogEntry(
      method, entry, this.snapshot, this.options.desktopVersion,
    ))
  }

  /** Drop employee-scoped state when authentication identity changes. */
  reset(): void {
    this.epoch += 1
    this.snapshot.clear()
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
    const controller = new AbortController()
    const requestSignal = AbortSignal.any([signal, controller.signal])
    const requests = await Promise.allSettled((Object.entries(CATALOG_ROUTES) as [CatalogMethod, string][])
      .map(async ([method, route]) => {
        try { return [method, await api.listAll(route, 100, requestSignal)] as const }
        catch (error) { controller.abort(error); throw error }
      }))
    const entries = requests.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
    const current = this.options.getSession()
    if (this.closed || epoch !== this.epoch || !current.authenticated || employeeId !== current.employeeId) return
    const nextSignature = JSON.stringify(entries)
    const changed = nextSignature !== this.signature
    this.snapshot.clear()
    for (const [method, value] of entries) this.snapshot.set(method, value)
    this.signature = nextSignature
    if (changed) this.emitChanged()
  }

  private emitChanged(): void {
    this.options.emit({
      type: 'catalog.changed',
      payload: { employeeId: this.options.getSession().employeeId, refreshedAt: Date.now() },
    })
  }
}

function isCatalogMethod(method: ProductMethod): method is CatalogMethod {
  return method in CATALOG_ROUTES
}

function catalogEntry(
  method: CatalogMethod,
  value: unknown,
  snapshot: ReadonlyMap<CatalogMethod, unknown>,
  desktopVersion: string,
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const id = optionalString(record.id)
  if (id === undefined) return record
  if (method === 'connectors.list') {
    return { ...record, availabilityStatus: record.authorizationStatus !== 'AUTHORIZED'
      ? 'AUTHORIZATION_REQUIRED' : record.ready === true ? 'AVAILABLE' : 'UNAVAILABLE' }
  }
  const minimumVersion = optionalString(record.minimumDesktopVersion)
  if (minimumVersion !== undefined && compareVersions(desktopVersion, minimumVersion) < 0) {
    return { ...record, availabilityStatus: 'INCOMPATIBLE' }
  }
  return { ...record, availabilityStatus: capabilityAvailability(method, record, snapshot) }
}

function capabilityAvailability(
  method: CatalogMethod,
  capability: Readonly<Record<string, unknown>>,
  snapshot: ReadonlyMap<CatalogMethod, unknown>,
): 'AVAILABLE' | 'AUTHORIZATION_REQUIRED' | 'UNAVAILABLE' {
  if (method !== 'expertKits.list' && method !== 'skills.list') return 'AVAILABLE'
  if (method === 'expertKits.list') {
    const skills = catalogIds(snapshot.get('skills.list'))
    const embeddedSkills = new Set(objectArray(capability.skillDetails)
      .flatMap(value => optionalString(value.id) ?? []))
    if (stringValues(capability.skillIds).some(id => !skills.has(id) && !embeddedSkills.has(id))) {
      return 'UNAVAILABLE'
    }
  }
  const connectors = catalogRecords(snapshot.get('connectors.list'))
  const selected = stringValues(capability.connectorRefs).map(id => connectors.find(connector => connector.id === id))
  if (selected.some(connector => connector === undefined)) return 'UNAVAILABLE'
  if (selected.some(connector => connector?.authorizationStatus !== undefined
    && connector.authorizationStatus !== 'AUTHORIZED')) return 'AUTHORIZATION_REQUIRED'
  if (selected.some(connector => connector?.ready !== true)) return 'UNAVAILABLE'
  // Required tools are composition-scoped and cannot be inferred from the
  // connector catalog. The Host validates them before preparation succeeds.
  const knowledge = catalogRecords(snapshot.get('knowledge.bases.list'))
  const visibleKnowledge = new Set(knowledge.flatMap(entry => [entry.id, entry.referenceKey, entry.reference]
    .flatMap(candidate => optionalString(candidate) ?? [])))
  if (stringValues(capability.knowledgeBaseRefs).some(reference => !visibleKnowledge.has(reference))) {
    return 'UNAVAILABLE'
  }
  return 'AVAILABLE'
}

function catalogRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry))
}

function catalogIds(value: unknown): Set<string> {
  return new Set(catalogRecords(value).flatMap(entry => optionalString(entry.id) ?? []))
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return catalogRecords(value)
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Compare semantic desktop versions, including prerelease ordering.
 * @param left - Installed desktop version.
 * @param right - Minimum required release.
 * @returns Negative, zero, or positive when installed versions are older, equal, or newer.
 */
export function compareVersions(left: string, right: string): number {
  if (valid(left) === null || valid(right) === null) throw new Error('Invalid desktop semantic version')
  return compare(left, right)
}
