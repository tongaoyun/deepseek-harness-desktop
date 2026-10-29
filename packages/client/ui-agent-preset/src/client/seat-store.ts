/**
 * Hero-chip controller: which preset the NEXT session gets.
 *
 * The new-session screen has no session, so a pick is staged rather than
 * applied. It reaches a session when one becomes current and is still blank —
 * whether the workspace connect created it or reused an existing blank one. A
 * flow that knows its preset before it starts (the settings section's creator
 * entry) passes it to session creation instead, and its stage only drives the
 * chip's display.
 *
 * The stage is forgotten once applied. The next new session starts from the
 * Host-effective default again.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { isUnavailablePreset, presetOptions, readRoster, selectionPresetId } from './settings-store.ts'
import type { AgentPresetOption, RosterPreset } from './settings-store.ts'

/** Hero-chip snapshot. */
export interface AgentPresetSeatState {
  /** Presets the deployment supplies; empty means the chip renders nothing. */
  options: readonly AgentPresetOption[]
  /** The staged choice, empty until the roster loads. */
  current: string
  /** An unnamed hidden composition has no recoverable selectable base. */
  currentUnavailable: boolean
  /** An error message; explicit selection failures also carry the preset for a Toast. */
  error: string | { readonly preset: AgentPresetOption; readonly reason: string } | null
  busy: boolean
  /**
   * One-shot cue that the chip should introduce itself (the creator-draft
   * entry staged the pick from another screen, so the user never touched the
   * chip); the renderer clears it via `introduced()` once played.
   */
  introduce: boolean
}

const INITIAL: AgentPresetSeatState = {
  options: [], current: '', currentUnavailable: false, error: null, busy: false, introduce: false,
}

/** Mutable one-shot preset choice shared across Provider-bound seat controllers. */
export interface AgentPresetStage {
  /** Distinguishes newer choices, including repeated picks of the same preset. */
  revision: number
  /** Preset awaiting application; absence means no staged choice. */
  id: string | undefined
  /** Whether the receiving chip should announce the applied choice once. */
  introduce: boolean
}

/**
 * Result of one attempt to hand a staged preset to the current Session: the Host applied it,
 * it waits for a Session to appear, nothing changed (busy, already composed, started, or no
 * stage), or the Host refused it.
 */
export type AgentPresetApplyOutcome =
  | { readonly kind: 'applied' | 'staged' | 'unchanged' }
  | { readonly kind: 'refused'; readonly reason: string }

const UNCHANGED: AgentPresetApplyOutcome = { kind: 'unchanged' }

/** Stages the next session's preset and applies it when one appears. */
export class AgentPresetSeatController {
  /** Chip snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore(INITIAL)

  /**
   * The Host-effective default, so a consumed stage can fall back to it without
   * re-reading the roster.
   */
  private fallback = ''

  /** Only the newest roster read may publish after overlapping refreshes. */
  private loadGeneration = 0
  private presets: readonly RosterPreset[] = []
  private rosterLoaded = false
  /** One refresh per unknown identity until an explicit roster reload. */
  private readonly missingPresetReads = new Map<string, Promise<void> | null>()
  /** Selection responses may arrive before the matching Session projection. */
  private committedSelection: { sessionId: SessionSummary['id']; before: string | undefined; id: string } | undefined
  /** Completion of the active Host selection; Settings choices wait before staging. */
  private pendingSelection: Promise<undefined> | undefined

  constructor(
    private readonly ctx: ClientContext,
    /** The session the hero is about to hand over to, when there is one. */
    private readonly currentSession: () => Pick<
      SessionSummary,
      'id' | 'blank' | 'projectionValues'
    > | undefined,
    private readonly staged: AgentPresetStage = { revision: 0, id: undefined, introduce: false },
  ) {}

  private set(patch: Partial<AgentPresetSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private clearStage(): void {
    this.staged.revision += 1
    this.staged.id = undefined
    this.staged.introduce = false
  }

  private currentPreset(session: ReturnType<AgentPresetSeatController['currentSession']>): string | undefined {
    const actual = presetOf(session)
    const committed = this.committedSelection
    if (committed === undefined) return actual
    if (session?.id !== committed.sessionId || actual === committed.id || actual !== committed.before) {
      this.committedSelection = undefined
      return actual
    }
    return committed.id
  }

  private shownPreset(id: string | undefined): string {
    return id === undefined ? '' : selectionPresetId(id, this.presets)
  }

  private unavailablePreset(id: string | undefined): boolean {
    return id !== undefined && isUnavailablePreset(id, this.presets)
  }

  private reconcileCurrent(): void {
    const session = this.currentSession()
    const actual = this.currentPreset(session)
    this.set({
      current: this.staged.id ?? (session === undefined ? this.fallback : this.shownPreset(actual)),
      currentUnavailable: this.staged.id === undefined && this.unavailablePreset(actual),
    })
  }

  private refreshMissingPreset(id: string | undefined, force = false): Promise<void> | undefined {
    if ((!this.rosterLoaded && !force) || id === undefined || this.presets.some(preset => preset.id === id)) return
    const existing = this.missingPresetReads.get(id)
    if (existing !== undefined) return existing ?? undefined
    const generation = ++this.loadGeneration
    const sessionId = this.currentSession()?.id
    const refresh = readRoster(this.ctx).then((roster) => {
      if (generation !== this.loadGeneration) return
      if (!roster.ok) {
        const error = this.store.getSnapshot().error
        if (this.currentSession()?.id === sessionId && (error === null || typeof error !== 'object')) {
          this.set({ error: roster.error })
        }
        return
      }
      this.presets = roster.value.presets
      this.rosterLoaded = true
      this.fallback = this.presets.find(preset => preset.isDefault)?.id ?? this.presets[0]?.id ?? ''
      this.set({ options: presetOptions(this.presets, true) })
    }).finally(() => {
      if (this.missingPresetReads.get(id) === refresh) this.missingPresetReads.set(id, null)
    })
    this.missingPresetReads.set(id, refresh)
    return refresh
  }

  /**
   * Read the roster and open the chip on the Host-effective default.
  * @returns once the snapshot reflects the host.
  */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    const roster = await readRoster(this.ctx)
    if (generation !== this.loadGeneration) return
    // A roster refresh can finish after a selection; leave its announcement for the chip.
    const error = this.store.getSnapshot().error
    if (!roster.ok) {
      if (typeof error !== 'object' || error === null) this.set({ error: roster.error })
      return
    }
    const { presets } = roster.value
    this.presets = presets
    this.rosterLoaded = true
    this.missingPresetReads.clear()
    this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? ''
    const session = this.currentSession()
    const actual = this.currentPreset(session)
    const before = this.store.getSnapshot()
    this.set({
      options: presetOptions(presets, true),
      // Staged pick first, then the composition the current session
      // already carries, then the Host-effective default. The middle term is
      // what keeps a late-landing load from regressing the display after
      // an applied stage was consumed — the chip mounts (and loads) only
      // once the flow's session is current, so the reply can arrive after
      // apply() already composed it.
      current: this.staged.id ?? (before.busy ? before.current : session === undefined ? this.fallback : this.shownPreset(actual)),
      currentUnavailable: before.busy ? before.currentUnavailable
        : this.staged.id === undefined && this.unavailablePreset(actual),
      error: typeof error === 'object' ? error : null,
      introduce: this.staged.introduce,
    })
    await this.apply()
  }

  /**
   * Stage one preset for the next session, applying it immediately when a
   * blank session is already current.
   *
   * The refusal is stored for the chip's announcement and returned to callers
   * such as Settings that also report the result of their own write.
   * @param id - the preset to stage.
   * @returns how the pick settled; a refusal carries its text.
   */
  async select(id: string): Promise<AgentPresetApplyOutcome> {
    if (this.store.getSnapshot().busy) return UNCHANGED
    this.stage(id)
    return await this.apply()
  }

  /**
   * Stage a pick WITHOUT the immediate apply, for a flow that starts the
   * receiving session after the pick (the settings section's creator entry).
   * `select()`'s immediate apply would meet the still-current running session
   * and drop the stage as unservable; staging alone leaves it for the
   * list-change applier, which fires when the started session becomes
   * current.
   * @param id - the preset to stage.
   * @param introduce - true when the stage came from another screen and the
   * chip should announce itself on the session it lands on.
   */
  stage(id: string, introduce = false): void {
    this.staged.revision += 1
    this.staged.id = id
    this.staged.introduce = introduce
    this.set({ current: id, currentUnavailable: false, error: null, introduce })
  }

  /** Acknowledge a displayed refusal without dismissing a newer attempt.
   * @param refusal - the selection error whose Toast finished.
   */
  dismissRefusal(refusal: AgentPresetSeatState['error']): void {
    if (refusal !== null && typeof refusal === 'object' && this.store.getSnapshot().error === refusal) {
      this.set({ error: refusal.reason })
    }
  }

  /**
   * Capture the exact blank Session a Settings action may bring along.
   * @returns its id, or undefined outside a blank Session.
   */
  blankSessionId(): SessionSummary['id'] | undefined {
    const session = this.currentSession()
    return session?.blank === true ? session.id : undefined
  }

  /**
   * Apply a Settings choice only if its captured Session is still current and
   * blank after any pending selection settles. The selection uses the existing stage/apply path.
   * @param expectedSessionId - blank Session captured before the Settings write.
   * @param id - the effective default that the write persisted.
   * @returns the Host refusal text, or undefined when applied or no longer relevant.
   */
  async syncBlankSession(
    expectedSessionId: SessionSummary['id'],
    id: string,
  ): Promise<string | undefined> {
    while (this.pendingSelection !== undefined) await this.pendingSelection
    const session = this.currentSession()
    if (session === undefined || !session.blank || session.id !== expectedSessionId) return undefined
    this.stage(id)
    const outcome = await this.apply()
    return outcome.kind === 'refused' ? outcome.reason : undefined
  }

  /** Acknowledge the introduction cue once the chip has played it. */
  introduced(): void {
    if (!this.store.getSnapshot().introduce) return
    this.staged.introduce = false
    this.set({ introduce: false })
  }

  /**
   * Hand the staged choice to the current session, if there is one to take it.
   *
   * Called both by `select()` and by whoever observes the current session
   * changing, because the session may appear either before or after the pick.
   * List updates do not repeat a selection while its response is pending.
   * @returns how this attempt settled; only a Host commit of the staged preset is applied.
   */
  async apply(): Promise<AgentPresetApplyOutcome> {
    if (this.store.getSnapshot().busy) return UNCHANGED
    const staged = this.staged.id
    const stageRevision = this.staged.revision
    let session = this.currentSession()
    const sessionId = session?.id
    const current = this.currentPreset(session)
    const refresh = this.refreshMissingPreset(current)
    if (refresh !== undefined) await refresh
    if (this.store.getSnapshot().busy) return UNCHANGED
    session = this.currentSession()
    if (session?.id !== sessionId) {
      if (this.staged.revision === stageRevision) this.clearStage()
      this.reconcileCurrent()
      return UNCHANGED
    }
    // Another picker may have staged a newer choice during the roster read.
    if (this.staged.revision !== stageRevision) return UNCHANGED
    if (staged === undefined) {
      const actual = this.currentPreset(session)
      const current = session === undefined ? this.fallback : this.shownPreset(actual)
      const currentUnavailable = this.unavailablePreset(actual)
      const shown = this.store.getSnapshot()
      if (current !== shown.current || currentUnavailable !== shown.currentUnavailable) this.set({ current, currentUnavailable })
      return UNCHANGED
    }
    if (session === undefined) return { kind: 'staged' }
    // A started session's history was produced under its own composition; the
    // host refuses the swap, so the stage is no longer meaningful.
    if (!session.blank || this.shownPreset(this.currentPreset(session)) === staged) {
      this.clearStage()
      this.reconcileCurrent()
      return UNCHANGED
    }
    const completion = Promise.withResolvers<undefined>()
    this.pendingSelection = completion.promise
    this.clearStage()
    const refuse = (reason: string): AgentPresetApplyOutcome => {
      this.set({
        error: { reason, preset: this.store.getSnapshot().options.find(option => option.id === staged) ?? { id: staged } },
      })
      this.reconcileCurrent()
      return { kind: 'refused', reason }
    }
    try {
      this.set({ busy: true, error: null })
      const before = presetOf(session)
      const result = await this.ctx.remote.agentPresets.select(session.id, staged)
      const latest = this.currentSession()
      if (latest?.id !== session.id) {
        this.reconcileCurrent()
        return UNCHANGED
      }
      if (!result.ok) {
        const { error } = result
        // Prefer the bare cause; the Toast already names the rejected preset.
        const refusal = 'reason' in error.details && typeof error.details.reason === 'string'
          ? error.details.reason
          : error.message
        return refuse(refusal)
      }
      this.committedSelection = { sessionId: session.id, before, id: result.value }
      const refresh = this.refreshMissingPreset(result.value, result.value !== staged)
      if (refresh !== undefined) await refresh
      this.reconcileCurrent()
      return result.value === staged ? { kind: 'applied' } : UNCHANGED
    } catch (error) {
      if (this.currentSession()?.id !== session.id) {
        this.reconcileCurrent()
        return UNCHANGED
      }
      return refuse(error instanceof Error ? error.message : String(error))
    } finally {
      this.pendingSelection = undefined
      this.set({ busy: false })
      completion.resolve(undefined)
    }
  }
}

function presetOf(
  session: Pick<SessionSummary, 'projectionValues'> | undefined,
): string | undefined {
  const value = session?.projectionValues?.agentPreset
  return typeof value === 'string' ? value : undefined
}
