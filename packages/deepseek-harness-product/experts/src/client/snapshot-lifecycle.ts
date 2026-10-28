import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Shared lifecycle and subscription ownership for client-side Remote snapshots. */
export class SnapshotLifecycle<T> {
  readonly store: SnapshotStore<T>
  private readonly subscriptions = new AbortController()
  private controller = new AbortController()
  private revision = 0

  constructor(initial: T) { this.store = createSnapshotStore(initial) }

  get signal(): AbortSignal { return this.controller.signal }
  get generation(): number { return this.revision }

  subscribe(listener: () => void): () => void {
    if (this.subscriptions.signal.aborted) return () => {}
    const unsubscribe = this.store.subscribe(listener)
    const stop = () => { unsubscribe(); this.subscriptions.signal.removeEventListener('abort', stop) }
    this.subscriptions.signal.addEventListener('abort', stop, { once: true })
    return stop
  }

  advance(): number { return ++this.revision }

  reset(value: T): void {
    this.controller.abort()
    this.controller = new AbortController()
    if (this.subscriptions.signal.aborted) this.controller.abort()
    this.advance()
    this.store.set(value)
  }

  dispose(value: T): void {
    this.subscriptions.abort()
    this.reset(value)
    this.controller.abort()
  }
}
