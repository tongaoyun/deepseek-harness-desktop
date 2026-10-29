import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { AgentPresetSeatController, type AgentPresetStage } from '../src/client/seat-store.ts'
import { isUnavailablePreset, selectionPresetId } from '../src/client/settings-store.ts'

type SeatSession = Pick<SessionSummary, 'id' | 'blank' | 'projectionValues'>
type Row = AgentPresetRoster['presets'][number]
type Outcome = { ok: true; value: string } | { ok: false; error: RemoteError }

const BASES: readonly Row[] = [
  { id: 'standard', isDefault: true, selectable: true, defaultable: true },
  { id: 'minimal', isDefault: false, selectable: true, defaultable: true },
]

function derived(id: string, selectionBase = 'minimal'): Row {
  return { id, selectionBase, isDefault: false, selectable: false, defaultable: false }
}

function fixture(initial: readonly Row[] = BASES) {
  let presets = initial
  let current: SeatSession | undefined = {
    id: SessionId('first'), blank: true, projectionValues: { agentPreset: 'standard' },
  }
  const list = vi.fn(() => Promise.resolve({ ok: true as const, value: { presets } }))
  const select = vi.fn((_session: SessionId, preset: string): Promise<Outcome> => Promise.resolve({ ok: true, value: preset }))
  const controller = new AgentPresetSeatController({
    configForms: { developerTools: { enabled: createSnapshotStore(true) } },
    remote: { agentPresets: { list, select } },
  } as never, () => current)
  return {
    controller, list, select,
    roster: (rows: readonly Row[]) => { presets = rows },
    session: (value: SeatSession | undefined) => { current = value },
    actual: (id: string) => {
      if (current === undefined) throw new Error('expected a Session')
      current = { ...current, projectionValues: { agentPreset: id } }
    },
  }
}

describe('native selection of derived compositions', () => {
  it('maps hidden compositions while preserving unrelated identities', () => {
    expect(selectionPresetId('snapshot', [...BASES, derived('snapshot')])).toBe('minimal')
    expect(selectionPresetId('standard', [derived('snapshot')])).toBe('standard')
  })

  it.each([
    [] as readonly Row[],
    [{ ...BASES[0]!, broken: 'Failed base' }, derived('snapshot', 'standard')],
    [{ ...derived('snapshot'), broken: 'Missing selection base' }],
    [derived('minimal', 'standard'), derived('snapshot')],
    [{ ...BASES[1]!, selectable: false }, derived('snapshot')],
  ].map(presets => ({ presets })))('keeps an unavailable identity when its current declaration or selectable base is unusable', ({ presets }) => {
    expect(isUnavailablePreset('snapshot', presets)).toBe(true)
    expect(selectionPresetId('snapshot', presets)).toBe('snapshot')
  })

  it('offers a healthy selectable mode normally', () => {
    expect(isUnavailablePreset('standard', BASES)).toBe(false)
    expect(selectionPresetId('standard', BASES)).toBe('standard')
  })

  it('keeps a broken selectable mode unavailable even when its identity is known', () => {
    const presets = [{ ...BASES[0]!, broken: 'Failed plugin' }]
    expect(isUnavailablePreset('standard', presets)).toBe(true)
    expect(selectionPresetId('standard', presets)).toBe('standard')
  })

  it('retains a broken snapshot identity without selecting its missing base', async () => {
    const state = fixture([...BASES, {
      ...derived('broken-snapshot', 'removed-mode'), broken: 'Selection base is missing',
    }])
    state.actual('broken-snapshot')
    await state.controller.load()

    expect(state.controller.store.getSnapshot()).toMatchObject({
      current: 'broken-snapshot', currentUnavailable: true,
      options: [{ id: 'standard' }, { id: 'minimal' }],
    })
    expect(state.select).not.toHaveBeenCalled()
  })

  it('checks the selectable base and treats reselecting it as a no-op', async () => {
    const state = fixture([...BASES, derived('snapshot')])
    state.actual('snapshot')
    await state.controller.load()

    expect(state.controller.store.getSnapshot()).toMatchObject({
      current: 'minimal', options: [{ id: 'standard' }, { id: 'minimal' }],
    })
    await state.controller.select('minimal')
    expect(state.select).not.toHaveBeenCalled()
  })

  it('refreshes a newly registered selection without repeating it or losing the committed mode', async () => {
    const state = fixture()
    await state.controller.load()
    state.select.mockImplementation(async () => {
      state.roster([...BASES, derived('new-snapshot')])
      return { ok: true, value: 'new-snapshot' }
    })

    await state.controller.select('minimal')
    expect(state.select).toHaveBeenCalledExactlyOnceWith(SessionId('first'), 'minimal')
    expect(state.list).toHaveBeenCalledTimes(2)
    expect(state.controller.store.getSnapshot().current).toBe('minimal')

    await state.controller.load()
    await state.controller.apply()
    expect(state.controller.store.getSnapshot().current).toBe('minimal')
    state.actual('new-snapshot')
    await state.controller.apply()
    expect(state.controller.store.getSnapshot().current).toBe('minimal')
    expect(state.select).toHaveBeenCalledTimes(1)
  })

  it('resolves a derived selection made before the hero chip first loads', async () => {
    const state = fixture([...BASES, derived('new-snapshot')])
    state.select.mockResolvedValueOnce({ ok: true, value: 'new-snapshot' })

    await state.controller.select('minimal')

    expect(state.controller.store.getSnapshot().current).toBe('minimal')
    expect(state.list).toHaveBeenCalledTimes(1)
    expect(state.select).toHaveBeenCalledExactlyOnceWith(SessionId('first'), 'minimal')
  })

  it('marks an unresolved resolver result unavailable after its roster refresh fails', async () => {
    const refusal = new RemoteError('gateway/internal', 'roster unavailable', {})
    let actual = 'standard'
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { presets: BASES } })
      .mockResolvedValue({ ok: false, error: refusal })
    const select = vi.fn(() => Promise.resolve({ ok: true as const, value: 'new-snapshot' }))
    const controller = new AgentPresetSeatController({
      configForms: { developerTools: { enabled: createSnapshotStore(true) } },
      remote: { agentPresets: { list, select } },
    } as never, () => ({ id: SessionId('first'), blank: true, projectionValues: { agentPreset: actual } }))
    await controller.load()

    await controller.select('minimal')
    expect(controller.store.getSnapshot()).toMatchObject({
      current: 'new-snapshot', currentUnavailable: true, error: 'roster unavailable',
    })
    actual = 'new-snapshot'
    await controller.apply()
    expect(controller.store.getSnapshot().currentUnavailable).toBe(true)
    expect(list).toHaveBeenCalledTimes(2)
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('refreshes a composition selected by another surface from the Session projection', async () => {
    const state = fixture()
    await state.controller.load()
    state.roster([...BASES, derived('external')])
    state.actual('external')

    await Promise.all([state.controller.apply(), state.controller.apply()])
    expect(state.controller.store.getSnapshot().current).toBe('minimal')
    expect(state.list).toHaveBeenCalledTimes(2)
    expect(state.select).not.toHaveBeenCalled()
  })

  it('limits unknown and refused refreshes to one read until an explicit reload', async () => {
    const state = fixture()
    const list = vi.fn(() => Promise.resolve({
      ok: false as const, error: new RemoteError('gateway/internal', 'disconnected', {}),
    }))
    const current = { id: SessionId('first'), blank: true, projectionValues: { agentPreset: 'standard' } }
    let actual = 'standard'
    const controller = new AgentPresetSeatController({
      configForms: { developerTools: { enabled: createSnapshotStore(true) } },
      remote: { agentPresets: { list: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { presets: BASES } })
        .mockImplementation(list), select: state.select } },
    } as never, () => ({ ...current, projectionValues: { agentPreset: actual } }))
    await controller.load()
    actual = 'unknown'
    await controller.apply()
    await controller.apply()
    await controller.apply()

    expect(list).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot()).toMatchObject({ current: 'unknown', error: 'disconnected' })
  })

  it('keeps a blocked composition identity and marks its display as unavailable', async () => {
    const state = fixture([...BASES, {
      id: 'damaged', isDefault: false, selectable: false, defaultable: false,
    }])
    state.actual('damaged')
    await state.controller.load()

    expect(state.controller.store.getSnapshot()).toMatchObject({
      current: 'damaged', currentUnavailable: true,
      options: [{ id: 'standard' }, { id: 'minimal' }],
    })
    state.actual('standard')
    await state.controller.apply()
    expect(state.controller.store.getSnapshot()).toMatchObject({ current: 'standard', currentUnavailable: false })
  })

  it('keeps the pending selection display across an overlapping roster reload', async () => {
    const state = fixture()
    await state.controller.load()
    const reply = Promise.withResolvers<Outcome>()
    state.select.mockImplementationOnce(() => reply.promise)
    const selection = state.controller.select('minimal')
    await state.controller.load()

    expect(state.controller.store.getSnapshot()).toMatchObject({ current: 'minimal', busy: true })
    reply.resolve({ ok: true, value: 'minimal' })
    await selection
    expect(state.controller.store.getSnapshot()).toMatchObject({ current: 'minimal', busy: false })
  })

  it('refreshes an unknown identity only once even when it remains absent', async () => {
    const state = fixture()
    await state.controller.load()
    state.actual('unknown')
    await state.controller.apply()
    await state.controller.apply()
    await state.controller.apply()

    expect(state.list).toHaveBeenCalledTimes(2)
    expect(state.controller.store.getSnapshot().current).toBe('unknown')
  })

  it('does not replace a newer roster with an overlapping older refresh', async () => {
    const state = fixture()
    await state.controller.load()
    const old = Promise.withResolvers<{ ok: true; value: AgentPresetRoster }>()
    state.list.mockImplementationOnce(() => old.promise)
    state.actual('external')
    const refreshing = state.controller.apply()
    state.roster([...BASES, derived('external')])
    await state.controller.load()
    old.resolve({ ok: true, value: { presets: BASES } })
    await refreshing

    expect(state.controller.store.getSnapshot().current).toBe('minimal')
  })

  it.each([false, true])('keeps a newer stage while a derived selection settles (refused: %s)', async (refused) => {
    const state = fixture()
    await state.controller.load()
    const reply = Promise.withResolvers<Outcome>()
    state.select.mockImplementationOnce(() => reply.promise)
    const selection = state.controller.select('minimal')
    state.controller.stage('standard', true)
    state.roster([...BASES, derived('new-snapshot')])
    reply.resolve(refused
      ? { ok: false, error: new RemoteError('gateway/internal', 'refused', {}) }
      : { ok: true, value: 'new-snapshot' })
    await selection

    expect(state.controller.store.getSnapshot()).toMatchObject({ current: 'standard', introduce: true, busy: false })
  })

  it.each([false, true])('keeps a newer same-ID stage while an older seat refreshes (previous Session left: %s)', async (leaveSession) => {
    const refresh = Promise.withResolvers<{ ok: true; value: AgentPresetRoster }>()
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { presets: BASES } })
      .mockImplementationOnce(() => refresh.promise)
      .mockResolvedValue({ ok: true, value: { presets: BASES } })
    const select = vi.fn((_session: SessionId, preset: string) => Promise.resolve({ ok: true as const, value: preset }))
    const ctx = {
      configForms: { developerTools: { enabled: createSnapshotStore(true) } },
      remote: { agentPresets: { list, select } },
    } as never
    let current: SeatSession | undefined = {
      id: SessionId('first'), blank: true, projectionValues: { agentPreset: 'standard' },
    }
    const staged: AgentPresetStage = { revision: 0, id: undefined, introduce: false }
    const oldSeat = new AgentPresetSeatController(ctx, () => current, staged)
    const nextSeat = new AgentPresetSeatController(ctx, () => undefined, staged)
    await oldSeat.load()
    current = { ...current, projectionValues: { agentPreset: 'unknown' } }
    oldSeat.stage('minimal')
    const applying = oldSeat.apply()
    expect(list).toHaveBeenCalledTimes(2)
    if (leaveSession) current = undefined
    nextSeat.stage('minimal', true)
    const newerRevision = staged.revision
    refresh.resolve({ ok: true, value: { presets: BASES } })
    await applying

    expect(staged).toEqual({ revision: newerRevision, id: 'minimal', introduce: true })
    expect(select).not.toHaveBeenCalled()
    const receivingSeat = new AgentPresetSeatController(ctx, () => ({
      id: SessionId('receiving'), blank: true, projectionValues: { agentPreset: 'standard' },
    }), staged)
    await receivingSeat.load()
    expect(select).toHaveBeenCalledExactlyOnceWith(SessionId('receiving'), 'minimal')
    expect(receivingSeat.store.getSnapshot()).toMatchObject({ current: 'minimal', introduce: true })
  })

  it.each([false, true])('does not publish an old Session result into its replacement (refused: %s)', async (refused) => {
    const state = fixture()
    await state.controller.load()
    const reply = Promise.withResolvers<Outcome>()
    state.select.mockImplementationOnce(() => reply.promise)
    const selection = state.controller.select('minimal')
    state.session({ id: SessionId('replacement'), blank: true, projectionValues: { agentPreset: 'standard' } })
    reply.resolve(refused
      ? { ok: false, error: new RemoteError('gateway/internal', 'old refusal', {}) }
      : { ok: true, value: 'old-snapshot' })
    await selection

    expect(state.controller.store.getSnapshot()).toMatchObject({ current: 'standard', error: null, busy: false })
    expect(state.list).toHaveBeenCalledTimes(1)
  })

  it('does not show a failed old Session roster refresh on its replacement', async () => {
    const state = fixture()
    await state.controller.load()
    const refresh = Promise.withResolvers<{ ok: false; error: RemoteError }>()
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { presets: BASES } })
      .mockImplementationOnce(() => refresh.promise)
    let current: SeatSession = { id: SessionId('first'), blank: true, projectionValues: { agentPreset: 'standard' } }
    const controller = new AgentPresetSeatController({
      configForms: { developerTools: { enabled: createSnapshotStore(true) } },
      remote: { agentPresets: { list, select: state.select } },
    } as never, () => current)
    await controller.load()
    current = { ...current, projectionValues: { agentPreset: 'old-snapshot' } }
    const updating = controller.apply()
    current = { id: SessionId('replacement'), blank: true, projectionValues: { agentPreset: 'standard' } }
    refresh.resolve({ ok: false, error: new RemoteError('gateway/internal', 'old refresh failure', {}) })
    await updating

    expect(controller.store.getSnapshot()).toMatchObject({ current: 'standard', error: null, busy: false })
  })

  it('returns to the existing selectable base after a refused selection', async () => {
    const state = fixture([...BASES, derived('existing', 'standard')])
    state.actual('existing')
    await state.controller.load()
    state.select.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'not allowed', {}) })

    await expect(state.controller.select('minimal')).resolves.toEqual({ kind: 'refused', reason: 'not allowed' })
    expect(state.controller.store.getSnapshot()).toMatchObject({ current: 'standard',
      error: { preset: { id: 'minimal' }, reason: 'not allowed' } })
  })

  it('does not announce a rejected transport from an earlier Session on its replacement', async () => {
    const state = fixture()
    await state.controller.load()
    const reply = Promise.withResolvers<Outcome>()
    state.select.mockImplementationOnce(() => reply.promise)
    const selecting = state.controller.select('minimal')
    state.session({ id: SessionId('replacement'), blank: true, projectionValues: { agentPreset: 'standard' } })
    reply.reject(new Error('old connection failed'))
    await selecting
    expect(state.controller.store.getSnapshot()).toMatchObject({ current: 'standard', error: null, busy: false })
  })
})
