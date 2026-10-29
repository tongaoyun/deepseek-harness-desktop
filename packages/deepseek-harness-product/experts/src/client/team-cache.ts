/** Team snapshots owned by one plugin instance, with committed-write ordering. */
import type { TeamSnapshot } from '../team-contract.ts'
import type { AgencyTeamsRemote } from './remote.ts'
import { SnapshotLifecycle } from './snapshot-lifecycle.ts'

function sameSnapshot(current: TeamSnapshot, next: TeamSnapshot): boolean {
  return current.revision === next.revision
    && JSON.stringify(current.teams) === JSON.stringify(next.teams)
    && JSON.stringify(current.enabledTeams) === JSON.stringify(next.enabledTeams)
    && JSON.stringify(current.enabledExperts) === JSON.stringify(next.enabledExperts)
    && JSON.stringify(current.engine ?? null) === JSON.stringify(next.engine ?? null)
    && JSON.stringify(current.nativeMembers ?? null) === JSON.stringify(next.nativeMembers ?? null)
}

/** Share team queries and notifications without retaining state across plugin instances. */
export class ExpertTeams {
  private readonly lifecycle = new SnapshotLifecycle<TeamSnapshot | null>(null)
  private pending?: Promise<TeamSnapshot>
  constructor(private readonly remote: Pick<AgencyTeamsRemote, 'getTeams'>) {}
  /** Read the current immutable snapshot.
   * @returns Latest accepted data, or the initial empty state after reset.
   */
  getSnapshot = (): TeamSnapshot | null => this.lifecycle.store.getSnapshot()
  /** Subscribe until the returned disposer or plugin teardown runs.
   * @param listener Snapshot observer; failures are contained by the native store.
   * @returns Subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => {
    return this.lifecycle.subscribe(listener)
  }

  /** Clear a disconnected Host's snapshot and fence late responses. */
  reset(): void {
    this.lifecycle.reset(null)
    this.pending = undefined
  }
  /** Release subscribers and prevent new queries after plugin teardown. */
  dispose(): void { this.pending = undefined; this.lifecycle.dispose(null) }

  /** Accept a committed mutation; older receipts cannot replace it.
   * @param value Committed team settings.
   * @returns Latest accepted team snapshot.
   */
  accept(value: TeamSnapshot): TeamSnapshot {
    const current = this.getSnapshot()
    if (this.lifecycle.signal.aborted) throw new DOMException('Expert teams disposed', 'AbortError')
    if (current !== null && value.revision < current.revision) return current
    this.pending = undefined
    return this.publish(value)
  }

  /** Share one current query; a superseded failure cannot hide a successful mutation.
   * @returns Current teams; reset and teardown reject outstanding reads with AbortError.
   */
  refresh(): Promise<TeamSnapshot> {
    this.lifecycle.signal.throwIfAborted()
    if (this.pending !== undefined) return this.pending
    const signal = this.lifecycle.signal
    const generation = this.lifecycle.generation
    const superseding = () => {
      signal.throwIfAborted()
      return generation !== this.lifecycle.generation ? this.getSnapshot() : null
    }
    const pending = this.remote.getTeams(signal).then((result) => {
      const current = superseding()
      if (current) return current
      if (!result.ok) throw result.error
      return this.publish(result.value)
    }, (error: unknown) => {
      const current = superseding()
      if (current) return current
      throw error
    }).finally(() => { if (this.pending === pending) this.pending = undefined })
    this.pending = pending
    return pending
  }

  private publish(value: TeamSnapshot): TeamSnapshot {
    const current = this.getSnapshot()
    this.lifecycle.advance()
    if (current !== null && sameSnapshot(current, value)) return current
    this.lifecycle.store.set(value)
    return value
  }
}
