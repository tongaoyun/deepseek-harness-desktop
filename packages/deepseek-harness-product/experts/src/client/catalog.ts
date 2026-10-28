/** One plugin instance's expert catalog, ordered against committed writes and connection resets. */
import { EN_DIVISION } from '../names.ts'
import type { CatalogSnapshot, ExpertSummary } from '../expert-contract.ts'
import type { AgencyCatalogRemote } from './remote.ts'
import { SnapshotLifecycle } from './snapshot-lifecycle.ts'

/** Expert summary with its English division label. */
export interface ExpertView extends ExpertSummary { readonly divisionEn: string }
/** Shared catalog data and the Host settings revision. */
export interface CatalogState {
  readonly experts: readonly ExpertView[]
  readonly enabled: ReadonlySet<string>
  readonly revision: number
}
const empty = (): CatalogState => ({ experts: [], enabled: new Set(), revision: -1 })

/** Own a catalog for one mounted plugin; subscribers use the native snapshot engine. */
export class ExpertCatalog {
  private readonly lifecycle = new SnapshotLifecycle(empty())
  private pending?: Promise<CatalogState>
  private companyPending?: Promise<CatalogState>

  constructor(private readonly remote: AgencyCatalogRemote) {}

  /** Read the current immutable snapshot.
   * @returns Latest accepted data, or the initial empty state after reset.
   */
  getSnapshot = (): CatalogState => this.lifecycle.store.getSnapshot()
  /** Subscribe until the returned disposer or plugin teardown runs.
   * @param listener Snapshot observer; failures are contained by the native store.
   * @returns Subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => {
    return this.lifecycle.subscribe(listener)
  }

  /** Discard the previous Host's revision and fence its outstanding replies. */
  reset(): void {
    this.lifecycle.reset(empty())
    this.pending = undefined
    this.companyPending = undefined
  }

  /** Release subscribers and prevent further work from this unmounted plugin. */
  dispose(): void { this.pending = undefined; this.companyPending = undefined; this.lifecycle.dispose(empty()) }

  /** Publish a committed write without allowing an older receipt to roll it back.
   * @param value Committed catalog.
   * @returns Latest accepted catalog.
   */
  accept(value: CatalogSnapshot): CatalogState {
    if (this.lifecycle.signal.aborted || value.revision < this.getSnapshot().revision) return this.getSnapshot()
    this.pending = undefined
    return this.publish(value)
  }

  /** Adopt the revision shared with expert-team settings after a team mutation.
   * @param revision Committed shared settings revision.
   * @param enabled Enabled expert identifiers.
   * @returns Latest catalog with the committed selection.
   */
  adoptRevision(revision: number, enabled: readonly string[]): CatalogState {
    const current = this.getSnapshot()
    if (current.revision < 0 || revision < current.revision) return current
    return this.accept({ experts: [...current.experts], enabled: [...enabled], revision })
  }

  /** Apply a saved selection while preserving the current expert directory.
   * @param value Committed enabled selection and settings revision.
   * @returns Latest accepted catalog.
   */
  acceptEnabled(value: { enabled: string[]; revision: number }): CatalogState {
    return this.accept({ experts: [...this.getSnapshot().experts], ...value })
  }

  /** Share reads and queue at most one explicit company refresh behind a local read.
   * @param refreshCompany Refresh the company source after any active local read.
   * @returns Current catalog; reset and teardown reject outstanding reads with AbortError.
   */
  refresh(refreshCompany = false): Promise<CatalogState> {
    this.lifecycle.signal.throwIfAborted()
    if (this.companyPending) return this.companyPending
    if (!refreshCompany) return this.pending ?? this.read(false, this.lifecycle.signal)
    const signal = this.lifecycle.signal
    const start = () => { signal.throwIfAborted(); return this.read(true, signal) }
    const request = this.pending ? this.pending.then(start, start) : start()
    const pending = request.finally(() => { if (this.companyPending === pending) this.companyPending = undefined })
    this.companyPending = pending
    return pending
  }

  private read(company: boolean, signal: AbortSignal): Promise<CatalogState> {
    const generation = this.lifecycle.generation
    const stale = () => { signal.throwIfAborted(); return generation !== this.lifecycle.generation }
    const pending = this.remote.getCatalog(company, signal).then((result) => {
      if (stale()) return this.getSnapshot()
      if (!result.ok) throw result.error
      return this.publish(result.value)
    }, (error: unknown) => {
      if (stale()) return this.getSnapshot()
      throw error
    }).finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }

  private publish(value: CatalogSnapshot): CatalogState {
    const current = this.getSnapshot()
    this.lifecycle.advance()
    const experts = value.experts.map(expert => ({ ...expert, divisionEn: EN_DIVISION[expert.division] ?? expert.division }))
    if (value.revision === current.revision && JSON.stringify(experts) === JSON.stringify(current.experts)
      && value.enabled.length === current.enabled.size && value.enabled.every(slug => current.enabled.has(slug))) return current
    this.lifecycle.store.set({ experts, enabled: new Set(value.enabled), revision: value.revision })
    return this.getSnapshot()
  }
}
