/** Team snapshots owned by one plugin instance, with committed-write ordering. */
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { TeamSnapshot } from '../team-contract.ts'
import type { AgencyTeamsRemote } from './remote.ts'
import { SnapshotLifecycle } from './snapshot-lifecycle.ts'

function sameSnapshot(current: TeamSnapshot, next: TeamSnapshot): boolean {
  return current.revision === next.revision
    && deepEqualJson(current.teams, next.teams)
    && deepEqualJson(current.enabledTeams, next.enabledTeams)
    && deepEqualJson(current.enabledExperts, next.enabledExperts)
    && deepEqualJson(current.engine ?? null, next.engine ?? null)
    && deepEqualJson(current.nativeMembers ?? null, next.nativeMembers ?? null)
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

  /** Accept a complete snapshot and fence earlier reads; lower revisions are ignored.
   * @param value Full directory data from a query or direct commit.
   * @returns Latest accepted team snapshot.
   */
  accept(value: TeamSnapshot): TeamSnapshot {
    const current = this.getSnapshot()
    if (this.lifecycle.signal.aborted) throw new DOMException('Expert teams disposed', 'AbortError')
    if (current !== null && value.revision < current.revision) return current
    this.pending = undefined
    return this.publish(value)
  }

  /** Consume a committed receipt without replacing concurrent directory updates.
   * A changed directory at a lower settings revision requires a fresh complete read.
   * Read failure leaves the write committed; consumers report a directory error.
   * @param value Full snapshot returned by the committed mutation.
   * @param started Directory captured immediately before dispatching the mutation.
   * @returns Current complete directory, preserving newer accepted content.
   */
  async acceptMutation(value: TeamSnapshot, started: TeamSnapshot | null): Promise<TeamSnapshot> {
    this.lifecycle.signal.throwIfAborted()
    const current = this.getSnapshot()
    if (current === started) return this.accept(value)
    if (current !== null && current.revision >= value.revision) return this.accept(current)
    this.lifecycle.advance()
    this.pending = undefined
    return this.refresh()
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
