/** Employee-scoped product catalogs, immutable preparation identities, and dependency checks. */

import type { DeepSeekHarnessApiClient } from './http-client.ts'
import type {
  ProductContentIdentity,
  ProductDependencyCheck,
  ProductEvent,
  ProductMethod,
  ProductPrepareResult,
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
type PreparationState = 'PREPARING' | 'AVAILABLE' | 'PREPARATION_FAILED'

export interface ProductCatalogManagerOptions {
  readonly api?: DeepSeekHarnessApiClient | undefined
  readonly desktopVersion: string
  readonly getSession: () => ProductSession
  readonly ensureFreshSession: () => Promise<void>
  readonly emit: (event: ProductEvent) => void
}

/** Owns one employee's complete catalog snapshot and local preparation state. */
export class ProductCatalogManager {
  private refreshOperation: Promise<void> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private signature: string | undefined
  private readonly snapshot = new Map<CatalogMethod, unknown>()
  private readonly preparation = new Map<string, PreparationState>()

  constructor(private readonly options: ProductCatalogManagerOptions) {}

  /** Refresh every catalog as one snapshot while retaining the last successful snapshot on failure. */
  async refresh(): Promise<void> {
    if (this.refreshOperation !== undefined) return this.refreshOperation
    const refresh = this.loadSnapshot().finally(() => {
      if (this.refreshOperation === refresh) this.refreshOperation = undefined
      this.schedule()
    })
    this.refreshOperation = refresh
    return refresh
  }

  /** Read one complete catalog with local availability state applied. */
  async read(method: ProductMethod): Promise<unknown> {
    if (!isCatalogMethod(method)) throw new Error(`deepseek-harness product: method ${method} is not available`)
    if (!this.snapshot.has(method)) await this.refresh()
    const value = this.snapshot.get(method) ?? []
    if (!Array.isArray(value)) return value
    return value.map(entry => catalogEntry(
      method, entry, this.snapshot, this.preparation, this.options.desktopVersion,
    ))
  }

  /** Validate and prepare one Expert Kit against the currently published snapshot. */
  async prepareExpertKit(
    id: string,
    operation: (content: ProductContentIdentity) => Promise<string>,
  ): Promise<ProductPrepareResult> {
    if (!this.snapshot.has('expertKits.list')) await this.refresh()
    const kit = catalogRecord(this.snapshot.get('expertKits.list'), id, 'Expert Kit')
    const checks = this.requireCapabilityDependencies(id, kit, true)
    return this.prepare('expertKits.list', kit, checks, operation)
  }

  /** Validate and prepare one standalone Skill against the currently published snapshot. */
  async prepareSkill(
    id: string,
    operation: (content: ProductContentIdentity) => Promise<string>,
  ): Promise<ProductPrepareResult> {
    if (!this.snapshot.has('skills.list')) await this.refresh()
    const skill = catalogRecord(this.snapshot.get('skills.list'), id, 'Skill')
    const checks = this.requireCapabilityDependencies(id, skill, false)
    return this.prepare('skills.list', skill, checks, operation)
  }

  /** Drop employee-scoped state when authentication identity changes. */
  reset(): void {
    this.epoch += 1
    this.snapshot.clear()
    this.signature = undefined
    this.preparation.clear()
  }

  /** Schedule the next refresh only while an employee is authenticated. */
  schedule(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    if (!this.options.getSession().authenticated || this.options.api === undefined) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refresh().catch(() => undefined)
    }, CATALOG_REFRESH_INTERVAL_MS)
    this.refreshTimer.unref()
  }

  /** Stop the manager's background timer. */
  dispose(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
  }

  private async prepare(
    method: CatalogMethod,
    record: Readonly<Record<string, unknown>>,
    checks: readonly ProductDependencyCheck[],
    operation: (content: ProductContentIdentity) => Promise<string>,
  ): Promise<ProductPrepareResult> {
    const contentVersion = contentIdentity(record)
    const key = preparationKey(method, contentVersion)
    this.preparation.set(key, 'PREPARING')
    this.emitChanged()
    try {
      const presetId = await operation(contentVersion)
      this.preparation.set(key, 'AVAILABLE')
      return { presetId, contentVersion, dependencyChecks: checks }
    } catch (error) {
      this.preparation.set(key, 'PREPARATION_FAILED')
      throw error
    } finally {
      this.emitChanged()
    }
  }

  private requireCapabilityDependencies(
    id: string,
    capability: Readonly<Record<string, unknown>>,
    expertKit: boolean,
  ): ProductDependencyCheck[] {
    const label = expertKit ? 'Expert Kit' : 'Skill'
    const checks: ProductDependencyCheck[] = []
    const minimumVersion = optionalString(capability.minimumDesktopVersion)
    if (minimumVersion !== undefined && compareVersions(this.options.desktopVersion, minimumVersion) < 0) {
      throw new Error(`deepseek-harness product: ${label} ${id} requires desktop ${minimumVersion}`)
    }
    if (minimumVersion !== undefined) {
      checks.push({ kind: 'DESKTOP_VERSION', reference: minimumVersion, status: 'READY' })
    }
    if (expertKit) this.requireSkills(id, capability, checks)
    this.requireDataDependencies(label, id, capability, checks)
    return checks
  }

  private requireSkills(
    id: string,
    kit: Readonly<Record<string, unknown>>,
    checks: ProductDependencyCheck[],
  ): void {
    const skills = catalogIds(this.snapshot.get('skills.list'))
    const embeddedSkills = new Set(objectArray(kit.skillDetails).flatMap(value => optionalString(value.id) ?? []))
    for (const skillId of stringValues(kit.skillIds)) {
      if (!skills.has(skillId) && !embeddedSkills.has(skillId)) {
        throw new Error(`deepseek-harness product: Expert Kit ${id} requires unavailable Skill ${skillId}`)
      }
      checks.push({ kind: 'SKILL', reference: skillId, status: 'READY' })
    }
  }

  private requireDataDependencies(
    label: 'Expert Kit' | 'Skill',
    id: string,
    capability: Readonly<Record<string, unknown>>,
    checks: ProductDependencyCheck[],
  ): void {
    const connectors = catalogRecords(this.snapshot.get('connectors.list'))
    const selectedConnectors = stringValues(capability.connectorRefs).map((connectorId) => {
      const connector = connectors.find(value => value.id === connectorId)
      if (connector === undefined || connector.ready !== true) {
        throw new Error(`deepseek-harness product: ${label} ${id} requires unavailable data connection ${connectorId}`)
      }
      checks.push({ kind: 'DATA_CONNECTION', reference: connectorId, status: 'READY' })
      return connector
    })
    const tools = new Set(selectedConnectors.flatMap(connector => objectArray(connector.tools)
      .flatMap(tool => optionalString(tool.name) ?? [])))
    for (const tool of stringValues(capability.requiredTools)) {
      if (!tools.has(tool)) throw new Error(`deepseek-harness product: ${label} ${id} requires unavailable tool ${tool}`)
      checks.push({ kind: 'TOOL', reference: tool, status: 'READY' })
    }
    const knowledge = catalogRecords(this.snapshot.get('knowledge.bases.list'))
    const visibleKnowledge = new Set(knowledge.flatMap(value => [value.id, value.referenceKey, value.reference]
      .flatMap(candidate => optionalString(candidate) ?? [])))
    for (const reference of stringValues(capability.knowledgeBaseRefs)) {
      if (!visibleKnowledge.has(reference)) {
        throw new Error(`deepseek-harness product: ${label} ${id} requires unavailable knowledge ${reference}`)
      }
      checks.push({ kind: 'KNOWLEDGE_BASE', reference, status: 'READY' })
    }
  }

  private async loadSnapshot(): Promise<void> {
    const api = this.options.api
    if (api === undefined) throw new Error('deepseek-harness product: server URL is not configured')
    await this.options.ensureFreshSession()
    const epoch = this.epoch
    const employeeId = this.options.getSession().employeeId
    const entries = await Promise.all((Object.entries(CATALOG_ROUTES) as [CatalogMethod, string][])
      .map(async ([method, route]) => [method, await api.listAll(route, 100)] as const))
    const current = this.options.getSession()
    if (epoch !== this.epoch || !current.authenticated || employeeId !== current.employeeId) return
    const nextSignature = JSON.stringify(entries)
    const changed = nextSignature !== this.signature
    this.snapshot.clear()
    for (const [method, value] of entries) this.snapshot.set(method, value)
    retainCurrentPreparation(this.preparation, this.snapshot)
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

function contentIdentity(record: Readonly<Record<string, unknown>>): ProductContentIdentity {
  const content = optionalContentIdentity(record)
  if (content === undefined) {
    throw new Error('deepseek-harness product: catalog entry has no immutable content version')
  }
  return content
}

function optionalContentIdentity(record: Readonly<Record<string, unknown>>): ProductContentIdentity | undefined {
  const id = optionalString(record.id)
  const version = optionalString(record.version)
  const sha256 = optionalString(record.sha256)
  if (id === undefined || version === undefined || sha256 === undefined || !/^[a-fA-F0-9]{64}$/u.test(sha256)) {
    return undefined
  }
  return { id, version, sha256: sha256.toLowerCase() }
}

function preparationKey(method: CatalogMethod, content: ProductContentIdentity): string {
  return `${method}:${content.id}:${content.version}:${content.sha256}`
}

function retainCurrentPreparation(
  preparation: Map<string, PreparationState>,
  snapshot: ReadonlyMap<CatalogMethod, unknown>,
): void {
  const current = new Set<string>()
  for (const method of ['expertKits.list', 'skills.list'] as const) {
    for (const record of catalogRecords(snapshot.get(method))) {
      const content = optionalContentIdentity(record)
      if (content !== undefined) current.add(preparationKey(method, content))
    }
  }
  for (const key of preparation.keys()) {
    if (!current.has(key)) preparation.delete(key)
  }
}

function catalogEntry(
  method: CatalogMethod,
  value: unknown,
  snapshot: ReadonlyMap<CatalogMethod, unknown>,
  preparation: ReadonlyMap<string, PreparationState>,
  desktopVersion: string,
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  const id = optionalString(record.id)
  if (id === undefined) return record
  const content = optionalContentIdentity(record)
  const local = content === undefined ? undefined : preparation.get(preparationKey(method, content))
  if (local !== undefined) return { ...record, availabilityStatus: local }
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
  const tools = new Set(selected.flatMap(connector => objectArray(connector?.tools)
    .flatMap(tool => optionalString(tool.name) ?? [])))
  if (stringValues(capability.requiredTools).some(tool => !tools.has(tool))) return 'UNAVAILABLE'
  const knowledge = catalogRecords(snapshot.get('knowledge.bases.list'))
  const visibleKnowledge = new Set(knowledge.flatMap(entry => [entry.id, entry.referenceKey, entry.reference]
    .flatMap(candidate => optionalString(candidate) ?? [])))
  if (stringValues(capability.knowledgeBaseRefs).some(reference => !visibleKnowledge.has(reference))) {
    return 'UNAVAILABLE'
  }
  return 'AVAILABLE'
}

function catalogRecord(value: unknown, id: string, label: string): Record<string, unknown> {
  const result = catalogRecords(value).find(entry => entry.id === id)
  if (result === undefined) throw new Error(`deepseek-harness product: ${label} ${id} is unavailable`)
  return result
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

function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] => value.replace(/^v/u, '').split(/[.-]/u)
    .slice(0, 3).map(part => /^\d+$/u.test(part) ? Number(part) : 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
